import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { createNotification } from "./notifications.js";
import {
  eventTimeZone, formatWhen, recipientLocale, siteDefaultLocale,
} from "./event_change_notify.js";
import { translate, type LocaleCode } from "./i18n.js";
import { sendMail } from "./mailer.js";
import { proposalResultMail } from "./email_templates.js";

// 事件邀请这条线的站内通知生产者：邀请到达、RSVP 回复、提议新时间、
// 提议被裁决。和 event_change_notify 同一条总原则 —— 通知是业务动作的
// 旁路，失败只记日志，绝不让邀请发不出、回复存不下。
//
// 推送分级沿用站内通知第二轮定下的口径：邀请类一次性事件值得推一份
// （邀请、预约、安全、事件取消同级），高频的事件更新不推。这四类都是
// 「对方在等我表态 / 我在等对方表态」的一次性事实，全部给 push；
// RSVP 反复改口不合并 —— 每次回复都是独立事实，合并会把先回复的人吞掉。
//
// 收件人定位：
//   · 受邀者按邮箱匹配注册账号（邀请的稳定键就是邮箱）；没注册的人
//     只有邮件那一份邀请，不写站内通知。
//   · 组织者 = 事件所属日历的 owner，恒为注册账号。

type EventRow = typeof schema.events.$inferSelect;
type ProposalRow = typeof schema.eventTimeProposals.$inferSelect;
export type RsvpStatus = "accepted" | "declined" | "tentative";

async function findUserByEmail(email: string): Promise<{ id: string; locale: string | null } | null> {
  const [u] = await db
    .select({ id: schema.users.id, locale: schema.users.locale })
    .from(schema.users)
    .where(and(
      eq(sql<string>`lower(${schema.users.email})`, email.toLowerCase()),
      isNull(schema.users.disabledAt),
    ))
    .limit(1);
  return u ?? null;
}

async function findEventOwner(event: EventRow): Promise<{ id: string; email: string; locale: string | null } | null> {
  const [cal] = await db
    .select({ ownerId: schema.calendars.ownerId })
    .from(schema.calendars)
    .where(eq(schema.calendars.id, event.calendarId))
    .limit(1);
  if (!cal) return null;
  const [u] = await db
    .select({ id: schema.users.id, email: schema.users.email, locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, cal.ownerId))
    .limit(1);
  return u ?? null;
}

/** 任意时刻的展示（提议时间不是事件行本身，formatWhen 吃不了，单独一份）。 */
function formatInstant(locale: LocaleCode, d: Date, timeZone: string, allDay: boolean): string {
  const tz = allDay ? "UTC" : timeZone;
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: tz, month: "2-digit", day: "2-digit", weekday: "short",
  }).format(d);
  if (allDay) return `${date} (${tz})`;
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return `${date} ${time} (${tz})`;
}

/**
 * 邀请发出后调：受邀邮箱是注册用户就写一条站内邀请（带推送），点开
 * 直达回应页。组织者邀请自己（CalDAV 自邀场景）不写。
 */
export async function notifyEventInvitation(opts: {
  event: EventRow;
  organizer: { id: string; email: string; displayName: string | null };
  inviteeEmail: string;
  inviteToken: string;
}): Promise<void> {
  try {
    if (opts.inviteeEmail.toLowerCase() === opts.organizer.email.toLowerCase()) return;
    const invitee = await findUserByEmail(opts.inviteeEmail);
    if (!invitee || invitee.id === opts.organizer.id) return;
    const siteDefault = await siteDefaultLocale();
    const locale = recipientLocale(invitee.locale, siteDefault);
    const tz = await eventTimeZone(opts.event);
    await createNotification({
      userId: invitee.id,
      type: "event_invitation",
      title: translate(locale, "notif.eventInvitation.title", { summary: opts.event.summary }),
      body: translate(locale, "notif.eventInvitation.body", {
        organizer: opts.organizer.displayName || opts.organizer.email,
        when: formatWhen(locale, opts.event, tz),
      }),
      url: `/event-invite/${opts.inviteToken}`,
      push: { actionLabel: translate(locale, "notif.push.view") },
    });
  } catch (err) {
    console.warn("[invite-notify] invitation fanout failed:", (err as Error).message);
  }
}

/** 受邀者回复 RSVP 后调：组织者在站内（+推送）看到是谁、回了什么。 */
export async function notifyOrganizerRsvp(opts: {
  event: EventRow;
  inviteeEmail: string;
  status: RsvpStatus;
}): Promise<void> {
  try {
    const owner = await findEventOwner(opts.event);
    if (!owner) return;
    if (owner.email.toLowerCase() === opts.inviteeEmail.toLowerCase()) return;
    const siteDefault = await siteDefaultLocale();
    const locale = recipientLocale(owner.locale, siteDefault);
    const bodyKey = opts.status === "accepted" ? "notif.rsvp.bodyAccepted"
      : opts.status === "declined" ? "notif.rsvp.bodyDeclined"
      : "notif.rsvp.bodyTentative";
    await createNotification({
      userId: owner.id,
      type: "rsvp_response",
      title: translate(locale, "notif.rsvp.title", { summary: opts.event.summary }),
      body: translate(locale, bodyKey, { invitee: opts.inviteeEmail }),
      url: `/app/events/${opts.event.id}/attendees`,
      push: { actionLabel: translate(locale, "notif.push.view") },
    });
  } catch (err) {
    console.warn("[invite-notify] rsvp fanout failed:", (err as Error).message);
  }
}

/** 受邀者提议新时间后调：组织者收到提议，点开直达参与者管理页处理。 */
export async function notifyOrganizerProposal(opts: {
  event: EventRow;
  proposal: ProposalRow;
}): Promise<void> {
  try {
    const owner = await findEventOwner(opts.event);
    if (!owner) return;
    const siteDefault = await siteDefaultLocale();
    const locale = recipientLocale(owner.locale, siteDefault);
    const tz = await eventTimeZone(opts.event);
    await createNotification({
      userId: owner.id,
      type: "time_proposal",
      title: translate(locale, "notif.proposal.title", { summary: opts.event.summary }),
      body: translate(locale, "notif.proposal.body", {
        invitee: opts.proposal.proposerEmail,
        when: formatInstant(locale, opts.proposal.proposedStartsAt, tz, opts.event.allDay),
      }),
      url: `/app/events/${opts.event.id}/attendees`,
      push: { actionLabel: translate(locale, "notif.push.view") },
    });
  } catch (err) {
    console.warn("[invite-notify] proposal fanout failed:", (err as Error).message);
  }
}

/**
 * 组织者裁决提议后调：提议人收到回执。注册用户走站内（+推送）；
 * 纯邮箱提议人没有站内身份，发一封简短回执邮件（带回应页链接，
 * 时间已改的话他们点开就能把新时间加进自己的日历）。
 */
export async function notifyProposerResult(opts: {
  event: EventRow;
  proposal: ProposalRow;
  accepted: boolean;
}): Promise<void> {
  try {
    const siteDefault = await siteDefaultLocale();
    const tz = await eventTimeZone(opts.event);
    const registered = opts.proposal.proposerUserId
      ? await db.select({ id: schema.users.id, locale: schema.users.locale })
          .from(schema.users).where(eq(schema.users.id, opts.proposal.proposerUserId)).limit(1)
          .then((rows) => rows[0] ?? null)
      : await findUserByEmail(opts.proposal.proposerEmail);
    if (registered) {
      const locale = recipientLocale(registered.locale, siteDefault);
      await createNotification({
        userId: registered.id,
        type: "time_proposal_result",
        title: translate(locale, opts.accepted ? "notif.proposalResult.titleAccepted" : "notif.proposalResult.titleDeclined", { summary: opts.event.summary }),
        body: translate(locale, opts.accepted ? "notif.proposalResult.bodyAccepted" : "notif.proposalResult.bodyDeclined", {
          // 裁决完成后读事件行：接受 = 已改成提议时间，拒绝 = 仍是原时间，
          // 两种情况要展示的都是「现在定的时间」，即 event.startsAt。
          when: formatInstant(locale, opts.event.startsAt, tz, opts.event.allDay),
        }),
        url: `/event-invite/${opts.proposal.inviteToken}`,
        push: { actionLabel: translate(locale, "notif.push.view") },
      });
      return;
    }
    const owner = await findEventOwner(opts.event);
    await sendMail(proposalResultMail(opts.proposal.proposerEmail, {
      organizerName: owner?.email ?? "",
      summary: opts.event.summary,
      accepted: opts.accepted,
      startsAt: opts.event.startsAt,
      endsAt: opts.event.endsAt,
      allDay: opts.event.allDay,
      timezone: tz === "UTC" ? null : tz,
      inviteToken: opts.proposal.inviteToken,
    }));
  } catch (err) {
    console.warn("[invite-notify] proposal result fanout failed:", (err as Error).message);
  }
}
