import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUserOrSend } from "../lib/session.js";
import { fetchEventMastersInWindow } from "../lib/events_query.js";
import { newEventUid, newInvitationToken } from "../lib/ids.js";
import { invitationIcs } from "../lib/ical.js";
import { sendMail } from "../lib/mailer.js";
import { eventInviteMail } from "../lib/email_templates.js";
import { requestCalendarSync } from "../lib/calendar_sync/queue.js";
import { cancelEvent, markEventBookingsCancelled, notifyEventCancellation } from "../lib/event_cancel.js";
import { notifyEventUpdated } from "../lib/event_change_notify.js";
import { notifyEventInvitation, notifyOrganizerRsvp } from "../lib/invite_notify.js";
import { createTimeProposal, decideTimeProposal, listProposalsForEvent } from "../lib/time_proposals.js";
import { expandEvent, seriesStartsBetween } from "../lib/rrule_expand.js";
import { planSeriesEdit, type SeriesEditPlan } from "../lib/series_edit.js";
import { activeSeriesOccurrence, planFutureSeries, truncateSeriesBefore, unchangedEventForWrite } from "../lib/scoped_series_edit.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "../lib/event_zone.js";
import { remapSeriesForZoneChange } from "../lib/exdate_remap.js";
import { etagMatches, eventsWindowEtag } from "../lib/calendar_ctag.js";
import { dispatchWebhook, eventToWebhookPayload } from "../lib/webhooks.js";
import { pushEventChanged } from "../lib/apns.js";
import { ok, okList, err } from "../lib/api_response.js";
import { parseNaturalLanguageEvent } from "../lib/nl_parse.js";
import { MAX_ALARMS_PER_EVENT, normalizeAlarms, parseTrigger } from "../lib/reminder_triggers.js";
import { attendeeEmails, normalizeExtraForClients } from "../lib/attendees.js";

const isoDate = z.string().datetime({ offset: true });

/**
 * 存量兼容：VALARM 的 ACTION / DESCRIPTION 一律「收下再裁剪」，不判错。
 *
 * 这两个值全是第三方客户端写进来的：CalDAV PUT 和 .ics 导入都不设长度上限，
 * 而老的 ical.ts parseEvent 取不到属性时写的是 **null**（不是省略）。网页打开事件时
 * 会把库里的 extra.alarms 原样回传，于是 `z.string().optional()` 这种「不收 null」的写法
 * 会让**存量行一保存就 400**：
 *
 *     400  alarms.1.action: Expected string, received null | alarms.1.description: Expected string, received null
 *
 * 用户只是改了个标题，报错却指着一条他从没设过的提醒。新导入的行看不见这个问题
 * （现在都过 normalizeAlarms 洗过了），所以测试里也照不出来。
 *
 * 裁剪是防滥用的安全上限，不是内容规则 —— zod strip 之后 normalizeAlarms 会再过一遍，
 * 这两个字段最终要么是非空字符串、要么整个不存在。
 */
const laxAlarmText = (max: number) =>
  z.string().nullable().optional()
    .transform((v) => (typeof v === "string" && v.length > max ? v.slice(0, max) : v));

// （导出是给 test/events_extra_merge.test.ts 钉契约用的：trigger 校验和去重截断是
//  这一层做的，从路由里打进去要拖一个 DB 上来，纯逻辑套件里付不起这个代价。）
// extra 的每个键都允许显式 null。C1 把 extra 从整块替换改成浅合并之后，
// 「显式传 null」是**唯一**的删除手段：不传 = 保留，传 null = 删掉这个键。
export const extraSchema = z.object({
  category: z.string().max(50).nullable().optional(),
  timezone: z.string().max(100).nullable().optional(),
  // 两种写法都收，存进库的永远只有一种（见 lib/attendees.ts 的口径：小写去重的邮箱字符串数组）。
  // 字符串那一路是网页 / 三端发的，邮箱写错要当场告诉用户，所以照旧严格判；
  // 对象那一路是 CalDAV 存量行被网页原样回传，宽进 —— 它不是用户这次输入的东西，
  // 为它判 400 只会让用户连标题都改不了。
  attendees: z.array(z.union([
    z.string().email().max(254),
    z.object({ email: z.unknown() }).passthrough(),
  ])).max(50).transform(attendeeEmails).nullable().optional(),
  // v1.3.3 — `url` field for meeting/doc link (separate from `description`).
  // The web event-editor form has had this input forever, and the web JS
  // even includes it in the POST body, but Zod's default `strip` was
  // silently dropping it on the server because the schema didn't list
  // it. Result: link saved → forgotten → user thinks the field is broken.
  url: z.string().url().max(2000).nullable().optional(),
  // Optional meeting join passcode (some conferencing links need one). Kept
  // next to `url`; the invite email surfaces it under the join button so
  // attendees can copy it. Plain string — not validated as a URL.
  meetingPassword: z.string().max(100).nullable().optional(),
  // 提醒。trigger 以前是「max(50) 的任意字符串」——写 "banana" 一路 200 存进库，
  // 到点永远不响，没有任何一端报错。现在唯一事实源是 reminder_triggers：
  // 解析不了就整个请求 400。这条路由的客户端全是我们自己的（网页 + 三端），
  // 宁可早点炸在请求上，也别让一条永远不会响的提醒安静地躺在库里。
  // 第三方来源（CalDAV PUT / .ics 导入）是另一套口径：坏的丢那一条、其余保留。
  alarms: z.array(z.object({
    // 空串是「不提醒」那一档的哨兵值，不是触发器，必须先放行 —— 否则用户选
    // 「不提醒」会吃一个 400。normalizeAlarms 随后会把它从数组里丢掉。
    // 上限放到 200：TRIGGER 的参数区是被 ical.ts 原样拼进来的
    // （"RELATED=END;VALUE=DURATION:-PT15M" 这种），50 是照裸 duration 估的数，
    // 存量行回传时会撞上限 —— 同样是「存得进去、却再也存不回去」。
    trigger: z.string().max(200).refine(
      (v) => v === "" || parseTrigger(v) !== null,
      { error: (issue) => `无法识别的提醒触发时间 ${JSON.stringify(issue.input)}` },
    ),
    action: laxAlarmText(20),
    description: laxAlarmText(500),
  }))
    // 8 条上限是**去重之后**才成立的，交给 normalizeAlarms 截。zod 这层若直接卡死 8，
    // 「发了 9 条、其中两条是同一时刻」会被判 400，而它去重完只有 8 条、完全合法。
    // 这里只留一个防滥用的粗上限。
    .max(MAX_ALARMS_PER_EVENT * 8)
    // 去重 + 截断放在校验之后：进到合并逻辑的已经是干净的一组。
    .transform(normalizeAlarms)
    .nullable().optional(),
}).nullable().optional();

const createSchema = z.object({
  calendarId: z.string().uuid(),
  summary: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  startsAt: isoDate,
  endsAt: isoDate,
  allDay: z.boolean().optional(),
  rrule: z.string().max(500).optional(),
  extra: extraSchema,
  // Optional client-generated idempotency key. When set, the server
  // stores it as the event's iCalendar uid (UNIQUE per calendar) so a
  // retried create — e.g. the offline outbox replaying a create whose
  // HTTP response was lost after the server already committed — collapses
  // onto the first row instead of inserting a duplicate. This is the fix
  // for "one event became three copies". Clients should generate it once
  // per new event and reuse it across retries.
  clientUid: z.string().min(1).max(255).optional(),
});

// Update accepts calendarId too so apps can move an event between
// calendars the user owns. Ownership is verified at apply time
// (loadOwnedEvent + ownsCalendar check) so a malicious request can't
// drop an event into someone else's calendar.
const updateSchema = createSchema.partial().extend({
  // 例外日期（exdates）的整表替换，只在 PATCH 收，建事件不收（新事件没有
  // 例外可言）。用途是三端编辑器里的「恢复某次已删除的单次」：客户端读到
  // 当前列表、删掉其中一条、把剩下的整表发回来。在这之前 schema 里没有
  // 这个字段，zod strip 把它静默丢掉 —— 客户端接了线、界面也刷新了，
  // 服务端根本没存，恢复永远不生效。
  //
  // 口径：
  //   不传     → 这一列不动（单次/未来范围的编辑自己管 exdates，不走这里）；
  //   传数组   → 整表替换（空数组 = 恢复全部）；逐条收口成 canonical ISO
  //              并去重排序 —— 存量行里的 exdates 都是 toISOString() 形状，
  //              混进别的写法会让展开侧按字符串比对时对不上；
  //   传 null  → 清空（与空数组同义，落库为 null）。
  // 与「同一请求里系列起点/时区也变了」的合成：客户端的列表是按改之前
  // 的时间线读到的，写入路径会先把它喂给既有的 remap 机器（和库里那份
  // 享受同一套平移），平移结果优先于原样落库 —— 见下方 series 写入段。
  exdates: z.array(z.string().datetime({ offset: true }))
    .max(2000)
    .transform((list) => [...new Set(list.map((v) => new Date(v).toISOString()))].sort())
    .nullable()
    .optional(),
});

const idParam = z.object({ id: z.string().uuid() });

/** extra 只认对象。数组、字符串、null 都不算（JSONB 列里什么都塞得下）。 */
function isExtraObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * events.extra 的**浅合并**（C1）。
 *
 * 之前这里是整块替换：`body.extra !== undefined ? body.extra : 旧值`。
 * 而 iOS / 安卓的事件模型里根本没有 alarms 字段 —— 在手机上改一次标题，PATCH 带上的
 * 是一份不含 alarms 的完整 extra，于是网页上设好的提醒、参与者、分类当场被抹掉，
 * 两端都不报错、都返回 200，用户是几天后没收到提醒才发现的。
 *
 * 口径：
 *   patch 是 undefined → 这次请求没提 extra，原样保留库里的
 *   patch 是 null      → 显式清空整块 extra
 *   patch 是对象       → 逐键覆盖；**值为 null 的那个键从结果里删掉**
 *
 * 只合并第一层。attendees 这类数组是**整体替换**，不做逐项并集 —— 逐项合并的话
 * 「删掉一个参与者」和「没提参与者」是同一个请求体，人就永远删不掉了。
 *
 * 合并完是空对象时落 null：让「最后一个键被删掉」和「从来就没有 extra」在库里是同一种
 * 表示，客户端不用同时判 `{}` 和 `null`（三端已经在按 null 判了）。
 */
export function mergeEventExtra(current: unknown, patch: unknown): Record<string, unknown> | null {
  if (patch === null) return null;
  const merged: Record<string, unknown> = isExtraObject(current) ? { ...current } : {};
  // 不是对象的 patch（数组、字符串……）zod 已经挡在外面了，这里兜底成「什么都不改」，
  // 别把库里好好的 extra 换成一个坏形状。
  if (isExtraObject(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;   // JSON 里不会出现，zod 也不会产出，兜一下
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * 写库前的 extra：先浅合并，再把 attendees 收口成规范形状。
 *
 * 为什么合并完还要再洗一遍：mergeEventExtra 是纯合并，这次请求没提 attendees 时它原样
 * 保留库里那份 —— 而库里那份可能是 CalDAV 写的对象数组。任何一次写入都顺手把这一行
 * 收口成邮箱字符串数组，相当于一次就地的惰性迁移，不用等专门的数据迁移跑完。
 */
function mergedExtraForWrite(current: unknown, patch: unknown): Record<string, unknown> | null {
  const merged = mergeEventExtra(current, patch);
  return (normalizeExtraForClients(merged) ?? null) as Record<string, unknown> | null;
}

/**
 * 发给客户端之前把 extra 归一。
 *
 * 存量行里 CalDAV 写的 attendees 是对象数组，而已经发出去的桌面端 / 安卓把它声明成
 * `List<String>`：吐一个对象数组过去不是少显示一个参与者，是**整份事件列表反序列化
 * 失败、日历打不开**。这些包在用户手上，改不了；在这一行被下一次写入收口之前，
 * 读侧得自己兜住。
 */
function forClient<T extends { extra: unknown; rawIcs?: unknown }>(row: T): Omit<T, "rawIcs"> {
  // rawIcs 是手机写上来的 VEVENT 原文，只给 CalDAV 回放用，哪个客户端都不读它。发出去的话，
  // 重复事件每一次都带一份：月视图的响应一半以上是它，而且原文里还有参与者邮箱之类的东西。
  const { rawIcs: _rawIcs, ...rest } = row;
  const extra = normalizeExtraForClients(row.extra);
  return (extra === row.extra ? rest : { ...rest, extra }) as Omit<T, "rawIcs">;
}

/**
 * PATCH 专用的存量豁免：把请求体里那些「库里本来就有、而且按现在的口径解析不出来」的
 * 提醒先摘掉，再进校验。
 *
 * trigger 解析不了就整个请求 400 是故意立的口径（客户端全是我们自己的，宁可早点炸，
 * 也别让一条永远不会响的提醒安静地躺在库里）。但这条口径是后来才立的 —— 在那之前
 * trigger 是「max(50) 的任意字符串」，"banana" 一路 200 存进去过。网页打开事件会把
 * extra.alarms 原样回传，于是这些老行**永远存不下去**，而报错指着的是一条用户从没设过的提醒。
 *
 * 判据是「这一条原文库里也有」：客户端这次新设的垃圾 trigger 照旧 400，口径没松。
 */
function dropLegacyBadAlarms(patchExtra: unknown, storedExtra: unknown): unknown {
  if (!patchExtra || typeof patchExtra !== "object" || Array.isArray(patchExtra)) return patchExtra;
  const alarms = (patchExtra as Record<string, unknown>).alarms;
  if (!Array.isArray(alarms)) return patchExtra;
  const storedAlarms = isExtraObject(storedExtra) ? storedExtra.alarms : null;
  const storedTriggers = new Set(
    (Array.isArray(storedAlarms) ? storedAlarms : [])
      .map((a) => (a && typeof a === "object" ? (a as { trigger?: unknown }).trigger : null))
      .filter((t): t is string => typeof t === "string"),
  );
  if (storedTriggers.size === 0) return patchExtra;
  const kept = alarms.filter((a) => {
    const t = a && typeof a === "object" ? (a as { trigger?: unknown }).trigger : null;
    if (typeof t !== "string" || t === "") return true;   // 形状不对 / 空串哨兵：不归这里管
    if (parseTrigger(t) !== null) return true;            // 解析得出来，照常走校验
    return !storedTriggers.has(t);                        // 库里也有这一条 → 是回传，摘掉
  });
  if (kept.length === alarms.length) return patchExtra;
  return { ...(patchExtra as Record<string, unknown>), alarms: kept };
}

/**
 * 把 ZodError 压成一句话，带上出错的字段路径（比如 `extra.alarms.2.trigger`）。
 * 只取前三条：客户端要的是「哪儿写错了」，不是一份完整的 issue 数组。
 */
function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/** 给事件的参与者发带 .ics 的邀请（METHOD:REQUEST），每人一个回调 token。
 *
 *  抽出来是因为**它原来只长在建事件那条路上**：改事件那条路把新加的人
 *  合并进 extra 就完事了，不建 token 也不发信。于是给一个已经存在的会加人，
 *  名字进了列表、存得下、一个错都不报，而对方永远收不到任何东西 ——
 *  组织者以为已经发过了。桌面端把参与者做在编辑表单里，走的正是那条路。
 *
 *  发信是 fire-and-forget 的：发不出去只记日志，不影响这次请求的结果。
 *  所以**调用点必须自己挑准收件人**，别指望这里的失败能被谁看见。 */
async function inviteAttendees(
  log: FastifyBaseLogger,
  user: { id: string; email: string; displayName?: string | null },
  row: {
    id: string; uid: string; summary: string; description: string | null;
    location: string | null; startsAt: Date; endsAt: Date; allDay: boolean;
    extra: unknown; updatedAt: Date;
  },
  emails: string[],
): Promise<void> {
  if (emails.length === 0) return;
  const organizerName = user.displayName || user.email;
  const extra = (row.extra as { timezone?: string; url?: string; meetingPassword?: string } | null) ?? null;
  const ics = invitationIcs({
    event: {
      uid: row.uid,
      summary: row.summary,
      description: row.description,
      location: row.location,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      allDay: row.allDay,
      updatedAt: row.updatedAt,
    },
    organizerEmail: user.email,
    organizerName,
    attendees: emails.map((email) => ({ email })),
    method: "REQUEST",
  });
  const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  // 站内邀请通知要完整的事件行（算展示时区要日历时区兜底）；拿不到就只
  // 跳过站内这一份，邮件照发。
  const [fullEvent] = await db.select().from(schema.events).where(eq(schema.events.id, row.id)).limit(1);
  for (const to of emails) {
    // 每人一个 token，好让邮件里那个「添加到我的日历」一键跳回来。
    const inviteToken = newInvitationToken();
    let tokenStored = false;
    try {
      await db.insert(schema.eventInviteTokens).values({
        token: inviteToken,
        sourceEventId: row.id,
        recipientEmail: to,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });
      tokenStored = true;
    } catch (err) {
      log.warn({ err, to }, "event_invite_token_failed");
    }
    if (tokenStored && fullEvent) {
      void notifyEventInvitation({
        event: fullEvent,
        organizer: { id: user.id, email: user.email, displayName: user.displayName ?? null },
        inviteeEmail: to,
        inviteToken,
      }).catch(() => undefined);
    }
    sendMail(eventInviteMail(to, {
      organizerEmail: user.email,
      organizerName,
      summary: row.summary,
      description: row.description,
      location: row.location,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      allDay: row.allDay,
      uid: row.uid,
      // 带上事件自己的时区，邮件里才写「上海下午 6 点」而不是服务器的 UTC。
      timezone: extra?.timezone ?? null,
      meetingUrl: extra?.url ?? null,
      meetingPassword: extra?.meetingPassword ?? null,
      icsBody: ics,
      inviteToken,
    })).catch((err) => log.warn({ err, to }, "event_invite_mail_failed"));
  }
}


export async function eventRoutes(app: FastifyInstance) {
  // Fetch events across all (or a subset of) user's calendars in a date range.
  // Used by the calendar app view to populate the grid.
  app.get("/events", { config: { oauthScope: "read:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const q = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        calendarIds: z.string().optional(),
      })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "bad_query" });

    const fromDate = new Date(q.data.from);
    const toDate = new Date(q.data.to);

    // Owned + shared calendars are independent lookups — fetch them in
    // parallel so the request waits one DB round-trip, not two.
    const [owned, shared] = await Promise.all([
      db
        .select({
          id: schema.calendars.id,
          name: schema.calendars.name,
          color: schema.calendars.color,
          timezone: schema.calendars.timezone,
        })
        .from(schema.calendars)
        .where(eq(schema.calendars.ownerId, user.id)),
      db
        .select({
          id: schema.calendars.id,
          name: schema.calendars.name,
          color: schema.calendars.color,
          timezone: schema.calendars.timezone,
        })
        .from(schema.calendars)
        .innerJoin(schema.calendarMembers, eq(schema.calendarMembers.calendarId, schema.calendars.id))
        .where(eq(schema.calendarMembers.userId, user.id)),
    ]);

    const ownedIds = new Set(owned.map((c) => c.id));
    const visibleIds = new Set([...ownedIds, ...shared.map((c) => c.id)]);
    const visible = [...owned, ...shared.filter((c) => !ownedIds.has(c.id))];
    let allowed = Array.from(visibleIds);
    if (q.data.calendarIds) {
      const requested = q.data.calendarIds.split(",").filter(Boolean);
      allowed = requested.filter((id) => visibleIds.has(id));
    }
    if (allowed.length === 0) return reply.send({ calendars: visible, events: [] });

    // 网页每 30 秒轮询当前窗口，绝大多数时候没变。先比令牌，没变就回 304，不取行、不展开规则。
    // private, no-cache：浏览器可以存，但每次用前必须拿 ETag 回来核对（核对便宜，没变就是
    // 一个 304 空响应）；private 挡住共享缓存（CDN / 代理）—— 日程是个人数据，绝不能让
    // 中间缓存把一个人的响应发给另一个人。令牌本身由「这个人能看的日历集合」算出来，
    // 换个人拿着旧令牌来核对也只会算出不同的令牌、拿到自己的 200，不会串数据。
    // 原生客户端不受影响：它们本来就自己存令牌、自己发 If-None-Match。
    const tag = await eventsWindowEtag(allowed, visible, q.data.from, q.data.to);
    reply.header("ETag", tag).header("Cache-Control", "private, no-cache");
    if (etagMatches(req.headers["if-none-match"], tag)) return reply.code(304).send();

    // Pull the master rows that can contribute an occurrence to the window.
    // See fetchEventMastersInWindow for the (subtle) recurring-vs-non-recurring
    // predicate; expandEvent() below trims/materializes each row.
    const rows = await fetchEventMastersInWindow(allowed, fromDate, toDate);
    // 重复事件按事件自己的时区展开（没有就用日历的），见 event_zone.ts。
    // 日历时区就在上面那两个查询里，不用再查一次库。
    const calTz = new Map(visible.map((c) => [c.id, c.timezone]));

    // Expand RRULE master rows into per-occurrence entries. Non-recurring
    // events come through unchanged. Each occurrence carries the same id
    // as its master so the client can route edits/deletes consistently.
    const expanded: Array<Omit<typeof rows[number], "rawIcs"> & { startsAt: Date; endsAt: Date; isOccurrence: boolean }> = [];
    for (const row of rows) {
      const occurrences = expandEvent(
        {
          id: row.id,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          rrule: row.rrule ?? null,
          exdates: (row.exdates as string[] | null) ?? null,
          allDay: row.allDay,
          updatedAt: row.updatedAt,
          timeZone: expansionTimeZone({
            allDay: row.allDay,
            extra: row.extra,
            calendarTimezone: calTz.get(row.calendarId),
            rawStartIsUtc: rawIcsStartIsUtc(row.rawIcs),
          }),
        },
        fromDate,
        toDate,
      );
      if (occurrences.length === 0) continue;
      const shared = forClient(row);
      for (const occ of occurrences) {
        expanded.push({ ...shared, startsAt: occ.startsAt, endsAt: occ.endsAt, isOccurrence: occ.isOccurrence });
      }
    }

    return reply.send({ calendars: visible, events: expanded });
  });

  app.get("/calendars/:id/events", { config: { oauthScope: "read:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    if (!(await ownsCalendar(id, user.id))) {
      return reply.code(404).send({ error: "not_found" });
    }
    // Optional ?eventId=<uuid> — return just that one event. The calendar
    // grid's clickEvent uses this to fetch the full (extra-bearing) event
    // when the user opens a detail, instead of pulling the WHOLE calendar's
    // event list (potentially thousands of rows) just to find one by id.
    // Absent → original behavior (all live events), so old clients are
    // unaffected.
    const q = z.object({ eventId: z.string().uuid().optional() }).safeParse(req.query);
    const conds = [eq(schema.events.calendarId, id), isNull(schema.events.deletedAt)];
    if (q.success && q.data.eventId) conds.push(eq(schema.events.id, q.data.eventId));
    const rows = await db
      .select()
      .from(schema.events)
      .where(and(...conds))
      .orderBy(asc(schema.events.startsAt));
    return reply.send(rows.map(forClient));
  });

  // Cheap overlap check for the client — POST so we can keep tomorrow's
  // "exclude editing self" form clean without putting an event UUID in the URL.
  app.post("/events/conflicts", { config: { oauthScope: "read:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const body = z.object({
      calendarId: z.string().uuid(),
      startsAt: isoDate,
      endsAt: isoDate,
      excludeId: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.send({ conflicts: [] });
    const starts = new Date(body.data.startsAt);
    const ends = new Date(body.data.endsAt);
    // Find overlapping events across all calendars the user can see.
    const visible = await db
      .select({ id: schema.calendars.id })
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id));
    const ids = visible.map((v) => v.id);
    if (ids.length === 0) return reply.send({ conflicts: [] });
    const rows = await db
      .select({ id: schema.events.id, summary: schema.events.summary, startsAt: schema.events.startsAt, endsAt: schema.events.endsAt })
      .from(schema.events)
      .where(and(
        inArray(schema.events.calendarId, ids),
        lte(schema.events.startsAt, ends),
        gte(schema.events.endsAt, starts),
        isNull(schema.events.deletedAt),
      ))
      .limit(20);
    const conflicts = rows.filter((r) => !body.data.excludeId || r.id !== body.data.excludeId);
    return reply.send({ conflicts });
  });

  // Natural-language quick-add. A client POSTs a phrase (e.g. "明天 下午3点 牙医")
  // plus its own local `now`, and gets back structured fields to prefill the
  // create form. Parsing lives in one shared server module (nl_parse) so web /
  // iOS / Android / desktop all behave identically instead of each reimplementing
  // it. `now` is the caller's local wall-clock so results are timezone-correct
  // regardless of the server's zone; we never touch the DB here.
  app.post("/parse-event", { config: { oauthScope: "read:events" } }, async (req, reply) => {
    // 丢弃返回值会让 TypeScript 沉默，所以这里显式判空（漏掉的话未认证请求会执行下面的副作用）。
    if (!(await requireUserOrSend(req, reply))) return reply;
    const body = z.object({
      text: z.string().min(1).max(500),
      now: z.string().max(40).optional(),
    }).parse(req.body ?? {});
    const parsed = parseNaturalLanguageEvent(body.text, body.now);
    if (!parsed) return reply.code(422).send({ error: "unparseable" });
    return reply.send(parsed);
  });

  app.post("/events", { config: { oauthScope: "write:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    // 校验失败要的是 400。以前是 createSchema.parse()：ZodError 身上没有 statusCode，
    // 一路冒到 setErrorHandler 就变成 500「服务器内部错误」，客户端看不出是自己发错了。
    const parsedBody = createSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: "invalid_body", message: zodMessage(parsedBody.error) });
    }
    const body = parsedBody.data;
    if (!(await ownsCalendar(body.calendarId, user.id))) {
      return reply.code(404).send({ error: "calendar_not_found" });
    }
    if (new Date(body.endsAt) < new Date(body.startsAt)) {
      return reply.code(400).send({ error: "ends_before_starts" });
    }

    // Idempotent create. A client may legitimately send the SAME create
    // more than once — classically when the server commits the INSERT but
    // the HTTP response is dropped on a flaky network, so the client (the
    // offline outbox, or a user re-tapping "save") retries. Without a
    // stable key every retry minted a fresh uid and inserted a duplicate
    // row: the root cause of "one event became three". When the client
    // supplies `clientUid`, we use it as the event's uid (UNIQUE per
    // calendar) so retries land on the first row.
    const stableUid = body.clientUid?.trim();
    if (stableUid) {
      const [existing] = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.calendarId, body.calendarId), eq(schema.events.uid, stableUid)))
        .limit(1);
      if (existing) {
        // Already created under this key → idempotent success. Crucially
        // we return BEFORE the invite-email / webhook / push side effects
        // so a retry never re-notifies attendees.
        return reply.code(200).send(forClient(existing));
      }
    }

    // Content-level dedup — "完全一样的只记录一次".
    //
    // clientUid above only catches a retry of the SAME create. The user's
    // duplicates came from DIFFERENT sources (multiple devices / an import)
    // each POSTing a byte-identical event with its own (or no) key, so the
    // uid check couldn't see them as the same. Here we treat a create whose
    // every user-visible field exactly matches an existing LIVE event in the
    // same calendar as a duplicate, and return that row instead of inserting
    // another copy. Tradeoff: a user genuinely wanting two identical events
    // at the same time gets one — acceptable per the explicit "identical →
    // record once" request, and astronomically rarer than the dup bug.
    {
      const startsAt = new Date(body.startsAt);
      const endsAt = new Date(body.endsAt);
      const candidates = await db
        .select()
        .from(schema.events)
        .where(and(
          eq(schema.events.calendarId, body.calendarId),
          isNull(schema.events.deletedAt),
          eq(schema.events.summary, body.summary),
          eq(schema.events.startsAt, startsAt),
          eq(schema.events.endsAt, endsAt),
        ));
      const norm = (s: string | null | undefined): string => (s ?? "");
      const matches = candidates.filter((c) =>
        c.allDay === (body.allDay ?? false) &&
        norm(c.rrule) === norm(body.rrule) &&
        norm(c.description) === norm(body.description) &&
        norm(c.location) === norm(body.location),
      );
      // Return the OLDEST match (candidates come back in no particular order;
      // pick the earliest createdAt so repeat calls converge on one row).
      if (matches.length > 0) {
        const oldest = matches.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
        return reply.code(200).send(forClient(oldest));
      }
    }

    let row: typeof schema.events.$inferSelect | undefined;
    try {
      [row] = await db
        .insert(schema.events)
        .values({
          calendarId: body.calendarId,
          uid: stableUid || newEventUid(),
          summary: body.summary,
          description: body.description,
          location: body.location,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          allDay: body.allDay ?? false,
          rrule: body.rrule,
          // 走一遍合并（底是空的）：新建时写的 null 值键不落库、空对象落 null，
          // 和 PATCH 之后的形状保持一致，省得读取侧要分「新建的」和「改过的」两种。
          extra: mergedExtraForWrite(null, body.extra) as object | null,
        })
        .returning();
    } catch (e) {
      // A concurrent retry won the race on UNIQUE(calendarId, uid). Return
      // the row it created instead of surfacing a 500 — still idempotent.
      const msg = e instanceof Error ? e.message : "";
      if (stableUid && (msg.includes("duplicate") || msg.includes("unique"))) {
        const [existing] = await db
          .select()
          .from(schema.events)
          .where(and(eq(schema.events.calendarId, body.calendarId), eq(schema.events.uid, stableUid)))
          .limit(1);
        if (existing) return reply.code(200).send(forClient(existing));
      }
      throw e;
    }

    // 建事件时 extra.attendees 里的人，当场发邀请。
    // 收件人走收口模块 attendeeEmails，让「谁是参与者」在整个仓库里只有一处判据。
    const extra = (body.extra as { attendees?: unknown } | null) ?? null;
    if (row) {
      await inviteAttendees(req.log, user, row, attendeeEmails(extra?.attendees));
    }

    // Fire-and-forget webhook dispatch. Failures are logged in the
    // webhook_deliveries table; never blocks the API response.
    if (row) {
      void dispatchWebhook("event.created", eventToWebhookPayload(row)).catch(() => undefined);
      // Silent push to the calendar owner's iOS devices so the APP
      // refreshes within seconds. No-op when APNs isn't configured.
      await requestCalendarSync(row.calendarId).catch(() => undefined);
      void pushEventChanged(user.id, row.id, "event.created").catch(() => undefined);
    }
    return reply.code(201).send(row ? forClient(row) : row);
  });

  /** 按 id 取一个事件的完整内容。
   *
   *  以前没有这条路由，于是「手上只有半个事件」的客户端没有任何办法补齐它。
   *  搜索结果就是这种半个：它按设计不返回 description 和 extra，客户端只能替
   *  缺的字段编一个默认值，而**编出来的值会被当成用户的修改原样存回去** ——
   *  从搜索结果点进去改一下标题，会议链接和入会密码就没了。
   *
   *  返回的形状和列表接口一模一样（forClient 归一 extra），调用方不用分两套解析。
   *  重复事件这里回的是主行，展开成一个个日程是 GET /events 那条路的事。 */
  app.get<{ Params: { id: string } }>("/events/:id", { config: { oauthScope: "read:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "bad_id" });
    // 范围要和列表 / 搜索一致：自己的 + 共享给自己的。只认 owner 的话会出现
    // 「搜得到、点进去 404」——而搜索恰恰是这条路由的主要来路。
    // 读不到一律 404 不回 403：403 等于告诉对方「这个 id 是存在的」。
    const event = await loadReadableEvent(parsed.data.id, user.id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    return reply.send(forClient(event));
  });

  // Validation: scope (this/future/series) + recurrenceId (the original
  // instance start). When scope=this or scope=future we MUST have a
  // recurrenceId to know which occurrence the user means.
  const recurringScopeSchema = z.object({
    scope: z.enum(["instance", "future", "series"]).optional(),
    recurrenceId: z.string().datetime({ offset: true }).optional(),
  }).optional();

  app.patch("/events/:id", { config: { oauthScope: "write:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    // PATCH body may carry our recurring-scope fields alongside the
    // event fields. updateSchema is .partial() so unknown keys are
    // tolerated; we just pull scope/recurrenceId out before passing.
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const scopeParsed = recurringScopeSchema.safeParse({
      scope: rawBody.scope, recurrenceId: rawBody.recurrenceId,
    });
    const scope = scopeParsed.success ? scopeParsed.data?.scope ?? "series" : "series";
    const recurrenceIso = scopeParsed.success ? scopeParsed.data?.recurrenceId : undefined;

    // 先把库里那一行读出来再校验请求体：存量豁免（dropLegacyBadAlarms）要拿它当判据。
    // 顺带把 404 排到 400 前面 —— 不是自己的事件，连「你请求体哪里写错了」都不该回。
    const target = await loadOwnedEvent(id, user.id);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (!scopeParsed.success) return reply.code(400).send({ error: "invalid_recurrence_scope", message: "请选择有效的重复事件修改范围。" });
    if (scope !== "series" && !recurrenceIso) return reply.code(400).send({ error: "recurrence_id_required", message: "请刷新日历并重新选择要修改的那次日程。" });

    const parsedBody = updateSchema.safeParse({
      ...rawBody,
      extra: dropLegacyBadAlarms(rawBody.extra, target.extra),
      scope: undefined,
      recurrenceId: undefined,
    });
    // 同 POST：校验失败是 400，不是 500。trigger 写成 "banana" 就停在这里。
    if (!parsedBody.success) {
      return reply.code(400).send({ error: "invalid_body", message: zodMessage(parsedBody.error) });
    }
    const body = parsedBody.data;

    if (scope === "instance" || scope === "future") {
      const recurrenceDate = new Date(recurrenceIso!);
      const result = await db.transaction(async (tx): Promise<
        { error: string; status: number } | { event: typeof schema.events.$inferSelect; sourceCalendarId: string }
      > => {
        // Lock and re-read the current master. Concurrent scoped edits and
        // deletes must accumulate exclusions instead of overwriting them.
        const [locked] = await tx.select({ event: schema.events, timezone: schema.calendars.timezone })
          .from(schema.events).innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
          .where(and(eq(schema.events.id, id), eq(schema.calendars.ownerId, user.id), isNull(schema.events.deletedAt)))
          .for("update");
        if (!locked) return { error: "not_found", status: 404 } as const;
        const current = locked.event;
        const zone = expansionTimeZone({ allDay: current.allDay, extra: current.extra,
          calendarTimezone: locked.timezone, rawStartIsUtc: rawIcsStartIsUtc(current.rawIcs) });
        if (!current.rrule || !activeSeriesOccurrence(current, zone, recurrenceDate)) {
          return { error: "occurrence_changed", status: 409 } as const;
        }
        const freshBody = updateSchema.safeParse({ ...rawBody, extra: dropLegacyBadAlarms(rawBody.extra, current.extra) });
        if (!freshBody.success) return { error: "invalid_body", status: 400 } as const;
        const changes = freshBody.data;
        const calendarId = changes.calendarId ?? current.calendarId;
        let calendarTimezone = locked.timezone;
        if (calendarId !== current.calendarId) {
          const [destination] = await tx.select({ timezone: schema.calendars.timezone }).from(schema.calendars)
            .where(and(eq(schema.calendars.id, calendarId), eq(schema.calendars.ownerId, user.id)));
          if (!destination) return { error: "target_calendar_not_owned", status: 403 } as const;
          calendarTimezone = destination.timezone;
        }
        const masterDuration = current.endsAt.getTime() - current.startsAt.getTime();
        const newStart = changes.startsAt ? new Date(changes.startsAt) : recurrenceDate;
        const newEnd = changes.endsAt ? new Date(changes.endsAt) : new Date(newStart.getTime() + masterDuration);
        if (newEnd < newStart) return { error: "ends_before_starts", status: 400 } as const;
        let extra = mergedExtraForWrite(current.extra, changes.extra) as object | null;
        const utcSource = !current.allDay && rawIcsStartIsUtc(current.rawIcs);
        const explicitZoneChange = changes.extra === null || (isExtraObject(changes.extra)
          && Object.hasOwn(changes.extra, "timezone")
          && changes.extra.timezone !== (isExtraObject(current.extra) ? current.extra.timezone : undefined));
        if (utcSource && !explicitZoneChange) extra = { ...extra, timezone: zone };
        const prefixExtra = utcSource ? { ...(isExtraObject(current.extra) ? current.extra : {}), timezone: zone } : undefined;
        const allDay = changes.allDay ?? current.allDay;
        const toZone = expansionTimeZone({ allDay, extra, calendarTimezone });
        const suffix = scope === "future" ? planFutureSeries(current, changes, recurrenceDate, newStart, zone, toZone) : null;
        if (scope === "future" && !suffix) return { error: "unsupported_recurrence_change", status: 409 } as const;
        const first = scope === "future" ? seriesStartsBetween({ ...current, timeZone: zone },
          new Date(Math.floor(current.startsAt.getTime() / 1000) * 1000), recurrenceDate, 1)?.[0] : undefined;
        if (first?.getTime() === recurrenceDate.getTime()) {
          // There is no earlier prefix. Keeping a master with UNTIL before
          // DTSTART can leave a ghost occurrence in CalDAV clients.
          const [updated] = await tx.update(schema.events).set({
            calendarId,
            summary: changes.summary ?? current.summary,
            description: changes.description ?? current.description,
            location: changes.location ?? current.location,
            startsAt: newStart, endsAt: newEnd, allDay,
            rrule: suffix!.rrule, exdates: suffix!.exdates, extra,
            rawIcs: null, updatedAt: new Date(),
          }).where(eq(schema.events.id, id)).returning();
          if (!updated) throw new Error("scoped_event_update_failed");
          return { event: updated, sourceCalendarId: current.calendarId } as const;
        }
        const [created] = await tx.insert(schema.events).values({
          calendarId,
          uid: newEventUid(),
          summary: changes.summary ?? current.summary,
          description: changes.description ?? current.description,
          location: changes.location ?? current.location,
          startsAt: newStart, endsAt: newEnd, allDay,
          rrule: suffix?.rrule ?? null,
          exdates: suffix?.exdates ?? null,
          extra,
        }).returning();
        if (!created) throw new Error("scoped_event_insert_failed");
        if (scope === "instance") {
          const exdates = Array.isArray(current.exdates) ? current.exdates : [];
          await tx.update(schema.events).set({ exdates: [...exdates, recurrenceDate.toISOString()], extra: prefixExtra, rawIcs: null, updatedAt: new Date() })
            .where(eq(schema.events.id, id));
        } else {
          await tx.update(schema.events).set({ rrule: truncateSeriesBefore(current.rrule!, recurrenceDate), extra: prefixExtra, rawIcs: null, updatedAt: new Date() })
            .where(eq(schema.events.id, id));
        }
        return { event: created, sourceCalendarId: current.calendarId } as const;
      });
      if ("error" in result) return reply.code(result.status).send({ error: result.error,
        ...(result.error === "occurrence_changed" ? { message: "这次重复日程已被修改或删除，请刷新日历后重试。" } : {}),
        ...(result.error === "unsupported_recurrence_change" ? { message: "此重复规则无法安全拆分，请选择仅修改此次或整个系列，或先调整重复规则。" } : {}),
      });
      const created = result.event;
      void dispatchWebhook("event.updated", eventToWebhookPayload(created)).catch(() => undefined);
      for (const calendarId of new Set([result.sourceCalendarId, created.calendarId])) {
        await requestCalendarSync(calendarId).catch(() => undefined);
      }
      void pushEventChanged(user.id, created.id, "event.updated").catch(() => undefined);
      return reply.send(forClient(created));
    }

    // --- scope=series (default) OR non-recurring: regular patch ---
    // If the user wants to move the event to a different calendar, confirm
    // they actually own that calendar — otherwise they could drop an event
    // into someone else's calendar via a crafted PATCH.
    if (body.calendarId && body.calendarId !== target.calendarId) {
      if (!(await ownsCalendar(body.calendarId, user.id))) {
        return reply.code(403).send({ error: "target_calendar_not_owned" });
      }
    }
    // 没带 extra 就整列不动（undefined = 不写这一列）。带了才读改写 —— 合并需要
    // 库里那份作底，多一次无谓的覆盖就多一个和并发请求互相盖掉的窗口。
    const nextExtra = body.extra !== undefined
      ? (mergedExtraForWrite(target.extra, body.extra) as object | null)
      : undefined;
    const seriesBase = z.string().datetime({ offset: true }).safeParse(rawBody.seriesBase);
    const plan = await seriesEditPlan(target, body, recurrenceIso, seriesBase.success ? seriesBase.data : undefined);
    const nextStartsAt = plan?.startsAt ?? (body.startsAt ? new Date(body.startsAt) : undefined);
    const nextEndsAt = plan?.endsAt ?? (body.endsAt ? new Date(body.endsAt) : undefined);
    if ((nextEndsAt ?? target.endsAt) < (nextStartsAt ?? target.startsAt)) return reply.code(400).send({ error: "ends_before_starts" });
    // 客户端显式发来的 exdates（恢复已删除单次）：它读到的是改之前时间线
    // 上的列表，所以 remap 的底稿用它不用库里那份，平移完的结果才是新
    // 时间线上的正确列表。plan 自己算出 exdates 时（按 recurrenceId 的
    // 系列编辑）仍以 plan 为准，客户端这份不掺和。
    const clientExdates = body.exdates;
    const zoneShift = await remapForEventEdit(
      plan?.exdates ? { ...target, exdates: plan.exdates }
        : clientExdates !== undefined ? { ...target, exdates: clientExdates }
        : target,
      {
        calendarId: body.calendarId ?? target.calendarId,
        startsAt: nextStartsAt ?? target.startsAt,
        allDay: body.allDay ?? target.allDay,
        rrule: plan?.rrule ?? body.rrule ?? target.rrule,
        extra: nextExtra !== undefined ? nextExtra : target.extra,
        // plan 算出的规则是「没变 / 跟着平移」；只有客户端真的换了规则才算用户刚设的。
        rruleSentByClient: !plan?.rrule && body.rrule != null && body.rrule !== target.rrule,
      },
    );
    const write = await db.transaction(async (tx): Promise<
      { error: string; status: number } | { row: typeof schema.events.$inferSelect | undefined }
    > => {
      const [locked] = await tx.select({ event: schema.events }).from(schema.events)
        .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
        .where(and(eq(schema.events.id, id), eq(schema.calendars.ownerId, user.id), isNull(schema.events.deletedAt))).for("update");
      if (!locked) return { error: "not_found", status: 404 };
      if (!unchangedEventForWrite(target, locked.event)) return { error: "event_changed", status: 409 };
      if (body.calendarId && body.calendarId !== locked.event.calendarId) {
        const [destination] = await tx.select({ id: schema.calendars.id }).from(schema.calendars)
          .where(and(eq(schema.calendars.id, body.calendarId), eq(schema.calendars.ownerId, user.id)));
        if (!destination) return { error: "target_calendar_not_owned", status: 403 };
      }
      const [row] = await tx
        .update(schema.events)
        .set({
          calendarId: body.calendarId ?? undefined,
          summary: body.summary ?? undefined,
          description: body.description ?? undefined,
          location: body.location ?? undefined,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          allDay: body.allDay ?? undefined,
          rrule: zoneShift.rrule ?? plan?.rrule ?? body.rrule ?? undefined,
          // 优先级：remap 平移后的列表 > plan 的列表 > 客户端原样发来的
          // 列表 > 不动这一列。clientExdates 是 null 时落 null（清空）。
          exdates: zoneShift.exdates ?? plan?.exdates
            ?? (clientExdates !== undefined ? clientExdates : undefined),
          extra: nextExtra,
          // 无条件清掉原始 VEVENT 缓存。这条注释原来写的是「网页不编辑 VALARM」——
          // 而网页恰恰在编辑，现在这个 API 也能直接改 extra.alarms 了。rawIcs 是导入时
          // 那份原文的缓存，编辑之后它的 summary / 时间 / VALARM 和库里全对不上；留着
          // CalDAV 客户端下次 REPORT 会拿到旧的那份。清掉，让它读合成出来的。
          rawIcs: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.events.id, id))
        .returning();
      return { row };
    });
    if ("error" in write) return reply.code(write.status).send({ error: write.error,
      ...(write.error === "event_changed" ? { message: "这条日程已在其他设备上变更，请刷新后重新编辑。" } : {}),
    });
    const row = write.row;
    if (row) {
      // **新加进来的人也要收到邀请。** 原来这里什么都不做：名字合并进 extra 就完事，
      // 不建 token 也不发信。于是给一个已经存在的会加人，界面上看得见他、存得下、
      // 一个错都不报，而对方永远收不到任何东西。
      //
      // 判据是「合并后」减「合并前」——不是请求体里那一份：extra 是浅合并的，
      // 请求体里那份既可能是全量也可能只是增量，拿它当判据会把原有的参与者
      // 重发一遍（每改一次事件所有人的邮箱响一次），或者漏掉真正新加的那个。
      if (body.extra !== undefined) {
        const before = new Set(attendeeEmails((target.extra as { attendees?: unknown } | null)?.attendees));
        const added = attendeeEmails((row.extra as { attendees?: unknown } | null)?.attendees)
          .filter((email) => !before.has(email));
        await inviteAttendees(req.log, user, row, added);
      }
      void dispatchWebhook("event.updated", eventToWebhookPayload(row)).catch(() => undefined);
      for (const calendarId of new Set([target.calendarId, row.calendarId])) {
        await requestCalendarSync(calendarId).catch(() => undefined);
      }
      void pushEventChanged(user.id, row.id, "event.updated").catch(() => undefined);
      // 站内通知：共享成员与已注册参与者要知道这条日程变了（仅有意义的
      // 变更、30 分钟内合并，判据与节流都在 event_change_notify 里）。
      // target 是改前快照、row 是改后行，正好一对。旁路，失败不影响响应。
      void notifyEventUpdated(target, row, user).catch(() => undefined);
    }
    return reply.send(row ? forClient(row) : row);
  });

  app.delete("/events/:id", { config: { oauthScope: "write:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const parsed = idParam.safeParse(req.params);
    // Fully idempotent: a malformed ID (e.g. iOS sometimes hands us its
    // internal token rather than our UUID, or the modal lost state during
    // a sync) just resolves as "already gone" so the user-facing UI doesn't
    // surface 400/404 noise when re-clicking a stale row.
    if (!parsed.success) {
      req.log.info({ raw: (req.params as { id?: string }).id, userId: user.id }, "event_delete_bad_id");
      return reply.code(204).send();
    }
    const target = await loadOwnedEvent(parsed.data.id, user.id);
    if (!target) {
      return reply.code(204).send();
    }
    // Parse scope from the query string (DELETE has no body).
    const q = (req.query ?? {}) as { scope?: string; recurrenceId?: string };
    if (q.scope !== undefined && !["instance", "future", "series"].includes(q.scope)) {
      return reply.code(400).send({ error: "invalid_scope" });
    }
    const scope = q.scope ?? "series";
    const recurrenceIso = q.recurrenceId;
    const isRecurring = !!target.rrule;
    if (scope !== "series" && !isRecurring) return reply.code(409).send({ error: "event_changed" });
    if (isRecurring && scope !== "series" && (!recurrenceIso || !isoDate.safeParse(recurrenceIso).success)) {
      return reply.code(400).send({ error: "invalid_recurrence_id" });
    }

    if (isRecurring && scope !== "series" && recurrenceIso) {
      const recurrenceDate = new Date(recurrenceIso);
      const changed = await db.transaction(async tx => {
        const [current] = await tx.select().from(schema.events).where(and(eq(schema.events.id, target.id), eq(schema.events.calendarId, target.calendarId))).for("update");
        if (!current || current.deletedAt) return false;
        if (!current.rrule) return "changed" as const;
        const [cal] = await tx.select().from(schema.calendars).where(and(eq(schema.calendars.id, current.calendarId), eq(schema.calendars.ownerId, user.id)));
        if (!cal) return false;
        const starts = seriesStartsBetween({ ...current, timeZone: expansionTimeZone({ ...current, calendarTimezone: cal.timezone, rawStartIsUtc: rawIcsStartIsUtc(current.rawIcs) }) }, recurrenceDate, recurrenceDate);
        if (!starts) return "changed" as const;
        // A stale occurrence that was already removed/split is an idempotent
        // no-op. Never let a second request extend a previous UNTIL boundary.
        if (!starts.some(at => at.getTime() === recurrenceDate.getTime())) return false;
        if (scope === "instance") {
          const exdates = Array.isArray(current.exdates) ? current.exdates as string[] : [];
          if (exdates.some(at => Date.parse(at) === recurrenceDate.getTime())) return false;
          await tx.update(schema.events).set({ exdates: [...exdates, recurrenceDate.toISOString()], updatedAt: new Date() }).where(eq(schema.events.id, current.id));
        } else {
          const earlier = seriesStartsBetween({ ...current, timeZone: expansionTimeZone({ ...current, calendarTimezone: cal.timezone, rawStartIsUtc: rawIcsStartIsUtc(current.rawIcs) }) }, current.startsAt, new Date(recurrenceDate.getTime() - 1000), 1);
          if (!earlier) return "changed" as const;
          if (earlier.length === 0) {
            const now = new Date();
            await tx.update(schema.events).set({ deletedAt: now, updatedAt: now }).where(eq(schema.events.id, current.id));
            await markEventBookingsCancelled(tx, current.id, now);
            return { deleted: current };
          }
          const untilUtc = new Date(recurrenceDate.getTime() - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
          // The selected occurrence is confirmed to be inside the existing
          // series, so the earlier UNTIL can replace COUNT without extending it.
          const rule = current.rrule.split(";").filter(p => !/^(UNTIL|COUNT)=/i.test(p.trim())).join(";");
          // Raw CalDAV bodies only overlay EXDATE, not a changed RRULE. Switch
          // to synthesis, retaining the UTC source's effective expansion zone.
          const extra = current.extra && typeof current.extra === "object" && !Array.isArray(current.extra) ? current.extra : {};
          await tx.update(schema.events).set({ rrule: rule + ";UNTIL=" + untilUtc, rawIcs: null,
            ...(rawIcsStartIsUtc(current.rawIcs) && !current.allDay ? { extra: { ...extra, timezone: "UTC" } } : {}),
            updatedAt: new Date() }).where(eq(schema.events.id, current.id));
        }
        return true;
      });
      if (changed === "changed") return reply.code(409).send({ error: "event_changed" });
      if (changed) {
        await requestCalendarSync(target.calendarId).catch(() => undefined);
        if (typeof changed === "object") {
          await notifyEventCancellation(changed.deleted, user);
          void dispatchWebhook("event.deleted", eventToWebhookPayload(changed.deleted)).catch(() => undefined);
        } else void pushEventChanged(user.id, target.id, "event.updated").catch(() => undefined);
      }
      return reply.code(204).send();
    }

    // Default / non-recurring: soft-delete the entire event and fire
    // CANCEL emails to anyone we ever invited. The row stays so
    // /event-invite/:token can render a "已取消" notice.
    await cancelEvent(parsed.data.id, { id: user.id, email: user.email, displayName: user.displayName });
    void dispatchWebhook("event.deleted", eventToWebhookPayload(target)).catch(() => undefined);
    return reply.code(204).send();
  });

  // ---------- Event attendees (JSON endpoints mirroring web flow) ----------
  // The web has its own form-based attendees page under
  // /app/events/:id/attendees; these JSON endpoints expose the same
  // semantics for native APP clients. Mirror: extra.attendees array
  // on the event row + per-recipient tokens in event_invite_tokens.

  app.get<{ Params: { id: string } }>("/events/:id/attendees", { config: { oauthScope: "read:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    const event = await loadOwnedEvent(id, user.id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    // 两种存量形状都要读得出来：CalDAV 存的是 {email,…} 对象数组，网页 / 本接口存的是
    // 邮箱字符串数组。以前这里直接当字符串用，手机同步来的事件在这一页上是空的。
    const attendees = attendeeEmails((event.extra as { attendees?: unknown } | null)?.attendees);
    const tokens = await db
      .select()
      .from(schema.eventInviteTokens)
      .where(eq(schema.eventInviteTokens.sourceEventId, event.id))
      .orderBy(asc(schema.eventInviteTokens.createdAt));
    const proposals = await listProposalsForEvent(event.id);
    return reply.send({
      attendees,
      tokens: tokens.map((t) => ({
        token: t.token,
        recipientEmail: t.recipientEmail,
        createdAt: t.createdAt.toISOString(),
        expiresAt: t.expiresAt.toISOString(),
        acceptedAt: t.acceptedAt?.toISOString() ?? null,
        // RSVP 状态（pending/accepted/declined/tentative）——客户端参与者
        // 页据此逐人显示回复状态，与网页管理页同口径。
        responseStatus: t.responseStatus,
        respondedAt: t.respondedAt?.toISOString() ?? null,
      })),
      proposals: proposals.map((p) => ({
        id: p.id,
        proposerEmail: p.proposerEmail,
        proposedStartsAt: p.proposedStartsAt.toISOString(),
        proposedEndsAt: p.proposedEndsAt.toISOString(),
        note: p.note,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
        decidedAt: p.decidedAt?.toISOString() ?? null,
      })),
    });
  });

  // Organizer decides a time proposal. Accept moves the event to the
  // proposed time (state machine lives in lib/time_proposals.ts).
  for (const decision of ["accept", "decline"] as const) {
    app.post<{ Params: { id: string; pid: string } }>(`/events/:id/proposals/:pid/${decision}`, {
      config: { oauthScope: "write:events" },
    }, async (req, reply) => {
      const user = await requireUserOrSend(req, reply);
      if (!user) return reply;
      const { id } = idParam.parse(req.params);
      const pid = z.string().uuid().safeParse(req.params.pid);
      if (!pid.success) return reply.code(400).send({ error: "bad_proposal_id" });
      const event = await loadOwnedEvent(id, user.id);
      if (!event) return reply.code(404).send({ error: "not_found" });
      const result = await decideTimeProposal({
        proposalId: pid.data,
        organizer: { id: user.id, email: user.email, displayName: user.displayName },
        accept: decision === "accept",
      });
      if (!result.ok) {
        if (result.error === "not_found" || result.error === "event_missing") return reply.code(404).send({ error: "not_found" });
        if (result.error === "not_pending") return reply.code(409).send({ error: "already_decided" });
        if (result.error === "event_cancelled") return reply.code(410).send({ error: "event_cancelled" });
        return reply.code(403).send({ error: "not_owner" });
      }
      if (result.event.id !== event.id) return reply.code(404).send({ error: "not_found" });
      return reply.send({ ok: true, status: result.proposal.status });
    });
  }

  // ---------- Invitee side (token is the credential, like the web page) ----------

  // My invitations: everything addressed to my account email.
  app.get("/invitations", { config: { oauthScope: "read:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const rows = await db
      .select({ tok: schema.eventInviteTokens, event: schema.events })
      .from(schema.eventInviteTokens)
      .innerJoin(schema.events, eq(schema.events.id, schema.eventInviteTokens.sourceEventId))
      .where(eq(sql<string>`lower(${schema.eventInviteTokens.recipientEmail})`, user.email.toLowerCase()))
      .orderBy(desc(schema.eventInviteTokens.createdAt))
      .limit(100);
    const ownerIds = [...new Set(rows.map((r) => r.event.calendarId))];
    const cals = ownerIds.length > 0
      ? await db.select().from(schema.calendars).where(inArray(schema.calendars.id, ownerIds))
      : [];
    const ownerByCal = new Map(cals.map((c) => [c.id, c.ownerId]));
    const owners = [...new Set(cals.map((c) => c.ownerId))];
    const ownerRows = owners.length > 0
      ? await db.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
          .from(schema.users).where(inArray(schema.users.id, owners))
      : [];
    const ownerById = new Map(ownerRows.map((o) => [o.id, o]));
    return reply.send({
      invitations: rows.map(({ tok, event }) => {
        const owner = ownerById.get(ownerByCal.get(event.calendarId) ?? "");
        return {
          token: tok.token,
          responseStatus: tok.responseStatus,
          respondedAt: tok.respondedAt?.toISOString() ?? null,
          expiresAt: tok.expiresAt.toISOString(),
          organizer: owner ? { email: owner.email, name: owner.displayName || owner.email } : null,
          event: {
            id: event.id,
            summary: event.summary,
            description: event.description,
            location: event.location,
            startsAt: event.startsAt.toISOString(),
            endsAt: event.endsAt.toISOString(),
            allDay: event.allDay,
            cancelled: !!event.deletedAt,
          },
        };
      }),
    });
  });

  // RSVP via API — same semantics as POST /event-invite/:token/respond.
  app.post<{ Params: { token: string } }>("/invitations/:token/respond", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const body = z.object({ status: z.enum(["accepted", "declined", "tentative"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_status" });
    const [tok] = await db.select().from(schema.eventInviteTokens)
      .where(eq(schema.eventInviteTokens.token, req.params.token)).limit(1);
    if (!tok || tok.expiresAt < new Date()) return reply.code(410).send({ error: "invitation_expired" });
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, tok.sourceEventId)).limit(1);
    if (!event) return reply.code(404).send({ error: "not_found" });
    if (event.deletedAt) return reply.code(410).send({ error: "event_cancelled" });
    await db.update(schema.eventInviteTokens)
      .set({ responseStatus: body.data.status, respondedAt: new Date() })
      .where(eq(schema.eventInviteTokens.token, tok.token));
    await db.update(schema.events).set({ updatedAt: new Date() }).where(eq(schema.events.id, event.id));
    void notifyOrganizerRsvp({ event, inviteeEmail: tok.recipientEmail, status: body.data.status }).catch(() => undefined);
    return reply.send({ ok: true, status: body.data.status });
  });

  // Propose a new time via API — ISO instants, no wall-clock ambiguity.
  app.post<{ Params: { token: string } }>("/invitations/:token/propose", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const body = z.object({
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      note: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_time_range" });
    const result = await createTimeProposal({
      inviteToken: req.params.token,
      startsAt: new Date(body.data.startsAt),
      endsAt: new Date(body.data.endsAt),
      note: body.data.note ?? null,
    });
    if (!result.ok) {
      if (result.error === "token_invalid") return reply.code(404).send({ error: "not_found" });
      if (result.error === "token_expired") return reply.code(410).send({ error: "invitation_expired" });
      if (result.error === "event_cancelled") return reply.code(410).send({ error: "event_cancelled" });
      if (result.error === "bad_range") return reply.code(400).send({ error: "bad_time_range" });
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send({
      ok: true,
      proposal: {
        id: result.proposal.id,
        proposedStartsAt: result.proposal.proposedStartsAt.toISOString(),
        proposedEndsAt: result.proposal.proposedEndsAt.toISOString(),
        status: result.proposal.status,
      },
    });
  });

  // Invite one email. Same flow as the web POST /attendees/invite —
  // adds to extra.attendees, creates a token row, sends .ics email.
  app.post<{ Params: { id: string } }>("/events/:id/attendees", {
    config: { oauthScope: "write:events", rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    const body = z.object({
      email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_email" });
    const event = await loadOwnedEvent(id, user.id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    const extra = (event.extra as Record<string, unknown> | null) ?? {};
    // attendeeEmails 而不是 `Array.isArray(...) ? ... : []`：对象数组上 includes 恒为 false，
    // 手机同步来的事件点一次「邀请」就**重复发一封邀请邮件**，而且发多少次都不提示已邀请。
    const current = attendeeEmails(extra.attendees);
    if (current.includes(body.data.email)) {
      return reply.code(409).send({ error: "already_invited", message: `${body.data.email} 已是参与者` });
    }
    const next = [...current, body.data.email];
    await db.update(schema.events)
      .set({ extra: { ...extra, attendees: next }, updatedAt: new Date() })
      .where(eq(schema.events.id, event.id));

    const inviteToken = newInvitationToken();
    try {
      await db.insert(schema.eventInviteTokens).values({
        token: inviteToken,
        sourceEventId: event.id,
        recipientEmail: body.data.email,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      void notifyEventInvitation({
        event,
        organizer: { id: user.id, email: user.email, displayName: user.displayName },
        inviteeEmail: body.data.email,
        inviteToken,
      }).catch(() => undefined);
      const ics = invitationIcs({
        event: {
          uid: event.uid,
          summary: event.summary,
          description: event.description,
          location: event.location,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          allDay: event.allDay,
          updatedAt: new Date(),
        },
        organizerEmail: user.email,
        organizerName: user.displayName || user.email,
        attendees: [{ email: body.data.email }],
        method: "REQUEST",
      });
      await sendMail(eventInviteMail(body.data.email, {
        organizerEmail: user.email,
        organizerName: user.displayName || user.email,
        summary: event.summary,
        description: event.description,
        location: event.location,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        uid: event.uid,
        timezone: (event.extra as { timezone?: string } | null)?.timezone ?? null,
        meetingUrl: (event.extra as { url?: string } | null)?.url ?? null,
        icsBody: ics,
        inviteToken,
      }));
    } catch (err) {
      req.log.warn({ err, to: body.data.email }, "event_invite_send_failed");
      return reply.code(207).send({
        ok: true,
        warning: "added_but_mail_failed",
        message: `${body.data.email} 已添加为参与者，但邀请邮件发送失败`,
      });
    }
    return reply.send({ ok: true, email: body.data.email });
  });

  // Revoke. iOS sends email in body (avoid URL-encoding @ in path).
  app.delete<{ Params: { id: string } }>("/events/:id/attendees", { config: { oauthScope: "write:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    const body = z.object({
      email: z.string().email().transform((s) => s.toLowerCase().trim()),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_email" });
    const event = await loadOwnedEvent(id, user.id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    const extra = (event.extra as Record<string, unknown> | null) ?? {};
    // 同上：对象数组上 `e !== email` 恒为真，这个人**永远删不掉**（点一次「移除」返回 200，
    // 刷新回来他还在）。规范化之后写回去的也是收口后的形状。
    const current = attendeeEmails(extra.attendees);
    const next = current.filter((e) => e !== body.data.email);
    await db.update(schema.events)
      .set({ extra: { ...extra, attendees: next }, updatedAt: new Date() })
      .where(eq(schema.events.id, event.id));
    await db.delete(schema.eventInviteTokens).where(and(
      eq(schema.eventInviteTokens.sourceEventId, event.id),
      eq(schema.eventInviteTokens.recipientEmail, body.data.email),
      isNull(schema.eventInviteTokens.acceptedAt),
    ));
    return reply.send({ ok: true });
  });

  // Restore a soft-deleted event. Powers the toast 撤销 button — the
  // user just deleted something and immediately wants it back. Idempotent.
  // Only the owner of the calendar can restore. CANCEL emails already
  // sent stay sent — we don't try to "un-cancel" iMIP, that's a no-go.
  // A cancelled booking also stays cancelled: restore only the calendar copy,
  // detached from its old cancel token so that token cannot delete it again.
  app.post("/events/:id/restore", { config: { oauthScope: "write:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select({ event: schema.events }).from(schema.events)
        .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
        .where(and(eq(schema.events.id, id), eq(schema.calendars.ownerId, user.id))).for("update");
      if (!row) return null;
      if (!row.event.deletedAt) return { event: row.event, changed: false };
      await markEventBookingsCancelled(tx, id, row.event.deletedAt);
      await tx.update(schema.bookings).set({ eventId: null }).where(eq(schema.bookings.eventId, id));
      const [restored] = await tx.update(schema.events).set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(schema.events.id, id)).returning();
      return restored ? { event: restored, changed: true } : null;
    });
    if (!result) return reply.code(404).send({ error: "not_found" });
    const restored = result.event;
    if (result.changed) {
      void dispatchWebhook("event.updated", eventToWebhookPayload(restored)).catch(() => undefined);
      await requestCalendarSync(restored.calendarId).catch(() => undefined);
      void pushEventChanged(user.id, restored.id, "event.restored").catch(() => undefined);
    }
    return reply.send(forClient(restored));
  });
}

async function ownsCalendar(calendarId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.calendars.id })
    .from(schema.calendars)
    .where(and(eq(schema.calendars.id, calendarId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** 读权限下的取行：自己的日历 **加上**共享给自己的。
 *
 *  跟 loadOwnedEvent（只认 owner，写操作用）是两个判据，别混用：列表和搜索
 *  都会把共享日历上的事件返回给用户，按 id 单取要是只认 owner，就会出现
 *  「搜得到、点进去 404」。 */
async function loadReadableEvent(eventId: string, userId: string) {
  const rows = await db
    .select({ event: schema.events })
    .from(schema.events)
    .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
    .leftJoin(
      schema.calendarMembers,
      and(
        eq(schema.calendarMembers.calendarId, schema.calendars.id),
        eq(schema.calendarMembers.userId, userId),
      ),
    )
    .where(and(
      eq(schema.events.id, eventId),
      isNull(schema.events.deletedAt),
      or(eq(schema.calendars.ownerId, userId), isNotNull(schema.calendarMembers.userId)),
    ))
    .limit(1);
  return rows[0]?.event ?? null;
}

/** 「所有事件」保存：算出主事件要改成什么样，规则见 series_edit.ts。 */
async function seriesEditPlan(
  target: typeof schema.events.$inferSelect,
  body: { startsAt?: string; endsAt?: string; rrule?: string; allDay?: boolean },
  recurrenceId: string | undefined,
  seriesBase: string | undefined,
): Promise<SeriesEditPlan | null> {
  if (!target.rrule) return null;
  const [cal] = await db.select({ timezone: schema.calendars.timezone })
    .from(schema.calendars).where(eq(schema.calendars.id, target.calendarId)).limit(1);
  return planSeriesEdit({
    master: target,
    zone: expansionTimeZone({
      allDay: target.allDay, extra: target.extra, calendarTimezone: cal?.timezone, rawStartIsUtc: rawIcsStartIsUtc(target.rawIcs),
    }),
    sent: body,
    recurrenceId,
    seriesBase,
  });
}

/**
 * 编辑一个重复事件，展开用的时区跟着变了（换了日历、第一次编辑时客户端填上了设备时区、
 * 手机写的 UTC 原文被这次编辑清掉了）：以前删掉的那几次、「这次及以后」留下的 UNTIL
 * 要对到新的日子上，否则删过的那次会重新冒出来。口径见 exdate_remap.ts。
 * 规则是客户端这次自己发来的，就不替它挪 UNTIL（那是用户刚设的结束时间）。
 */
async function remapForEventEdit(
  target: typeof schema.events.$inferSelect,
  next: { calendarId: string; startsAt: Date; allDay: boolean; rrule: string | null; extra: unknown; rruleSentByClient: boolean },
): Promise<{ exdates?: string[]; rrule?: string }> {
  if (target.allDay || next.allDay || !next.rrule) return {};
  const hasExdates = Array.isArray(target.exdates) && target.exdates.length > 0;
  const hasUntil = !next.rruleSentByClient && /UNTIL=/i.test(next.rrule);
  if (!hasExdates && !hasUntil) return {};
  const ids = [...new Set([target.calendarId, next.calendarId])];
  const cals = await db.select({ id: schema.calendars.id, timezone: schema.calendars.timezone })
    .from(schema.calendars).where(inArray(schema.calendars.id, ids));
  const tzOf = (id: string) => cals.find((c) => c.id === id)?.timezone ?? null;
  const fromZone = expansionTimeZone({
    allDay: false, extra: target.extra, calendarTimezone: tzOf(target.calendarId),
    rawStartIsUtc: rawIcsStartIsUtc(target.rawIcs),
  });
  // 编辑之后原文一律清掉（见下面 rawIcs: null），所以 rawStartIsUtc 恒为 false。
  const toZone = expansionTimeZone({ allDay: false, extra: next.extra, calendarTimezone: tzOf(next.calendarId) });
  const plan = remapSeriesForZoneChange({
    startsAt: next.startsAt, rrule: next.rrule, allDay: false,
    exdates: hasExdates ? target.exdates : null, fromZone, toZone,
  });
  return { exdates: plan.exdates, rrule: next.rruleSentByClient ? undefined : plan.rrule };
}

async function loadOwnedEvent(eventId: string, userId: string) {
  const rows = await db
    .select({ event: schema.events })
    .from(schema.events)
    .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
    .where(and(eq(schema.events.id, eventId), eq(schema.calendars.ownerId, userId), isNull(schema.events.deletedAt)))
    .limit(1);
  return rows[0]?.event ?? null;
}
