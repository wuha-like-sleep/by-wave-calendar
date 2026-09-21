import { and, gte, inArray, isNull, lte, or, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { sendMail } from "./mailer.js";
import { env } from "../env.js";
import { expandEvent } from "./rrule_expand.js";
import { pushToUser } from "./push.js";
import { getSettings } from "./site_settings.js";
import { normalizeAlarms, parseTrigger, resolveTriggerAt } from "./reminder_triggers.js";

// Format a Date in the event's stored timezone (falls back to Shanghai
// for legacy events that pre-date the timezone column). The label suffix
// — "(上海时间)" — only renders when the event TZ differs from the
// site's default so the reminder doesn't get cluttered for the common case.
// Reminder notifications go out in whatever language the recipient chose
// (users.locale, falling back to the site default). Dates + relative times use
// Intl so they read naturally per-locale; the few fixed labels come from here.
const REMINDER_STRINGS: Record<string, { starts: string; location: string; open: string; reminder: string }> = {
  "zh-CN": { starts: "开始", location: "地点", open: "打开日历", reminder: "提醒" },
  "zh-TW": { starts: "開始", location: "地點", open: "開啟日曆", reminder: "提醒" },
  "en": { starts: "Starts", location: "Location", open: "Open calendar", reminder: "Reminder" },
  "ja": { starts: "開始", location: "場所", open: "カレンダーを開く", reminder: "リマインダー" },
  "ko": { starts: "시작", location: "위치", open: "캘린더 열기", reminder: "알림" },
  "es": { starts: "Comienza", location: "Lugar", open: "Abrir calendario", reminder: "Recordatorio" },
  "fr": { starts: "Début", location: "Lieu", open: "Ouvrir le calendrier", reminder: "Rappel" },
  "de": { starts: "Beginn", location: "Ort", open: "Kalender öffnen", reminder: "Erinnerung" },
};
function reminderStrings(locale: string) {
  return REMINDER_STRINGS[locale] ?? REMINDER_STRINGS.en!;
}

function fmtTime(locale: string, d: Date, tz?: string | null): string {
  const targetTz = tz || "Asia/Shanghai";
  try {
    const base = new Intl.DateTimeFormat(locale, {
      timeZone: targetTz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
    return tz && tz !== "Asia/Shanghai" ? `${base} (${targetTz})` : base;
  } catch { return d.toISOString(); }
}

// 全天事件的日期只能按 UTC 格式化。全天的 startsAt 存的是「那一天的 UTC 午夜」
// （见 ical.ts parseICalDateValue），拿事件时区去渲染，UTC 以西的时区（比如
// America/New_York）会把 2026-07-14T00:00Z 渲染成 07-13 —— 用户在日历上看到的是
// 14 号，提醒邮件里写的是 13 号，而且不报任何错。
function fmtAllDayDate(locale: string, d: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

// "in 30 minutes" / "30分钟后" / "dans 30 minutes" — Intl picks the phrasing.
function fmtRelative(locale: string, ms: number): string {
  const m = Math.round(ms / 60_000);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "long" });
    if (m < 60) return rtf.format(m, "minute");
    if (m < 1440) return rtf.format(Math.round(m / 60), "hour");
    return rtf.format(Math.round(m / 1440), "day");
  } catch {
    if (m < 60) return `${m} 分钟后`;
    if (m < 1440) return `${Math.round(m / 60)} 小时后`;
    return `${Math.round(m / 1440)} 天后`;
  }
}

const MS_DAY = 24 * 60 * 60 * 1000;

// 取数窗口。两头都要留够，而且两头漏掉的表现都是「不报错、到点不响」。
//
// 往后 30 天：最长的档位是 -P1W（提前 7 天）；全天的 -P6DT15H 是 6 天 15 小时，
// 再叠上最多 ±14 小时的时区偏移，约 7.6 天。30 天是 4 倍余量，够撑到以后加更长的档位。
//
// 往前 2 天：这一头是这次新开的。C3 之后正数触发（事件之后提醒）不再被吃掉符号，
// 而全天的 PT9H 档位本身就是正数 —— 全天事件的 startsAt 是 UTC 午夜，在 UTC-12
// 的时区里「当天 09:00」比 startsAt 晚 21 小时。旧代码只取 startsAt >= now-60s，
// 这类提醒到点时事件已经「开始」了大半天，整条被 SQL 滤掉，永远不会响。
// 2 天覆盖我们自己所有正数档位，并给第三方 .ics 发来的正数触发留一点余量。
const SCAN_LOOKBACK_MS = 2 * MS_DAY;
const SCAN_LOOKAHEAD_MS = 30 * MS_DAY;

// 判定「这一分钟该不该发」的窗口。调度器每 60 秒跑一次，所以窗口取 ±60 秒，
// 保证任何一个触发时刻至少被一次 tick 覆盖到；被两次 tick 覆盖到的那些，
// 由 reminders_sent 的唯一索引挡住。
const DUE_WINDOW_MS = 60_000;

type CandidateEventRow = {
  id: string;
  summary: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  extra: unknown;
  calendarId: string;
  rrule: string | null;
  exdates: unknown;
  allDay: boolean;
};

type CalendarRow = { id: string; ownerId: string; timezone: string | null };

type OwnerRow = {
  id: string;
  email: string;
  displayName: string | null;
  disabledAt: Date | null;
  locale: string | null;
};

/** 幂等键。和 reminders_sent 上的唯一索引一一对应。 */
export type SentKey = { eventId: string; trigger: string; instanceStart: Date };

/**
 * 扫描器用到的全部数据访问。抽出来是为了让「发信失败不许记成已发」这类
 * 判断能在不连库的纯逻辑测试里验（npm test 里没有 Postgres）。
 * 线上走下面的 dbStore，行为不变。
 */
export type ReminderStore = {
  loadEvents(from: Date, to: Date): Promise<CandidateEventRow[]>;
  loadCalendars(ids: string[]): Promise<CalendarRow[]>;
  loadOwners(ids: string[]): Promise<OwnerRow[]>;
  /** 一次问回这批候选里已经发过的。返回的是 sentKeyOf() 串成的集合。 */
  loadSent(keys: SentKey[]): Promise<Set<string>>;
  /** 落幂等行。返回 false = 唯一索引撞了，说明别的副本刚发过，不是错误。 */
  markSent(key: SentKey): Promise<boolean>;
};

function sentKeyOf(k: SentKey): string {
  // \u0000 做分隔符：trigger 是用户/第三方给的原文，用 "|" 之类可见字符拼会被
  // trigger 里的同名字符撞出假相等。
  return `${k.eventId}\u0000${k.trigger}\u0000${k.instanceStart.toISOString()}`;
}

const dbStore: ReminderStore = {
  async loadEvents(from, to) {
    // 非重复事件按 master 的 startsAt 过滤；重复事件不管 master DTSTART 在哪
    // （可能在几个月前），一律取回来交给 expandEvent 做时间过滤，CPU 由它兜底。
    return db
      .select({
        id: schema.events.id, summary: schema.events.summary, startsAt: schema.events.startsAt,
        endsAt: schema.events.endsAt, location: schema.events.location, extra: schema.events.extra,
        calendarId: schema.events.calendarId, rrule: schema.events.rrule,
        exdates: schema.events.exdates, allDay: schema.events.allDay,
      })
      .from(schema.events)
      .where(and(
        or(
          and(isNull(schema.events.rrule), gte(schema.events.startsAt, from), lte(schema.events.startsAt, to)),
          isNotNull(schema.events.rrule),
        ),
        isNull(schema.events.deletedAt),
      ));
  },

  async loadCalendars(ids) {
    if (ids.length === 0) return [];
    return db
      .select({ id: schema.calendars.id, ownerId: schema.calendars.ownerId, timezone: schema.calendars.timezone })
      .from(schema.calendars)
      .where(inArray(schema.calendars.id, ids));
  },

  async loadOwners(ids) {
    if (ids.length === 0) return [];
    return db
      .select({
        id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName,
        disabledAt: schema.users.disabledAt, locale: schema.users.locale,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, ids));
  },

  async loadSent(keys) {
    if (keys.length === 0) return new Set();
    const eventIds = [...new Set(keys.map((k) => k.eventId))];
    const startsByIso = new Map(keys.map((k) => [k.instanceStart.toISOString(), k.instanceStart]));
    // 两个 IN 的交叉积是本轮候选的**超集**（会捞回「事件 A × 事件 B 的某个
    // instance_start」这种本轮并不关心的行）。不要紧：下面只拿完整的三元组去
    // 命中集合，多捞回来的行落不到任何一个键上。换成逐条 OR 才会真的把参数撑爆。
    const rows = await db
      .select({
        eventId: schema.remindersSent.eventId,
        trigger: schema.remindersSent.trigger,
        instanceStart: schema.remindersSent.instanceStart,
      })
      .from(schema.remindersSent)
      .where(and(
        inArray(schema.remindersSent.eventId, eventIds),
        inArray(schema.remindersSent.instanceStart, [...startsByIso.values()]),
      ));
    return new Set(rows.map((r) => sentKeyOf(r)));
  },

  async markSent(key) {
    const inserted = await db
      .insert(schema.remindersSent)
      .values({ eventId: key.eventId, trigger: key.trigger, instanceStart: key.instanceStart })
      .onConflictDoNothing()
      .returning({ eventId: schema.remindersSent.eventId });
    return inserted.length > 0;
  },
};

type Candidate = {
  event: CandidateEventRow;
  instanceStart: Date;
  trigger: string;
  /** 这条提醒该响的绝对时刻 */
  at: Date;
  /** 事件所在时区（extra.timezone → 日历 timezone），定时事件可能为 null */
  tz: string | null;
};

export type DispatchResult = {
  scanned: number;
  sent: number;
  /** 算不出触发时刻、被跳过的条数（每条都有一行 warn） */
  skipped: number;
  /** 发信失败、**没有**落幂等行、下一分钟还会重试的条数 */
  failed: number;
};

/**
 * 每分钟扫一遍到点的提醒并发出去。
 *
 * 幂等靠 reminders_sent 上 (event_id, trigger, instance_start) 的唯一索引，
 * 所以重复事件的每一个 occurrence 各自独立提醒。
 *
 * 这一版改了三件影响正确性的事：
 * 1) 触发时刻一律问 reminder_triggers，本地那个只认 D/H/M、还把 0 和正数判成非法的
 *    parseTriggerMs 已删。
 * 2) 发信失败不再记成已发（见下面 markSent 那段）。
 * 3) 查重从「一个 occurrence × 一个 alarm 一次 SELECT」改成整轮一次。
 */
export async function dispatchDueReminders(
  logger: { warn: (m: unknown) => void },
  store: ReminderStore = dbStore,
): Promise<DispatchResult> {
  const now = Date.now();
  const windowFrom = new Date(now - SCAN_LOOKBACK_MS);
  const windowTo = new Date(now + SCAN_LOOKAHEAD_MS);

  const upcoming = await store.loadEvents(windowFrom, windowTo);
  const result: DispatchResult = { scanned: upcoming.length, sent: 0, skipped: 0, failed: 0 };
  if (upcoming.length === 0) return result;

  // 日历要在算触发时刻**之前**拿到：全天事件的时区链是 extra.timezone → 日历 timezone，
  // 拿不到时区就不能排这条提醒（C4）。
  const calendars = new Map(
    (await store.loadCalendars([...new Set(upcoming.map((e) => e.calendarId))])).map((c) => [c.id, c]),
  );

  // 第一趟：把本轮所有到点的候选收集起来，一条都还不发。
  const candidates: Candidate[] = [];
  const seenCandidate = new Set<string>();
  for (const ev of upcoming) {
    const extra = (ev.extra ?? null) as { alarms?: unknown; timezone?: unknown } | null;
    const rawAlarms = Array.isArray(extra?.alarms) ? extra.alarms : [];
    if (rawAlarms.length === 0) continue;

    // 解析不了的单独记一条：它在 DB 里躺着、API 当初返回的是 200，不打出来就只能
    // 靠用户来问「为什么没响」。去重和截断掉的那些是我们主动做的，不算异常，不记。
    for (const item of rawAlarms) {
      const raw = (item as { trigger?: unknown } | null)?.trigger;
      if (typeof raw !== "string" || parseTrigger(raw) === null) {
        result.skipped++;
        logger.warn({ msg: "[reminders] skip", eventId: ev.id, trigger: raw, reason: "unparsable_trigger" });
      }
    }
    const alarms = normalizeAlarms(rawAlarms);
    if (alarms.length === 0) continue;

    const calTz = calendars.get(ev.calendarId)?.timezone ?? null;
    const extraTz = typeof extra?.timezone === "string" && extra.timezone.trim() ? extra.timezone.trim() : null;
    const tz = extraTz ?? calTz;

    const occurrences = expandEvent(
      {
        id: ev.id,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        rrule: ev.rrule ?? null,
        exdates: (ev.exdates as string[] | null) ?? null,
      },
      windowFrom,
      windowTo,
    );

    for (const occ of occurrences) {
      for (const alarm of alarms) {
        const at = resolveTriggerAt(
          { startsAt: occ.startsAt, endsAt: occ.endsAt, allDay: ev.allDay, timezone: tz },
          alarm.trigger,
        );
        if (!at) {
          result.skipped++;
          logger.warn({
            msg: "[reminders] skip", eventId: ev.id, trigger: alarm.trigger,
            instance: occ.startsAt.toISOString(),
            reason: unresolvedReason(ev.allDay, tz, occ.endsAt, alarm.trigger),
          });
          continue;
        }
        if (Math.abs(at.getTime() - now) > DUE_WINDOW_MS) continue;
        const key = sentKeyOf({ eventId: ev.id, trigger: alarm.trigger, instanceStart: occ.startsAt });
        if (seenCandidate.has(key)) continue;
        seenCandidate.add(key);
        candidates.push({ event: ev, instanceStart: occ.startsAt, trigger: alarm.trigger, at, tz });
      }
    }
  }
  if (candidates.length === 0) return result;

  // 第二趟：一次问回已发集合 + 一次问回收件人。原来这两件事都在双层 for 里逐条
  // 往返，一个事件挂 8 条提醒就是 8 次 SELECT。
  const sentKeys = await store.loadSent(
    candidates.map((c) => ({ eventId: c.event.id, trigger: c.trigger, instanceStart: c.instanceStart })),
  );
  const pending = candidates.filter(
    (c) => !sentKeys.has(sentKeyOf({ eventId: c.event.id, trigger: c.trigger, instanceStart: c.instanceStart })),
  );
  if (pending.length === 0) return result;

  const ownerIds = new Set<string>();
  for (const c of pending) {
    const ownerId = calendars.get(c.event.calendarId)?.ownerId;
    if (ownerId) ownerIds.add(ownerId);
  }
  const owners = new Map((await store.loadOwners([...ownerIds])).map((o) => [o.id, o]));

  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const siteDefaultLocale = (await getSettings()).defaultLocale || "zh-CN";

  // 第三趟：真发。
  for (const c of pending) {
    const ev = c.event;
    const ownerId = calendars.get(ev.calendarId)?.ownerId;
    const owner = ownerId ? owners.get(ownerId) : undefined;
    if (!owner || owner.disabledAt) continue;  // don't email disabled users

    const loc = owner.locale || siteDefaultLocale;
    const S = reminderStrings(loc);
    // 全天事件不写「还有多久」：它的 startsAt 是 UTC 午夜，不是用户心里的开始时刻，
    // 算出来的「1 小时前」既不对也没意义。全天只报日期。
    const lead = ev.allDay ? null : fmtRelative(loc, c.instanceStart.getTime() - c.at.getTime());
    const when = ev.allDay ? fmtAllDayDate(loc, c.instanceStart) : fmtTime(loc, c.instanceStart, c.tz);
    const headline = lead ?? when;

    // Fire a web-push notification in parallel with the email. If the
    // user has no push subscriptions registered, pushToUser is a no-op.
    // Tag includes the trigger so identical reminders on different
    // events still surface separately, but the same alarm firing twice
    // (shouldn't happen due to remindersSent unique key) collapses.
    // 注意：这一发是 fire-and-forget 的，它的成败**不参与**下面「算不算发出去了」
    // 的判断 —— 用户没订阅 push 是常态，拿它当失败会把邮件也一起判失败。
    void pushToUser(owner.id, {
      title: `⏰ ${ev.summary}`,
      body: `${headline}${lead ? " · " + when : ""}${ev.location ? " · " + ev.location : ""}`,
      url: "/app",
      tag: `event-${ev.id}-${c.trigger}`,
    }).catch(() => undefined);

    const key: SentKey = { eventId: ev.id, trigger: c.trigger, instanceStart: c.instanceStart };
    try {
      const mail = await sendMail({
        to: owner.email,
        subject: `⏰ ${ev.summary} · ${headline}`,
        text: `${ev.summary}\n${headline}\n${S.starts}: ${when}${ev.location ? `\n${S.location}: ${ev.location}` : ""}\n\n${baseUrl}/app`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:520px;margin:auto;padding:24px;background:#f1f5f9;">
          <div style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
            <div style="font-size:13px;color:#6366f1;font-weight:600;letter-spacing:1px;text-transform:uppercase;">${S.reminder}</div>
            <h1 style="margin:8px 0 12px;font-size:22px;color:#0f172a;">${ev.summary.replace(/[<>&]/g, "")}</h1>
            <div style="font-size:14px;color:#475569;line-height:1.8;">
              ⏰ <strong>${headline}</strong><br/>
              📅 ${when}${ev.location ? `<br/>📍 ${ev.location.replace(/[<>&]/g, "")}` : ""}
            </div>
            <p style="margin:16px 0 0;"><a href="${baseUrl}/app" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:13px;">${S.open}</a></p>
          </div>
        </div>`,
      });
      // sendMail 从不抛异常 —— SMTP 没配、认证失败、连接超时，全都是安安静静地
      // 返回 { ok:false, reason }。旧代码不看返回值直接落幂等行并 sent++，于是
      // 一封都没发出去，日志照样打「sent N of M」，而且因为幂等行已经落库，
      // 这条提醒永远不会重试。失败就什么都不写，下一分钟窗口内还会再试一次。
      if (!mail.ok) {
        result.failed++;
        logger.warn({
          msg: "[reminders] send failed", eventId: ev.id, trigger: c.trigger,
          instance: c.instanceStart.toISOString(), reason: mail.reason ?? "unknown",
        });
        continue;
      }
      // 并发/多副本下第二道防线：唯一索引撞了说明别的副本已经发过这一条，
      // 这是预期内的竞态，不是错误，只是不该重复计进 sent。
      if (await store.markSent(key)) result.sent++;
    } catch (err) {
      result.failed++;
      logger.warn({ err, eventId: ev.id, trigger: c.trigger, instance: c.instanceStart.toISOString() });
    }
  }
  return result;
}

/** 给 resolveTriggerAt 返回 null 的三种情形分类，日志里要能一眼看出是哪种。 */
function unresolvedReason(allDay: boolean, tz: string | null, endsAt: Date | null, trigger: string): string {
  const parsed = parseTrigger(trigger);
  if (!parsed) return "unparsable_trigger";
  if (parsed.kind === "relative" && parsed.relatedToEnd && !(endsAt instanceof Date)) return "related_end_without_end";
  if (allDay) return tz ? "invalid_timezone" : "no_timezone";
  return "unresolved";
}

let started = false;
export function startReminderScheduler(log: { info: (m: string) => void; warn: (m: unknown) => void }): void {
  if (started) return;
  started = true;
  // Run every minute. The DB unique-key on reminders_sent gives us correctness
  // even across overlapping runs / multi-replica deployments.
  const tick = async () => {
    try {
      const result = await dispatchDueReminders(log);
      if (result.sent > 0) log.info(`[reminders] sent ${result.sent} of ${result.scanned} upcoming`);
      // 失败和跳过单独报一行。混在上面那行里会得到「sent 0 of 12」这种看着像
      // 「本来就没有要发的」的输出 —— 这正是 SMTP 挂了三天没人发现的那次。
      if (result.failed > 0 || result.skipped > 0) {
        log.warn({ msg: "[reminders] tick had problems", failed: result.failed, skipped: result.skipped });
      }
    } catch (err) {
      log.warn({ err });
    }
  };
  setTimeout(() => { void tick(); }, 45_000);
  setInterval(() => { void tick(); }, 60_000);
  log.info("reminder scheduler started (1-min tick)");
}
