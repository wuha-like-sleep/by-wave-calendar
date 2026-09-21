import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUserOrSend } from "../lib/session.js";
import { fetchEventMastersInWindow } from "../lib/events_query.js";
import { newEventUid, newInvitationToken } from "../lib/ids.js";
import { invitationIcs } from "../lib/ical.js";
import { sendMail } from "../lib/mailer.js";
import { eventInviteMail } from "../lib/email_templates.js";
import { cancelEvent } from "../lib/event_cancel.js";
import { expandEvent } from "../lib/rrule_expand.js";
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
      (v) => ({ message: `无法识别的提醒触发时间 ${JSON.stringify(v)}` }),
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
const updateSchema = createSchema.partial();

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
function forClient<T extends { extra: unknown }>(row: T): T {
  const extra = normalizeExtraForClients(row.extra);
  return extra === row.extra ? row : { ...row, extra };
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


export async function eventRoutes(app: FastifyInstance) {
  // Fetch events across all (or a subset of) user's calendars in a date range.
  // Used by the calendar app view to populate the grid.
  app.get("/events", async (req, reply) => {
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

    // Pull the master rows that can contribute an occurrence to the window.
    // See fetchEventMastersInWindow for the (subtle) recurring-vs-non-recurring
    // predicate; expandEvent() below trims/materializes each row.
    const rows = await fetchEventMastersInWindow(allowed, fromDate, toDate);

    // Expand RRULE master rows into per-occurrence entries. Non-recurring
    // events come through unchanged. Each occurrence carries the same id
    // as its master so the client can route edits/deletes consistently.
    const expanded: Array<typeof rows[number] & { startsAt: Date; endsAt: Date; isOccurrence: boolean }> = [];
    for (const row of rows) {
      const occurrences = expandEvent(
        {
          id: row.id,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          rrule: row.rrule ?? null,
          exdates: (row.exdates as string[] | null) ?? null,
        },
        fromDate,
        toDate,
      );
      for (const occ of occurrences) {
        expanded.push({ ...forClient(row), startsAt: occ.startsAt, endsAt: occ.endsAt, isOccurrence: occ.isOccurrence });
      }
    }

    return reply.send({ calendars: visible, events: expanded });
  });

  app.get("/calendars/:id/events", async (req, reply) => {
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
  app.post("/events/conflicts", async (req, reply) => {
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
  app.post("/parse-event", async (req, reply) => {
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

  app.post("/events", async (req, reply) => {
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

    // Fire-and-forget RSVP emails to attendees listed in extra.attendees.
    // The email carries a METHOD:REQUEST .ics so Gmail / Outlook / Apple Mail
    // render the "Add to calendar" / "Yes / Maybe / No" buttons natively.
    const extra = (body.extra as { attendees?: unknown; timezone?: string } | null) ?? null;
    // 收件人也走收口模块：zod 那层出来的已经是规范形状，这里再过一遍是为了让
    // 「谁是参与者」在整个仓库里只有一处判据（下面原来还各自 trim / includes("@") 了一遍）。
    const inviteTo = attendeeEmails(extra?.attendees);
    if (row && inviteTo.length > 0) {
      const organizerName = user.displayName || user.email;
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
        attendees: inviteTo.map((email) => ({ email })),
        method: "REQUEST",
      });
      const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
      for (const to of inviteTo) {
        // Generate a per-recipient token so the "添加到我的日历" button in the
        // email can jump back to the app and add the event with one click.
        const inviteToken = newInvitationToken();
        try {
          await db.insert(schema.eventInviteTokens).values({
            token: inviteToken,
            sourceEventId: row.id,
            recipientEmail: to,
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          });
        } catch (err) {
          req.log.warn({ err, to }, "event_invite_token_failed");
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
          // Pass the event's stored timezone so the email shows
          // "上海下午6点" rather than the server's UTC equivalent.
          timezone: extra?.timezone ?? null,
          meetingUrl: (row.extra as { url?: string } | null)?.url ?? null,
          meetingPassword: (row.extra as { meetingPassword?: string } | null)?.meetingPassword ?? null,
          icsBody: ics,
          inviteToken,
        })).catch((err) => req.log.warn({ err, to }, "event_invite_mail_failed"));
      }
    }
    // Fire-and-forget webhook dispatch. Failures are logged in the
    // webhook_deliveries table; never blocks the API response.
    if (row) {
      void dispatchWebhook("event.created", eventToWebhookPayload(row)).catch(() => undefined);
      // Silent push to the calendar owner's iOS devices so the APP
      // refreshes within seconds. No-op when APNs isn't configured.
      void pushEventChanged(user.id, row.id, "event.created").catch(() => undefined);
    }
    return reply.code(201).send(row ? forClient(row) : row);
  });

  // Validation: scope (this/future/series) + recurrenceId (the original
  // instance start). When scope=this or scope=future we MUST have a
  // recurrenceId to know which occurrence the user means.
  const recurringScopeSchema = z.object({
    scope: z.enum(["instance", "future", "series"]).optional(),
    recurrenceId: z.string().datetime({ offset: true }).optional(),
  }).optional();

  app.patch("/events/:id", async (req, reply) => {
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

    const isRecurring = !!target.rrule;

    // --- scope=instance: detach this occurrence from the series ---
    // Implementation: add the original instance start to master.exdates
    // (so rrule_expand skips it), then create a NEW standalone (non-
    // recurring) event with the user's edits + the new start/end.
    if (isRecurring && scope === "instance" && recurrenceIso) {
      const recurrenceDate = new Date(recurrenceIso);
      const existingExdates: string[] = Array.isArray(target.exdates) ? target.exdates as string[] : [];
      const newExdates = [...existingExdates, recurrenceDate.toISOString()];

      // The instance the user is editing — if they didn't change start/end,
      // default to the original recurrence time + master's duration.
      const masterDuration = target.endsAt.getTime() - target.startsAt.getTime();
      const newStart = body.startsAt ? new Date(body.startsAt) : recurrenceDate;
      const newEnd = body.endsAt ? new Date(body.endsAt) : new Date(recurrenceDate.getTime() + masterDuration);

      const [detached] = await db.insert(schema.events).values({
        calendarId: target.calendarId,
        uid: newEventUid(),
        summary: body.summary ?? target.summary,
        description: body.description ?? target.description,
        location: body.location ?? target.location,
        startsAt: newStart,
        endsAt: newEnd,
        allDay: body.allDay ?? target.allDay,
        rrule: null,  // detached instance is not recurring
        extra: mergedExtraForWrite(target.extra, body.extra) as object | null,
      }).returning();

      await db.update(schema.events).set({ exdates: newExdates, updatedAt: new Date() }).where(eq(schema.events.id, id));
      if (detached) {
        void dispatchWebhook("event.updated", eventToWebhookPayload(detached)).catch(() => undefined);
        void pushEventChanged(user.id, detached.id, "event.updated").catch(() => undefined);
      }
      return reply.send(detached ? forClient(detached) : detached);
    }

    // --- scope=future: split the series at this occurrence ---
    // Master gets UNTIL=instance-1s appended to its RRULE (so existing
    // earlier occurrences survive). A new standalone master starts at the
    // chosen instance with the user's edits and same/edited RRULE.
    if (isRecurring && scope === "future" && recurrenceIso) {
      const recurrenceDate = new Date(recurrenceIso);
      // RRULE UNTIL: ISO basic format YYYYMMDDTHHMMSSZ
      const untilUtc = new Date(recurrenceDate.getTime() - 1000)
        .toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const oldRrule = target.rrule || "";
      // Strip any existing UNTIL= before adding ours, otherwise PG winds
      // up with conflicting clauses (rrule lib just takes the first).
      const cleanedRrule = oldRrule.split(";").filter((p) => !/^UNTIL=/i.test(p)).join(";");
      const newMasterRrule = cleanedRrule + ";UNTIL=" + untilUtc;
      await db.update(schema.events).set({ rrule: newMasterRrule, updatedAt: new Date() }).where(eq(schema.events.id, id));

      const masterDuration = target.endsAt.getTime() - target.startsAt.getTime();
      const newStart = body.startsAt ? new Date(body.startsAt) : recurrenceDate;
      const newEnd = body.endsAt ? new Date(body.endsAt) : new Date(recurrenceDate.getTime() + masterDuration);

      const [newMaster] = await db.insert(schema.events).values({
        calendarId: target.calendarId,
        uid: newEventUid(),
        summary: body.summary ?? target.summary,
        description: body.description ?? target.description,
        location: body.location ?? target.location,
        startsAt: newStart,
        endsAt: newEnd,
        allDay: body.allDay ?? target.allDay,
        rrule: body.rrule ?? cleanedRrule,
        extra: mergedExtraForWrite(target.extra, body.extra) as object | null,
      }).returning();
      if (newMaster) {
        void dispatchWebhook("event.updated", eventToWebhookPayload(newMaster)).catch(() => undefined);
        void pushEventChanged(user.id, newMaster.id, "event.updated").catch(() => undefined);
      }
      return reply.send(newMaster ? forClient(newMaster) : newMaster);
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
    const [row] = await db
      .update(schema.events)
      .set({
        calendarId: body.calendarId ?? undefined,
        summary: body.summary ?? undefined,
        description: body.description ?? undefined,
        location: body.location ?? undefined,
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
        allDay: body.allDay ?? undefined,
        rrule: body.rrule ?? undefined,
        // 没带 extra 就整列不动（undefined = 不写这一列）。带了才读改写 —— 合并需要
        // 库里那份作底，多一次无谓的覆盖就多一个和并发请求互相盖掉的窗口。
        extra: body.extra !== undefined
          ? (mergedExtraForWrite(target.extra, body.extra) as object | null)
          : undefined,
        // 无条件清掉原始 VEVENT 缓存。这条注释原来写的是「网页不编辑 VALARM」——
        // 而网页恰恰在编辑，现在这个 API 也能直接改 extra.alarms 了。rawIcs 是导入时
        // 那份原文的缓存，编辑之后它的 summary / 时间 / VALARM 和库里全对不上；留着
        // CalDAV 客户端下次 REPORT 会拿到旧的那份。清掉，让它读合成出来的。
        rawIcs: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.events.id, id))
      .returning();
    if (row) {
      void dispatchWebhook("event.updated", eventToWebhookPayload(row)).catch(() => undefined);
      void pushEventChanged(user.id, row.id, "event.updated").catch(() => undefined);
    }
    return reply.send(row ? forClient(row) : row);
  });

  app.delete("/events/:id", async (req, reply) => {
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
    const scope = q.scope === "instance" || q.scope === "future" ? q.scope : "series";
    const recurrenceIso = q.recurrenceId;
    const isRecurring = !!target.rrule;

    if (isRecurring && scope === "instance" && recurrenceIso) {
      // Add to exdates and keep master alive.
      const recurrenceDate = new Date(recurrenceIso);
      const existingExdates: string[] = Array.isArray(target.exdates) ? target.exdates as string[] : [];
      const newExdates = [...existingExdates, recurrenceDate.toISOString()];
      await db.update(schema.events).set({ exdates: newExdates, updatedAt: new Date() }).where(eq(schema.events.id, parsed.data.id));
      return reply.code(204).send();
    }
    if (isRecurring && scope === "future" && recurrenceIso) {
      const recurrenceDate = new Date(recurrenceIso);
      const untilUtc = new Date(recurrenceDate.getTime() - 1000)
        .toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const cleanedRrule = (target.rrule || "").split(";").filter((p) => !/^UNTIL=/i.test(p)).join(";");
      await db.update(schema.events).set({
        rrule: cleanedRrule + ";UNTIL=" + untilUtc, updatedAt: new Date(),
      }).where(eq(schema.events.id, parsed.data.id));
      return reply.code(204).send();
    }

    // Default / non-recurring: soft-delete the entire event and fire
    // CANCEL emails to anyone we ever invited. The row stays so
    // /event-invite/:token can render a "已取消" notice.
    await cancelEvent(parsed.data.id, { id: user.id, email: user.email, displayName: user.displayName });
    void dispatchWebhook("event.deleted", eventToWebhookPayload(target)).catch(() => undefined);
    void pushEventChanged(user.id, target.id, "event.deleted").catch(() => undefined);
    return reply.code(204).send();
  });

  // ---------- Event attendees (JSON endpoints mirroring web flow) ----------
  // The web has its own form-based attendees page under
  // /app/events/:id/attendees; these JSON endpoints expose the same
  // semantics for native APP clients. Mirror: extra.attendees array
  // on the event row + per-recipient tokens in event_invite_tokens.

  app.get<{ Params: { id: string } }>("/events/:id/attendees", async (req, reply) => {
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
    return reply.send({
      attendees,
      tokens: tokens.map((t) => ({
        token: t.token,
        recipientEmail: t.recipientEmail,
        createdAt: t.createdAt.toISOString(),
        expiresAt: t.expiresAt.toISOString(),
        acceptedAt: t.acceptedAt?.toISOString() ?? null,
      })),
    });
  });

  // Invite one email. Same flow as the web POST /attendees/invite —
  // adds to extra.attendees, creates a token row, sends .ics email.
  app.post<{ Params: { id: string } }>("/events/:id/attendees", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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
  app.delete<{ Params: { id: string } }>("/events/:id/attendees", async (req, reply) => {
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
  app.post("/events/:id/restore", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    // Load the soft-deleted row (loadOwnedEvent filters out deletedAt,
    // so we query directly with the ownership join).
    const [row] = await db
      .select({ event: schema.events })
      .from(schema.events)
      .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
      .where(and(eq(schema.events.id, id), eq(schema.calendars.ownerId, user.id)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (!row.event.deletedAt) {
      // Already alive — idempotent ok.
      return reply.send(forClient(row.event));
    }
    const [restored] = await db
      .update(schema.events)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(schema.events.id, id))
      .returning();
    if (restored) {
      void dispatchWebhook("event.updated", eventToWebhookPayload(restored)).catch(() => undefined);
      void pushEventChanged(user.id, restored.id, "event.restored").catch(() => undefined);
    }
    return reply.send(restored ? forClient(restored) : restored);
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

async function loadOwnedEvent(eventId: string, userId: string) {
  const rows = await db
    .select({ event: schema.events })
    .from(schema.events)
    .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
    .where(and(eq(schema.events.id, eventId), eq(schema.calendars.ownerId, userId), isNull(schema.events.deletedAt)))
    .limit(1);
  return rows[0]?.event ?? null;
}
