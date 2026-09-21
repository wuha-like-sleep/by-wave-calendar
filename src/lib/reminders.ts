import { and, gte, inArray, isNull, lte, or, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { sendMail } from "./mailer.js";
import { env } from "../env.js";
import { expandEvent } from "./rrule_expand.js";
import { pushToUser } from "./push.js";
import { getSettings } from "./site_settings.js";
import { normalizeAlarms, parseTrigger, resolveTriggerAt } from "./reminder_triggers.js";
import { composeCalendarAudience } from "./calendar_access.js";

// Format a Date in the event's stored timezone (falls back to Shanghai
// for legacy events that pre-date the timezone column). The label suffix
// — "(上海时间)" — only renders when the event TZ differs from the
// site's default so the reminder doesn't get cluttered for the common case.
// Reminder notifications go out in whatever language the recipient chose
// (users.locale, falling back to the site default). Dates + relative times use
// Intl so they read naturally per-locale; the few fixed labels come from here.
const REMINDER_STRINGS: Record<string, {
  starts: string; location: string; open: string; reminder: string; shared: string;
}> = {
  "zh-CN": { starts: "开始", location: "地点", open: "打开日历", reminder: "提醒", shared: "共享日历" },
  "zh-TW": { starts: "開始", location: "地點", open: "開啟日曆", reminder: "提醒", shared: "共用日曆" },
  "en": { starts: "Starts", location: "Location", open: "Open calendar", reminder: "Reminder", shared: "Shared calendar" },
  "ja": { starts: "開始", location: "場所", open: "カレンダーを開く", reminder: "リマインダー", shared: "共有カレンダー" },
  "ko": { starts: "시작", location: "위치", open: "캘린더 열기", reminder: "알림", shared: "공유 캘린더" },
  "es": { starts: "Comienza", location: "Lugar", open: "Abrir calendario", reminder: "Recordatorio", shared: "Calendario compartido" },
  "fr": { starts: "Début", location: "Lieu", open: "Ouvrir le calendrier", reminder: "Rappel", shared: "Agenda partagé" },
  "de": { starts: "Beginn", location: "Ort", open: "Kalender öffnen", reminder: "Erinnerung", shared: "Geteilter Kalender" },
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

type CalendarRow = { id: string; ownerId: string; timezone: string | null; name: string };

/** calendar_members 里的一行。角色（只读/可写）故意不取，理由见 recipientsFor()。 */
type MemberRow = { calendarId: string; userId: string };

/** 一个收件人的账号信息。所有者和成员走同一张表、同一套判断。 */
type RecipientRow = {
  id: string;
  email: string;
  displayName: string | null;
  disabledAt: Date | null;
  locale: string | null;
};

/** 幂等键。和 reminders_sent 上的唯一索引 (event_id, trigger, instance_start) 一一对应。 */
export type SentKey = { eventId: string; trigger: string; instanceStart: Date };

// 一条提醒现在要发给 N 个人（所有者 + 成员），而幂等键只有三列，一个事件一行。
// 不加这一维的话：发给 A 成功、发给 B 失败，落不落那一行都是错的 ——
// 落了 B 永远收不到，不落下一轮 A 再收一封，每分钟一封。
//
// 这里**不加列**，把收件人编进 trigger 列：成员的行存 `<原文>#<user id>`，
// 所有者的行仍然存原文。理由三条：
//
// 1) 加列要一条迁移，而这条代码和那条迁移是分开写的；真实的失效形态是
//    「代码上线了、迁移没上」—— 那时 INSERT 报「列不存在」，邮件却已经发出去了，
//    于是每分钟重发一封。不加列就没有这个两段式。
// 2) 所有者的键一个字都不变，所以线上已经躺着的那些行照样挡得住重发，
//    发版当分钟不会有人平白多收一封；0049 那条按 `rs.trigger = 旧档位` 回填的
//    迁移语义也原样成立（它本来就只认所有者那一份）。
// 3) 编码是单射的，不会和任何历史行撞：合法 trigger 要么匹配 duration 语法
//    （`P` 开头），要么匹配 DATE-TIME 语法（全数字 + T + Z），而 user id 是 uuid
//    （只有 0-9a-f 和 -，既没有 `p` 也不含 `T`），所以「原文 + # + uuid」这个形状
//    本身不可能是一条合法 trigger，也就不可能等于任何一条历史行的 trigger。
//
// ⚠️ 代价写在这里：reminders_sent.trigger 从此不再保证是纯粹的 iCalendar 原文。
// 以后再写「按 trigger 等值匹配」的迁移（像 0049 那样），记得成员行是带后缀的，
// 要用 `split_part(trigger, '#', 1)` 或 `trigger LIKE '档位#%'` 一起捞，
// 否则漏掉的那部分不会报错，只会让某些人多收或少收一次。
const MEMBER_KEY_SEP = "#";

/** 这条提醒发给这个收件人时，幂等行的 trigger 列该写什么。 */
export function sentTriggerFor(trigger: string, recipient: { userId: string; isOwner: boolean }): string {
  return recipient.isOwner ? trigger : `${trigger}${MEMBER_KEY_SEP}${recipient.userId}`;
}

/**
 * 扫描器用到的全部数据访问。抽出来是为了让「发信失败不许记成已发」这类
 * 判断能在不连库的纯逻辑测试里验（npm test 里没有 Postgres）。
 * 线上走下面的 dbStore，行为不变。
 */
export type ReminderStore = {
  loadEvents(from: Date, to: Date): Promise<CandidateEventRow[]>;
  loadCalendars(ids: string[]): Promise<CalendarRow[]>;
  /** 这批日历上的全部成员。一次问回，不要一个日历一次。 */
  loadMembers(calendarIds: string[]): Promise<MemberRow[]>;
  loadUsers(ids: string[]): Promise<RecipientRow[]>;
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
      .select({
        id: schema.calendars.id, ownerId: schema.calendars.ownerId,
        timezone: schema.calendars.timezone, name: schema.calendars.name,
      })
      .from(schema.calendars)
      .where(inArray(schema.calendars.id, ids));
  },

  async loadMembers(calendarIds) {
    if (calendarIds.length === 0) return [];
    // 参数个数 = 本分钟有提醒到点的**日历**数，和成员数无关（50 个成员也还是一个参数）。
    return db
      .select({ calendarId: schema.calendarMembers.calendarId, userId: schema.calendarMembers.userId })
      .from(schema.calendarMembers)
      .where(inArray(schema.calendarMembers.calendarId, calendarIds));
  },

  async loadUsers(ids) {
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

/**
 * 「一条到点的提醒 × 一个收件人」。真正要发出去的最小单位，也是幂等的最小单位。
 * 一个 Candidate 会展开成 1 + 成员数 条 Delivery。
 */
type Delivery = {
  candidate: Candidate;
  userId: string;
  isOwner: boolean;
  /** 已经按收件人编码过的幂等键，见 sentTriggerFor()。 */
  key: SentKey;
};

export type DispatchResult = {
  scanned: number;
  sent: number;
  /** 算不出触发时刻、被跳过的条数（每条都有一行 warn） */
  skipped: number;
  /** 发信失败、**没有**落幂等行、下一分钟还会重试的条数 */
  failed: number;
  /** 本轮展开出多少「提醒 × 收件人」。共享日历上一条提醒会算成多条。 */
  deliveries: number;
};

/**
 * 每分钟扫一遍到点的提醒并发出去。
 *
 * 收件人是日历的**所有者 + 全部成员**：订阅了这个日历的人，就该收到这个日历上
 * 事件的提醒。所以一个共享给 50 人的日历，一条提醒就是 50 封信 —— 这是正确行为，
 * 不是失控，别看到量大就去掉。
 *
 * 幂等靠 reminders_sent 上 (event_id, trigger, instance_start) 的唯一索引，
 * 所以重复事件的每一个 occurrence 各自独立提醒；收件人这一维编在 trigger 列里，
 * 见 sentTriggerFor()。
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
  const result: DispatchResult = { scanned: upcoming.length, sent: 0, skipped: 0, failed: 0, deliveries: 0 };
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

  // 第二趟：把每条候选展开到收件人，再一次问回已发集合、一次问回账号。
  //
  // 收件人 = 日历所有者 + calendar_members 里的全部成员（见 calendar_access.ts 的 composeCalendarAudience）。
  // 在这之前这里只反查 calendars.owner_id 一个人，共享日历的成员一条提醒都收不到，
  // 而且界面上没有任何地方说过这件事 —— 被邀请的人只会以为「这破日历不提醒」。
  //
  // 查库次数和成员数无关：成员一次问回（按日历 IN），账号一次问回（按 user id IN）。
  // 整轮仍然是 5 次 SELECT，一个 50 人的日历和一个 1 人的日历一样多。
  const memberIdsByCal = new Map<string, string[]>();
  for (const m of await store.loadMembers([...new Set(candidates.map((c) => c.event.calendarId))])) {
    const list = memberIdsByCal.get(m.calendarId);
    if (list) list.push(m.userId);
    else memberIdsByCal.set(m.calendarId, [m.userId]);
  }

  const deliveries: Delivery[] = [];
  for (const c of candidates) {
    const cal = calendars.get(c.event.calendarId);
    if (!cal) continue;   // 日历查不回来时时区也拿不到，前面早就跳过了；这里只是收口
    for (const r of composeCalendarAudience(cal.ownerId, memberIdsByCal.get(cal.id) ?? [])) {
      deliveries.push({
        candidate: c, userId: r.userId, isOwner: r.isOwner,
        key: { eventId: c.event.id, trigger: sentTriggerFor(c.trigger, r), instanceStart: c.instanceStart },
      });
    }
  }
  result.deliveries = deliveries.length;
  if (deliveries.length === 0) return result;

  const sentKeys = await store.loadSent(deliveries.map((d) => d.key));
  const pending = deliveries.filter((d) => !sentKeys.has(sentKeyOf(d.key)));
  if (pending.length === 0) return result;

  const users = new Map(
    (await store.loadUsers([...new Set(pending.map((d) => d.userId))])).map((u) => [u.id, u]),
  );

  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const siteDefaultLocale = (await getSettings()).defaultLocale || "zh-CN";

  // 第三趟：真发。一个 Delivery 一封信、一行幂等，互相不牵连。
  for (const d of pending) {
    const c = d.candidate;
    const ev = c.event;
    const user = users.get(d.userId);
    // 停用的账号不发。成员和所有者同一条判断 —— 之前只有所有者有，
    // 成员那一维是新加的，漏掉就是给已经停用的账号继续发信。
    if (!user || user.disabledAt) continue;

    // 成员收到的信里写清楚这是哪个共享日历来的。所有者的信一个字不变：
    // 他知道自己的日历，多这一行只是噪音。
    const sharedName = d.isOwner ? null : (calendars.get(ev.calendarId)?.name ?? null);

    const loc = user.locale || siteDefaultLocale;
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
    void pushToUser(d.userId, {
      title: `⏰ ${ev.summary}`,
      body: `${headline}${lead ? " · " + when : ""}${ev.location ? " · " + ev.location : ""}`,
      url: "/app",
      tag: `event-${ev.id}-${c.trigger}`,
    }).catch(() => undefined);

    try {
      const mail = await sendMail({
        to: user.email,
        subject: `⏰ ${ev.summary} · ${headline}`,
        text: `${ev.summary}\n${headline}\n${S.starts}: ${when}${ev.location ? `\n${S.location}: ${ev.location}` : ""}${sharedName ? `\n${S.shared}: ${sharedName}` : ""}\n\n${baseUrl}/app`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:520px;margin:auto;padding:24px;background:#f1f5f9;">
          <div style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
            <div style="font-size:13px;color:#6366f1;font-weight:600;letter-spacing:1px;text-transform:uppercase;">${S.reminder}</div>
            <h1 style="margin:8px 0 12px;font-size:22px;color:#0f172a;">${ev.summary.replace(/[<>&]/g, "")}</h1>
            <div style="font-size:14px;color:#475569;line-height:1.8;">
              ⏰ <strong>${headline}</strong><br/>
              📅 ${when}${ev.location ? `<br/>📍 ${ev.location.replace(/[<>&]/g, "")}` : ""}${sharedName ? `<br/>🗂 ${S.shared}: ${sharedName.replace(/[<>&]/g, "")}` : ""}
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
          instance: c.instanceStart.toISOString(), userId: d.userId, reason: mail.reason ?? "unknown",
        });
        continue;
      }
      // 并发/多副本下第二道防线：唯一索引撞了说明别的副本已经发过这一条，
      // 这是预期内的竞态，不是错误，只是不该重复计进 sent。
      if (await store.markSent(d.key)) result.sent++;
    } catch (err) {
      result.failed++;
      logger.warn({ err, eventId: ev.id, trigger: c.trigger, instance: c.instanceStart.toISOString(), userId: d.userId });
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
/** 上一轮还在飞。**不是**防重复启动（那是 started 干的），是防重入。 */
let tickInFlight = false;

export function startReminderScheduler(log: { info: (m: string) => void; warn: (m: unknown) => void }): void {
  if (started) return;
  started = true;
  // 每分钟一跳。
  //
  // ⚠️ 原来这里的注释写着「reminders_sent 的唯一索引在重叠运行下也保证正确」。
  // 那句话只对**行**成立，对**信**不成立 —— 发信在前、落幂等行在后，
  // 两轮重叠时第二轮 loadSent 读到的是第一轮还没提交的那批，于是照发一遍，
  // 而 markSent 撞索引回 false、sent 不计数，**日志上一片安静**。
  //
  // 加上共享日历成员之后，一条提醒从「1 封信」变成「1 + 成员数 封」，而发信是
  // 串行 await。按一次 SMTP 往返 300ms 算，一轮的预算只有 200 封 ——
  // 一个 50 人的日历同一分钟到点 4 条提醒就会超过 60 秒。而到点窗口是 ±60 秒，
  // 下一轮**必然**仍然认为这批是到点的，不存在「错开了就没事」。
  // 实测：20 个成员、第二跳在第一跳 200ms 时进来 → 21 人里 16 人各收两封。
  const tick = makeReminderTick(log, () => dispatchDueReminders(log));
  setTimeout(() => { void tick(); }, 45_000);
  setInterval(() => { void tick(); }, 60_000);
  log.info("reminder scheduler started (1-min tick)");
}

/**
 * 一跳。抽出来是为了能单独验重入守卫 —— 它埋在 setInterval 里的话，
 * 「两轮重叠会不会把信发两遍」这件事没有任何办法写成断言，
 * 而这正是它已经出过事的地方。
 */
export function makeReminderTick(
  log: { info: (m: string) => void; warn: (m: unknown) => void },
  dispatch: () => Promise<{ scanned: number; sent: number; failed: number; skipped: number }>,
): () => Promise<void> {
  return async () => {
    if (tickInFlight) {
      // 跳过要留痕。悄悄跳过的话，SMTP 变慢导致提醒整体延迟时无从判断。
      log.warn({ msg: "[reminders] 上一轮还没跑完，跳过这一跳（发信比一分钟还慢）" });
      return;
    }
    tickInFlight = true;
    try {
      const result = await dispatch();
      // 不能再写成 "sent N of M"：加上成员之后 sent 数的是信、scanned 数的是事件，
      // 一个 50 人的日历会打出「sent 50 of 1」，看着像出了故障。
      if (result.sent > 0) {
        log.info(`[reminders] sent ${result.sent} notification(s) to recipients of ${result.scanned} upcoming event(s)`);
      }
      // 失败和跳过单独报一行。混在上面那行里会得到「sent 0 of 12」这种看着像
      // 「本来就没有要发的」的输出 —— 这正是 SMTP 挂了三天没人发现的那次。
      if (result.failed > 0 || result.skipped > 0) {
        log.warn({ msg: "[reminders] tick had problems", failed: result.failed, skipped: result.skipped });
      }
    } catch (err) {
      log.warn({ err });
    } finally {
      tickInFlight = false;
    }
  };
}

/** 只给测试用：把在飞标志归位，免得用例之间互相串。 */
export function __resetReminderTickStateForTest(): void {
  tickInFlight = false;
}
