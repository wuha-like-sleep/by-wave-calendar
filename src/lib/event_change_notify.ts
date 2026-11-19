import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { createNotification, createNotificationCoalesced } from "./notifications.js";
import { attendeeEmails } from "./attendees.js";
import { translate, isValidLocale, type LocaleCode } from "./i18n.js";
import { getSettings } from "./site_settings.js";
import { canonicalTimeZone } from "./zoned_time.js";

// 事件被改/被取消时，给「其他相关的人」写站内通知。
//
// 业界口径（Google/Outlook 改有参与者的事件要发更新、取消必发取消通知；
// Apple 共享日历的成员默认在应用内收到增删改通知，且有一个总开关可关）：
//   · 收件人 = 日历的共享成员 + 已注册的事件参与者，永远排除操作者本人；
//   · 只报有意义的变更：时间、标题、地点、全天、换日历、重复规则。
//     只改描述、只改提醒这类低价值抖动不发 —— 站内通知不是审计日志；
//   · 连续修改防轰炸：同一事件 30 分钟内的更新合并成一条（见
//     createNotificationCoalesced），正文永远是最新状态；
//   · 每位收件人有自己的总开关 notify_event_changes（默认开），关了就
//     这一类（更新+取消）都不写。取消比更新重要，但尊重同一个开关 ——
//     Apple 的「共享日历更改」也是一个开关管全部。
//
// 和 notifications.ts 一样是旁路：这里任何一步失败都只记日志，绝不让
// 事件改不动、删不掉。调用方一律 fire-and-forget 或 .catch 兜底。

type Actor = { id: string; email: string; displayName: string | null };
type EventRow = typeof schema.events.$inferSelect;
type Recipient = { id: string; locale: string | null; notifyEventChanges: boolean };

export async function siteDefaultLocale(): Promise<string | null> {
  return (await getSettings().catch(() => null))?.defaultLocale ?? null;
}

export function recipientLocale(userLocale: string | null, siteDefault: string | null): LocaleCode {
  return isValidLocale(userLocale) ? userLocale : isValidLocale(siteDefault) ? siteDefault : "zh-CN";
}

/** 事件的展示时区：事件自带时区优先，其次日历时区；全天事件按 UTC 日期。 */
export async function eventTimeZone(event: EventRow): Promise<string> {
  if (event.allDay) return "UTC";
  const extra = event.extra as { timezone?: unknown } | null;
  const own = canonicalTimeZone(extra?.timezone);
  if (own) return own;
  const [cal] = await db
    .select({ timezone: schema.calendars.timezone })
    .from(schema.calendars)
    .where(eq(schema.calendars.id, event.calendarId))
    .limit(1);
  return canonicalTimeZone(cal?.timezone) ?? "UTC";
}

export function formatWhen(locale: LocaleCode, event: EventRow, timeZone: string): string {
  const tz = event.allDay ? "UTC" : timeZone;
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: tz, month: "2-digit", day: "2-digit", weekday: "short",
  }).format(event.startsAt);
  if (event.allDay) return `${date} (${tz})`;
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(event.startsAt);
  return `${date} ${time} (${tz})`;
}

/**
 * 收件人集合：指定日历的共享成员 + 按邮箱匹配到的已注册参与者。
 * calendarIds/attendeeEmailLists 由调用方按场景拼（更新看改后，取消看删除前）。
 */
async function resolveRecipients(opts: {
  calendarIds: string[];
  attendeeEmails: string[];
  actorId: string;
}): Promise<Recipient[]> {
  const byId = new Map<string, Recipient>();
  const push = (rows: Recipient[]) => {
    for (const r of rows) if (r.id !== opts.actorId) byId.set(r.id, r);
  };

  if (opts.calendarIds.length > 0) {
    const members = await db
      .select({
        id: schema.users.id,
        locale: schema.users.locale,
        notifyEventChanges: schema.users.notifyEventChanges,
      })
      .from(schema.calendarMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.calendarMembers.userId))
      .where(and(
        inArray(schema.calendarMembers.calendarId, opts.calendarIds),
        isNull(schema.users.disabledAt),
      ));
    push(members);
  }

  const emails = [...new Set(opts.attendeeEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length > 0) {
    const users = await db
      .select({
        id: schema.users.id,
        locale: schema.users.locale,
        notifyEventChanges: schema.users.notifyEventChanges,
      })
      .from(schema.users)
      .where(and(
        inArray(sql<string>`lower(${schema.users.email})`, emails),
        isNull(schema.users.disabledAt),
      ));
    push(users);
  }

  return [...byId.values()].filter((r) => r.notifyEventChanges !== false);
}

function attendeesOf(event: EventRow): string[] {
  return attendeeEmails((event.extra as { attendees?: unknown } | null)?.attendees);
}

/** 有意义的变更判据。描述/提醒/参与者名单本身的变化不在内（加人已有邀请
 *  邮件与站内邀请通知单独覆盖；纯描述修改是 Google 都要弹窗问一句「要不要
 *  发」的低价值变更，站内默认不发）。 */
export function hasMeaningfulEventChange(before: EventRow, after: EventRow): { changed: boolean; timeChanged: boolean } {
  const norm = (v: string | null) => (v ?? "").trim();
  const timeChanged =
    before.startsAt.getTime() !== after.startsAt.getTime() ||
    before.endsAt.getTime() !== after.endsAt.getTime() ||
    before.allDay !== after.allDay;
  const changed =
    timeChanged ||
    norm(before.summary) !== norm(after.summary) ||
    norm(before.location) !== norm(after.location) ||
    before.calendarId !== after.calendarId ||
    (before.rrule ?? null) !== (after.rrule ?? null);
  return { changed, timeChanged };
}

/** 事件被修改（系列级 PATCH 成功后调）。连环修改在 30 分钟窗口内合并。 */
export async function notifyEventUpdated(before: EventRow, after: EventRow, actor: Actor): Promise<void> {
  try {
    const { changed, timeChanged } = hasMeaningfulEventChange(before, after);
    if (!changed) return;
    const recipients = await resolveRecipients({
      // 换日历时两边的成员都相关：原日历成员要知道它走了，新日历成员要知道它来了。
      calendarIds: [...new Set([before.calendarId, after.calendarId])],
      attendeeEmails: [...attendeesOf(before), ...attendeesOf(after)],
      actorId: actor.id,
    });
    if (recipients.length === 0) return;
    const siteDefault = await siteDefaultLocale();
    const tz = await eventTimeZone(after);
    const actorName = actor.displayName || actor.email;
    for (const r of recipients) {
      const locale = recipientLocale(r.locale, siteDefault);
      await createNotificationCoalesced({
        userId: r.id,
        type: "event_updated",
        title: translate(locale, "notif.eventUpdated.title", { summary: after.summary }),
        body: timeChanged
          ? translate(locale, "notif.eventUpdated.bodyTime", { actor: actorName, when: formatWhen(locale, after, tz) })
          : translate(locale, "notif.eventUpdated.bodyGeneric", { actor: actorName }),
        url: `/app?event=${after.id}&cal=${after.calendarId}`,
      });
    }
  } catch (err) {
    console.warn("[event-change-notify] updated fanout failed:", (err as Error).message);
  }
}

/** 事件被取消/删除（cancelEvent 的通知阶段调，覆盖 API/网页/CalDAV/预约
 *  取消所有入口）。取消是一次性动作，不合并；值得推一份 Push。 */
export async function notifyEventCancelled(event: EventRow, actor: Actor): Promise<void> {
  try {
    const tokens = await db
      .select({ recipientEmail: schema.eventInviteTokens.recipientEmail })
      .from(schema.eventInviteTokens)
      .where(eq(schema.eventInviteTokens.sourceEventId, event.id));
    const recipients = await resolveRecipients({
      calendarIds: [event.calendarId],
      attendeeEmails: [...attendeesOf(event), ...tokens.map((t) => t.recipientEmail)],
      actorId: actor.id,
    });
    if (recipients.length === 0) return;
    const siteDefault = await siteDefaultLocale();
    const tz = await eventTimeZone(event);
    const actorName = actor.displayName || actor.email;
    for (const r of recipients) {
      const locale = recipientLocale(r.locale, siteDefault);
      await createNotification({
        userId: r.id,
        type: "event_cancelled",
        title: translate(locale, "notif.eventCancelled.title", { summary: event.summary }),
        body: translate(locale, "notif.eventCancelled.body", { actor: actorName, when: formatWhen(locale, event, tz) }),
        // 事件已删，深链接打开会静默落到日历本体（calendar-app 对已删
        // 事件的既定行为），正好让收件人确认它确实不在了。
        url: `/app?event=${event.id}&cal=${event.calendarId}`,
        push: { actionLabel: translate(locale, "notif.push.view") },
      });
    }
  } catch (err) {
    console.warn("[event-change-notify] cancelled fanout failed:", (err as Error).message);
  }
}
