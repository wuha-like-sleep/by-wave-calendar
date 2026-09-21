import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { basicAuth } from "../lib/caldav_auth.js";
import { extractVeventBlock, invitationIcs, parseEvent, prodIdLine, serializeEvent, wrapSingleEvent, type IcalEvent } from "../lib/ical.js";
import { mergeExdatesIntoVevent, overlayPartstat } from "../lib/caldav_helpers.js";
import { normalizeAlarms } from "../lib/reminder_triggers.js";
import { attendeeEmails, type AttendeeLike } from "../lib/attendees.js";
import { newInvitationToken } from "../lib/ids.js";
import { sendMail } from "../lib/mailer.js";
import { eventInviteMail } from "../lib/email_templates.js";
import { cancelEvent } from "../lib/event_cancel.js";
import { getSettings } from "../lib/site_settings.js";

// ---------- XML helpers ----------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function etagOf(t: Date | string): string {
  const v = typeof t === "string" ? t : t.toISOString();
  return `"${crypto.createHash("md5").update(v).digest("hex")}"`;
}

// Collection ctag for one or more calendars, via SQL aggregate.
//
// MUST include soft-deleted rows: cancelEvent bumps updatedAt when it sets
// deletedAt, and that bump is the ONLY signal a deletion ever emits. The old
// implementation hashed max(updatedAt) over live rows only, so a web-side
// delete left the ctag unchanged and Apple Calendar (which polls getctag to
// decide whether to re-sync) never removed the event from the phone.
// The live-row count is hashed in as a belt-and-braces second signal, and
// this also replaces loading every event into memory just to fold their
// timestamps (the home PROPFIND did that once per calendar per poll).
//
// 部署级别的「同步纪元」也掺在里面（site_settings.caldav_sync_epoch，见 0051）。
// 为什么必须有它：上面那两个信号都是**数据**信号。凡是「只改序列化口径、
// 一行数据都不动」的发版 —— 合成 VEVENT 开始带 VALARM 就是 —— max(updatedAt)
// 和行数都不会动，ctag 一个字节不变，客户端手上那份部署前的副本在它眼里
// 永远是最新的。0050 那种「挑一批行改 updated_at」补不上这个洞：只要
// max(updatedAt) 落在没被挑中的行上（订阅进来的、没挂提醒的），ctag 照样不变。
// 实测一个两条事件的日历跑完 0050 前后 ctag 完全一样（c77eb025…）。
// 以后再有这类变更，bump 一次纪元即可，不必再去猜该动哪些行。
//
// 纪元只进 ctag，**不进单行 etag**（etagOf 只喂 updatedAt）。这是刻意的：
// ctag 变 = 客户端来重新「列」一遍（一次 Depth:1 PROPFIND，本仓库没有实现
// sync-collection，客户端只有这一条路）；etag 变才是「这条正文变了、重下」。
// 纪元要的是前者。把它也掺进 etag 的话，bump 一次 = 每台设备重下整个日历。
//
// 拼串的三条讲究：
//   · 纪元掺在 md5 的**输入**里，不是拼在输出后面 —— 输出仍是 32 位十六进制，
//     长度和抗碰撞性和原来一模一样。
//   · 纪元是自由文本（迁移写的字面量 / 后台写的随机串），它**可能含 `|`**。
//     直接用 `|` 分隔的话，("a|b", X) 和 ("a", "b|X") 会拼出同一个字符串。
//     所以纪元这一段带长度前缀，切分是唯一的。其余三段的取值里没有 `|`。
//   · 日历 id 也在里面：ctag 的契约是「这个集合的不透明令牌」，两个恰好
//     max(updatedAt) 和行数都相同的日历不该拿到同一个令牌。
async function calendarCtags(calIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (calIds.length === 0) return out;
  const epoch = (await getSettings()).caldavSyncEpoch;
  // 长度前缀，见上面第二条。空纪元（还没 bump 过）是 "0:"，一个合法取值。
  const epochField = `${epoch.length}:${epoch}`;
  const rows = await db
    .select({
      calendarId: schema.events.calendarId,
      maxUpdated: sql<string | null>`max(${schema.events.updatedAt})::text`,
      liveCount: sql<number>`count(*) filter (where ${schema.events.deletedAt} is null)::int`,
    })
    .from(schema.events)
    .where(inArray(schema.events.calendarId, calIds))
    .groupBy(schema.events.calendarId);
  for (const r of rows) {
    out.set(r.calendarId, etagOf(`${epochField}|${r.calendarId}|${r.maxUpdated ?? "empty"}|${r.liveCount}`));
  }
  // Calendars with zero event rows produce no group — give them a stable tag.
  for (const id of calIds) {
    if (!out.has(id)) out.set(id, etagOf(`${epochField}|${id}|empty|0`));
  }
  return out;
}

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const NS = `xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:IC="http://apple.com/ns/ical/"`;

// ---------- Multistatus builders ----------

type PropDict = {
  resourcetype?: string;            // raw inner XML
  displayname?: string;
  currentUserPrincipal?: string;    // href
  calendarHomeSet?: string;         // href
  calendarUserAddressSet?: string;  // mailto:
  supportedCalendarComponentSet?: string[];  // ["VEVENT"]
  supportedReportSet?: boolean;
  ctag?: string;
  etag?: string;
  contentType?: string;             // getcontenttype — required by iOS for resources
  contentLength?: number;
  lastModified?: Date;
  calendarData?: string;            // iCalendar text
  ownerHref?: string;
  calendarColor?: string;
  calendarDescription?: string;
  calendarTimezone?: string;
  currentUserPrivilegeSet?: boolean;
};

function buildPropXml(props: PropDict): string {
  const parts: string[] = [];
  if (props.resourcetype !== undefined) parts.push(`<resourcetype>${props.resourcetype}</resourcetype>`);
  if (props.displayname !== undefined) parts.push(`<displayname>${xmlEscape(props.displayname)}</displayname>`);
  if (props.currentUserPrincipal !== undefined) parts.push(`<current-user-principal><href>${xmlEscape(props.currentUserPrincipal)}</href></current-user-principal>`);
  if (props.calendarHomeSet !== undefined) parts.push(`<C:calendar-home-set><href>${xmlEscape(props.calendarHomeSet)}</href></C:calendar-home-set>`);
  if (props.calendarUserAddressSet !== undefined) parts.push(`<C:calendar-user-address-set><href>${xmlEscape(props.calendarUserAddressSet)}</href></C:calendar-user-address-set>`);
  if (props.supportedCalendarComponentSet !== undefined) {
    const comps = props.supportedCalendarComponentSet.map(c => `<C:comp name="${xmlEscape(c)}"/>`).join("");
    parts.push(`<C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>`);
  }
  if (props.supportedReportSet) {
    parts.push(`<supported-report-set>
      <supported-report><report><C:calendar-query/></report></supported-report>
      <supported-report><report><C:calendar-multiget/></report></supported-report>
    </supported-report-set>`);
  }
  if (props.ctag !== undefined) parts.push(`<CS:getctag>${xmlEscape(props.ctag)}</CS:getctag>`);
  if (props.etag !== undefined) parts.push(`<getetag>${xmlEscape(props.etag)}</getetag>`);
  if (props.contentType !== undefined) parts.push(`<getcontenttype>${xmlEscape(props.contentType)}</getcontenttype>`);
  if (props.contentLength !== undefined) parts.push(`<getcontentlength>${props.contentLength}</getcontentlength>`);
  if (props.lastModified !== undefined) parts.push(`<getlastmodified>${xmlEscape(props.lastModified.toUTCString())}</getlastmodified>`);
  if (props.calendarData !== undefined) parts.push(`<C:calendar-data>${xmlEscape(props.calendarData)}</C:calendar-data>`);
  if (props.ownerHref !== undefined) parts.push(`<owner><href>${xmlEscape(props.ownerHref)}</href></owner>`);
  if (props.calendarColor !== undefined) parts.push(`<IC:calendar-color>${xmlEscape(props.calendarColor)}</IC:calendar-color>`);
  if (props.calendarDescription !== undefined) parts.push(`<C:calendar-description>${xmlEscape(props.calendarDescription)}</C:calendar-description>`);
  if (props.calendarTimezone !== undefined) parts.push(`<C:calendar-timezone>${xmlEscape(props.calendarTimezone)}</C:calendar-timezone>`);
  if (props.currentUserPrivilegeSet) {
    parts.push(`<current-user-privilege-set>
      <privilege><read/></privilege>
      <privilege><write/></privilege>
      <privilege><write-properties/></privilege>
      <privilege><write-content/></privilege>
      <privilege><bind/></privilege>
      <privilege><unbind/></privilege>
    </current-user-privilege-set>`);
  }
  return parts.join("");
}

function responseEntry(href: string, props: PropDict, status = "HTTP/1.1 200 OK"): string {
  return `<response>
    <href>${xmlEscape(href)}</href>
    <propstat>
      <prop>${buildPropXml(props)}</prop>
      <status>${status}</status>
    </propstat>
  </response>`;
}

function multistatus(entries: string[]): string {
  return `${XML_DECL}\n<multistatus ${NS}>\n${entries.join("\n")}\n</multistatus>`;
}

// ---------- Path helpers ----------

function principalHref(userId: string): string { return `/caldav/principals/${userId}/`; }
function homeHref(userId: string): string { return `/caldav/${userId}/`; }
function calendarHref(userId: string, calId: string): string { return `/caldav/${userId}/${calId}/`; }
function eventHref(userId: string, calId: string, uid: string): string { return `/caldav/${userId}/${calId}/${uid}.ics`; }

// ---------- Common helpers ----------

/**
 * 发一份 multistatus/XML 响应。
 *
 * **必须 `return sendXml(...)`，不能光调用。** 这不是风格问题：
 * handler 以 undefined 结束时 Fastify 认为「没人处理」，而响应其实已经发了，
 * 于是走进 @fastify/compress 的 onSend 之后 body 被丢掉——客户端拿到
 * `207 Multi-Status` + `content-encoding: gzip` + **0 字节**。
 *
 * 这个 bug 只在客户端声明压缩、且响应超过 compress 的 1024 字节阈值时发作，
 * 也就是：小响应（OPTIONS、principal 查询）正常，一到「列日历」「列事件」就空。
 * 表现正是 Apple 的「目前不能刷新账户」，或者账户加上了却一个日历都没有。
 *
 * 而 curl 默认**不发** Accept-Encoding，所以人工诊断脚本一路绿灯——
 * 这个 bug 因此躲过了两轮排查。门禁 test/caldav_compression.test.ts
 * 必须带 Accept-Encoding: gzip，否则那条测试永远是绿的。
 */
function sendXml(reply: FastifyReply, body: string, code = 207): FastifyReply {
  return reply
    .code(code)
    .header("Content-Type", 'application/xml; charset="utf-8"')
    .header("DAV", "1, 2, 3, calendar-access")
    .send(body);
}

// Stream a multistatus body chunk by chunk instead of building the
// whole 5-10MB XML string up front. Used for REPORT responses on
// large calendars — for 10K events the in-memory string was easily
// 5MB+ and multiple concurrent CalDAV clients would balloon RSS.
//
// Each `entry` is a fully-formed <response>…</response> string. We
// write the XML envelope, each entry as it's built, then close.
// Caller is responsible for awaiting the returned Promise so the
// HTTP response actually finishes before the handler returns.
async function streamMultistatus(
  reply: FastifyReply,
  entries: AsyncIterable<string> | Iterable<string>,
  code = 207,
): Promise<void> {
  reply
    .code(code)
    .header("Content-Type", 'application/xml; charset="utf-8"')
    .header("DAV", "1, 2, 3, calendar-access");
  // Take over the raw socket so Fastify doesn't try to send a body
  // after we stream. .hijack() is the documented escape hatch for
  // chunked custom responses.
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(code, {
    "Content-Type": 'application/xml; charset="utf-8"',
    "DAV": "1, 2, 3, calendar-access",
    "Transfer-Encoding": "chunked",
  });
  raw.write(`${XML_DECL}\n<multistatus ${NS}>\n`);
  // CRITICAL robustness: once we've sent the 207 + opening <multistatus>,
  // we can no longer switch to an error status. If iterating `entries`
  // throws partway (e.g. a single event fails to serialize), we MUST
  // still close </multistatus> — an unterminated chunked stream gives the
  // client truncated, unparseable XML, which Apple Calendar surfaces as
  // "无法更新日历 / The calendar could not be refreshed", and because the
  // bad event persists it fails on EVERY refresh. try/finally guarantees
  // the document is always well-formed even on a mid-stream failure.
  try {
    // Backpressure: respect socket .write() returning false. Without
    // this we could pile up megabytes in the Node write buffer for a
    // slow client.
    for await (const entry of entries) {
      // 客户端已经走了就别再序列化剩下的事件了。
      if (raw.destroyed || raw.writableEnded) break;
      if (!raw.write(entry + "\n")) {
        // 背压等待必须同时监听 close / error。
        //
        // 只等 "drain" 会永久挂住：socket 一旦销毁就再也不会触发 drain，
        // 这个 promise 永不 settle，for-await 永久挂起，finally 里那句
        // 补 </multistatus> 也跑不到 —— handler 连同它持有的整份事件数组
        // 一起留在堆上。手机在弱网、切后台、锁屏时中断同步是常态，
        // 每中断一次就钉住一份该次同步的全部数据。实测 31 次中断之后，
        // 那 31 条请求永远不会结束（等 30 秒也不会），内存只涨不回。
        //
        // 讽刺的是：上面注释里说「try/finally 保证文档总是完整」，
        // 恰恰在它要防的那个场景下跑不到。
        await new Promise<void>((resolve) => {
          const done = () => {
            raw.off("drain", done); raw.off("close", done); raw.off("error", done);
            resolve();
          };
          raw.once("drain", done);
          raw.once("close", done);
          raw.once("error", done);
        });
        if (raw.destroyed || raw.writableEnded) break;
      }
    }
  } catch (err) {
    reply.log.warn({ err }, "caldav_multistatus_stream_error");
  } finally {
    // socket 可能已经被客户端关掉了。对已经 end 过的响应再 end 会抛
    // ERR_STREAM_WRITE_AFTER_END，而 reply_guard 的 isBenignDoubleWrite
    // 只白名单了 ERR_HTTP_HEADERS_SENT —— 那会一路走到 process.exit(1)。
    if (!raw.writableEnded) {
      try { raw.end("</multistatus>\n"); } catch { /* socket 已消失，无事可做 */ }
    }
  }
}

function setOptionsHeaders(reply: FastifyReply): void {
  reply
    .header("DAV", "1, 2, 3, calendar-access")
    .header("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT")
    .header("Accept-Ranges", "bytes");
}

function depthHeader(req: FastifyRequest): "0" | "1" | "infinity" {
  const h = String(req.headers["depth"] ?? "0").toLowerCase();
  if (h === "1") return "1";
  if (h === "infinity") return "infinity";
  return "0";
}

async function loadCalendarOwned(userId: string, calId: string) {
  const [cal] = await db
    .select()
    .from(schema.calendars)
    .where(and(eq(schema.calendars.id, calId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return cal ?? null;
}

// Load events for a calendar. When the CalDAV REPORT body carries a
// <time-range start="…" end="…"/> filter we push it into SQL so we
// don't dump the entire history into memory for clients that only
// want next month. Recurring masters always come through regardless
// of the range — their occurrences could fall in the window even if
// the master DTSTART is far in the past.
async function loadAllEventsOf(calId: string, range?: { start: Date | null; end: Date | null }) {
  const conds = [
    eq(schema.events.calendarId, calId),
    isNull(schema.events.deletedAt),
  ];
  if (range?.start) {
    // Drop events whose end is before the requested start AND aren't
    // recurring. The OR makes Postgres still load every recurring master.
    conds.push(or(
      gte(schema.events.endsAt, range.start),
      isNotNull(schema.events.rrule),
    )!);
  }
  if (range?.end) {
    conds.push(or(
      lte(schema.events.startsAt, range.end),
      isNotNull(schema.events.rrule),
    )!);
  }
  return db.select().from(schema.events).where(and(...conds)).orderBy(asc(schema.events.startsAt));
}

function rowToIcal(row: schema.Event): IcalEvent {
  const extra = (row.extra ?? null) as null | {
    // 两种存量形状都可能（见 lib/attendees.ts）：CalDAV 写的对象数组、网页 / JSON API
    // 写的邮箱字符串数组。这里不挑形状，serializeEvent 里过 attendeeDetails 统一摊平。
    attendees?: unknown;
    organizer?: string | null;
    timezone?: string | null;
    alarms?: unknown;
  };
  return {
    uid: row.uid,
    summary: row.summary,
    description: row.description,
    location: row.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: row.allDay,
    rrule: row.rrule,
    exdates: Array.isArray(row.exdates) ? (row.exdates as string[]) : null,
    // Carry the event's IANA zone through to serializeEvent so CalDAV
    // clients see DTSTART;TZID=Asia/Shanghai:… (wall-clock) instead of
    // DTSTART:…Z. Makes the event display correctly when the recipient
    // is in a different timezone than the organizer.
    timezone: extra?.timezone ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Surface attendees + organizer in the synthesized VEVENT so that
    // events created via the web UI (no rawIcs round-trip) still show
    // their attendee list on CalDAV clients. PARTSTAT overlay happens
    // downstream in rowToVCalendar.
    organizer: extra?.organizer ?? null,
    // 以前这里是「原样递给 serializeEvent」，而那边的 `if (!a.email) continue` 对字符串
    // 恒为真 —— 网页上加的参与者在 iPhone 日历里一行 ATTENDEE 都没有。
    attendees: (extra?.attendees ?? null) as AttendeeLike[] | null,
    // 提醒也要出现在合成的 VEVENT 里。PUT 那边现在是「上传里没有 VALARM 就是删提醒」，
    // 而合成路径正是网页/API 建的事件（没有 rawIcs 可回放）。GET 不给 VALARM，
    // 手机就没见过这条提醒，用户在手机上动一下事件，网页设的提醒就被回写清掉了。
    alarms: normalizeAlarms(extra?.alarms ?? []),
  };
}

// Wrap an event's iCalendar body for outbound delivery. Prefers the raw VEVENT
// the client originally sent (preserves ATTENDEE / VALARM / TRANSP / CATEGORIES /
// X-*); falls back to synthesizing one from the parsed columns for events created
// via the web UI (or imported) where no raw body was ever stored.
// `partstatByEmail` (optional): overlay current RSVP responses on ATTENDEE
// lines so the organizer's phone reflects "alice accepted" the moment alice
// clicks the link in the invite email — caller is responsible for batch-
// loading the map to avoid N+1.
function rowToVCalendar(row: schema.Event, calName: string, partstatByEmail?: Map<string, string>): string {
  const CRLF = "\r\n";
  let vevent: string;
  if (row.rawIcs && row.rawIcs.includes("BEGIN:VEVENT")) {
    // events.exdates is JSONB → `unknown`. Narrow before handing to the
    // helper, which has a tight type to keep the lib DB-agnostic.
    vevent = mergeExdatesIntoVevent(row.rawIcs, {
      exdates: Array.isArray(row.exdates) ? (row.exdates as string[]) : null,
      allDay: row.allDay,
    });
  } else {
    // Synthesized — wrapSingleEvent already builds the full VCALENDAR.
    // Apply PARTSTAT overlay then return.
    const ics = wrapSingleEvent(rowToIcal(row), calName);
    return partstatByEmail && partstatByEmail.size > 0 ? overlayPartstat(ics, partstatByEmail) : ics;
  }
  if (partstatByEmail && partstatByEmail.size > 0) {
    vevent = overlayPartstat(vevent, partstatByEmail);
  }
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    prodIdLine("CalDAV"),
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${calName.replace(/[\r\n]/g, " ")}`,
    vevent,
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

// Batch-load RSVP responses for a set of events. Returns
//   Map<eventId, Map<emailLowercase, PARTSTAT>>
// Used by REPORT/GET handlers to overlay the organizer's view of
// attendee responses without N+1 queries per event.
async function loadAttendeeStatuses(eventIds: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (eventIds.length === 0) return out;
  const rows = await db
    .select({
      eventId: schema.eventInviteTokens.sourceEventId,
      email: schema.eventInviteTokens.recipientEmail,
      status: schema.eventInviteTokens.responseStatus,
    })
    .from(schema.eventInviteTokens)
    .where(inArray(schema.eventInviteTokens.sourceEventId, eventIds));
  for (const r of rows) {
    if (!r.status) continue;
    const partstat =
      r.status === "accepted" ? "ACCEPTED" :
      r.status === "declined" ? "DECLINED" :
      r.status === "tentative" ? "TENTATIVE" : null;
    if (!partstat) continue;
    let inner = out.get(r.eventId);
    if (!inner) { inner = new Map(); out.set(r.eventId, inner); }
    // Token rows are 1-per-recipient. Most recent response wins (we sort
    // by responseStatus's just-set value, but in practice each recipient
    // has at most one token per event).
    inner.set(r.email.toLowerCase(), partstat);
  }
  return out;
}

// (overlayPartstat + mergeExdatesIntoVevent moved to ../lib/caldav_helpers.ts
//  so they can be unit-tested without spinning up Fastify/DB.)

// ---------- Route handlers ----------

async function handleOptions(_req: FastifyRequest, reply: FastifyReply) {
  setOptionsHeaders(reply);
  // return（不是光调用）—— 见 sendXml 的注释：漏了 return，响应体会被
  // compress 的 onSend 丢掉。这里 body 是空的所以暂时无害，但形状必须一致，
  // 否则下一个照着抄的人就会踩坑。
  return reply.code(200).send();
}

// PROPFIND / (the actual HTTP root, not /caldav/) — Apple Calendar's
// discovery flow hits this AFTER .well-known/caldav. Without it, the
// add-account flow on macOS dies with "Account information cannot be
// verified". The only purpose is to advertise where the real principal
// is — we just point at /caldav/ and let the client follow.
async function propfindDiscoveryRoot(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const body = multistatus([
    responseEntry("/", {
      resourcetype: "<collection/>",
      currentUserPrincipal: principalHref(user.id),
      displayname: "ByWave",
    }),
  ]);
  return sendXml(reply, body);
}

// PROPFIND /caldav/ — return current-user-principal pointing to user's principal
async function propfindRoot(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const body = multistatus([
    responseEntry("/caldav/", {
      resourcetype: "<collection/>",
      displayname: "ByWave Calendars",
      currentUserPrincipal: principalHref(user.id),
    }),
  ]);
  return sendXml(reply, body);
}

// PROPFIND /caldav/principals/<userId>/
async function propfindPrincipal(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const params = req.params as { userId?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");

  const body = multistatus([
    responseEntry(principalHref(user.id), {
      resourcetype: "<collection/><principal/>",
      displayname: user.displayName ?? user.email,
      currentUserPrincipal: principalHref(user.id),
      calendarHomeSet: homeHref(user.id),
      calendarUserAddressSet: `mailto:${user.email}`,
    }),
  ]);
  return sendXml(reply, body);
}

// PROPFIND /caldav/<userId>/ — calendar-home: lists user's calendars (Depth 1)
async function propfindHome(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const params = req.params as { userId?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");

  const depth = depthHeader(req);
  const entries: string[] = [];

  entries.push(responseEntry(homeHref(user.id), {
    resourcetype: "<collection/>",
    displayname: "我的日历",
    currentUserPrincipal: principalHref(user.id),
    ownerHref: principalHref(user.id),
  }));

  if (depth !== "0") {
    const cals = await db.select().from(schema.calendars).where(eq(schema.calendars.ownerId, user.id));
    const ctags = await calendarCtags(cals.map(c => c.id));
    for (const c of cals) {
      entries.push(responseEntry(calendarHref(user.id, c.id), {
        resourcetype: '<collection/><C:calendar/>',
        displayname: c.name,
        supportedCalendarComponentSet: ["VEVENT"],
        supportedReportSet: true,
        ctag: ctags.get(c.id)!,
        ownerHref: principalHref(user.id),
        calendarColor: c.color,
        calendarDescription: c.description ?? undefined,
        calendarTimezone: c.timezone,
        currentUserPrivilegeSet: true,
      }));
    }
  }
  return sendXml(reply, multistatus(entries));
}

// PROPFIND /caldav/<userId>/<calId>/ — single calendar, optionally with events
async function propfindCalendar(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const params = req.params as { userId?: string; calId?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const depth = depthHeader(req);
  const events = await loadAllEventsOf(cal.id);
  const entries: string[] = [];

  entries.push(responseEntry(calendarHref(user.id, cal.id), {
    resourcetype: '<collection/><C:calendar/>',
    displayname: cal.name,
    supportedCalendarComponentSet: ["VEVENT"],
    supportedReportSet: true,
    ctag: (await calendarCtags([cal.id])).get(cal.id)!,
    ownerHref: principalHref(user.id),
    calendarColor: cal.color,
    calendarDescription: cal.description ?? undefined,
    calendarTimezone: cal.timezone,
    currentUserPrivilegeSet: true,
  }));

  if (depth !== "0") {
    for (const e of events) {
      entries.push(responseEntry(eventHref(user.id, cal.id, e.uid), {
        resourcetype: "",
        etag: etagOf(e.updatedAt),
        contentType: "text/calendar; charset=utf-8; component=VEVENT",
        lastModified: e.updatedAt,
      }));
    }
  }
  return sendXml(reply, multistatus(entries));
}

// REPORT /caldav/<userId>/<calId>/ — calendar-query / calendar-multiget
async function reportCalendar(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const params = req.params as { userId?: string; calId?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const bodyStr = String(req.body ?? "");

  // calendar-multiget: client lists explicit hrefs
  if (/<C:calendar-multiget[\s>]/i.test(bodyStr) || /calendar-multiget/i.test(bodyStr)) {
    // Extract <href>...</href> entries from the request body. Keep the
    // original href strings — requested-but-missing resources must be
    // answered with a 404 <response> under this exact href so the client
    // drops its local copy (this is how a web-side delete propagates when
    // the client re-fetches by href).
    const hrefMatches = Array.from(bodyStr.matchAll(/<(?:[A-Za-z0-9]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9]+:)?href>/g));
    const wanted = hrefMatches
      .map(m => {
        const href = (m[1] ?? "").trim();
        const match = href.match(/\/([^/]+)\.ics$/);
        return match?.[1] ? { href, uid: match[1] } : null;
      })
      .filter((x): x is { href: string; uid: string } => !!x);
    const wantedUids = wanted.map(w => w.uid);

    // Soft-deleted rows are excluded on purpose: returning them here
    // would resurrect deleted events on the client.
    const events = wantedUids.length === 0
      ? await loadAllEventsOf(cal.id)
      : (await db
          .select()
          .from(schema.events)
          .where(and(eq(schema.events.calendarId, cal.id), isNull(schema.events.deletedAt))))
          .filter(e => wantedUids.includes(e.uid));

    // Batch-load RSVP statuses for all matched events so the response
    // reflects current accept/decline state without N+1 queries.
    const statusMap = await loadAttendeeStatuses(events.map((e) => e.id));
    // Stream the response — for large multiget bodies (iOS pulls
    // hundreds of events at once on first sync) the multistatus XML
    // was easily 10MB+, all held in memory at once. Generator yields
    // one <response> at a time; streamMultistatus flushes each.
    const foundUids = new Set(events.map(e => e.uid));
    await streamMultistatus(reply, (function* () {
      for (const e of events) {
        let entry: string;
        try {
          entry = responseEntry(eventHref(user.id, cal.id, e.uid), {
            etag: etagOf(e.updatedAt),
            contentType: "text/calendar; charset=utf-8; component=VEVENT",
            lastModified: e.updatedAt,
            calendarData: rowToVCalendar(e, cal.name, statusMap.get(e.id)),
          });
        } catch (err) {
          // Skip one un-serializable event instead of breaking the whole
          // REPORT. Logged so the offending row can be found and fixed.
          req.log.warn({ caldav: "multiget", calId: cal.id, eventId: e.id, uid: e.uid, err: String(err) }, "caldav_event_serialize_skipped");
          continue;
        }
        yield entry;
      }
      // 404 entries for requested hrefs that don't exist (or are deleted) —
      // echo the client's own href verbatim so it can match them up.
      for (const w of wanted) {
        if (foundUids.has(w.uid)) continue;
        yield `<response>\n    <href>${xmlEscape(w.href)}</href>\n    <status>HTTP/1.1 404 Not Found</status>\n  </response>`;
      }
    })());
    return;
  }

  // calendar-query: optional time-range filter
  let start: Date | null = null;
  let end: Date | null = null;
  const trMatch = bodyStr.match(/<(?:[A-Za-z0-9]+:)?time-range\s+([^/>]+)\/?\s*>/i);
  if (trMatch) {
    const attrs = trMatch[1] ?? "";
    const s = attrs.match(/start="([^"]+)"/i)?.[1];
    const e = attrs.match(/end="([^"]+)"/i)?.[1];
    if (s) start = parseIcalUtcStamp(s);
    if (e) end = parseIcalUtcStamp(e);
  }

  // Push the time-range into SQL so we don't fan a giant calendar
  // (10K+ events) into memory just to throw most of them away. We
  // still keep the JS filter below as a safety net for edge cases the
  // SQL coarse-grain didn't catch (e.g. allDay UTC-midnight ambiguity).
  let events = await loadAllEventsOf(cal.id, { start, end });
  if (start || end) {
    events = events.filter(ev => {
      // 重复事件永远保留，和上面 SQL 里的豁免保持一致。
      //
      // 这里曾经漏掉这个豁免：SQL 特意把每条重复事件的主记录都捞出来
      // （因为 DTSTART 可能在很久以前），紧接着就被这个「兜底」过滤一个不剩地
      // 扔掉了。后果是 iPhone 的「设置 → 日历 → 同步 → 一个月前的事件」
      // ——**这是系统默认值**——一生效，所有长期周会/例会就从手机上整个消失，
      // 而网页端照常显示、服务端一条日志都不打。用户会以为日程被人删了。
      //
      // 判断「某次重复是否落在窗口内」要展开 RRULE，代价高且容易算错；
      // 多返回一些是安全的（CalDAV 客户端自己会展开并过滤），少返回才是 bug。
      if (ev.rrule) return true;
      if (start && ev.endsAt < start) return false;
      if (end && ev.startsAt > end) return false;
      return true;
    });
  }

  // 客户端只要 etag 的时候，正文既不序列化也不发 —— 连 RSVP 状态那一批查询
  // 都省掉（它只是为了拼正文里的 ATTENDEE;PARTSTAT）。
  const includeData = wantsCalendarData(bodyStr);
  const statusMap = includeData
    ? await loadAttendeeStatuses(events.map((e) => e.id))
    : new Map<string, never>();
  await streamMultistatus(reply, (function* () {
    for (const e of events) {
      let entry: string;
      try {
        entry = responseEntry(eventHref(user.id, cal.id, e.uid), {
          etag: etagOf(e.updatedAt),
          ...(includeData
            ? { calendarData: rowToVCalendar(e, cal.name, statusMap.get(e.id)) }
            : {}),
        });
      } catch (err) {
        // Skip one un-serializable event instead of breaking the whole
        // REPORT. Logged so the offending row can be found and fixed.
        req.log.warn({ caldav: "calendar-query", calId: cal.id, eventId: e.id, uid: e.uid, err: String(err) }, "caldav_event_serialize_skipped");
        continue;
      }
      yield entry;
    }
  })());
}

/**
 * 客户端在 <prop> 里到底要了哪些字段。
 *
 * 以前不管客户端要什么，calendar-query 都无条件把整条 VCALENDAR 塞进每一条
 * response。而 CalDAV 客户端标准的省流量做法恰恰是「先只要 getetag 列一遍清单，
 * 比对出哪几条变了，再用 calendar-multiget 只取那几条正文」——我们把这条路的
 * 收益全吃掉了。实测：3000 条事件的日历，一次只要 etag 的 REPORT 要回
 * 3.1 MB 正文、服务端单线程序列化 260 ms。升级当天所有设备同时来这一下，
 * 就是几十秒的事件循环阻塞。
 *
 * 解析不出 <prop> 时**保守地当作要正文**：多返回是安全的（客户端自己会挑），
 * 少返回才是 bug。注意 <C:filter> 里的 <C:prop-filter> 不能被当成 <prop>，
 * 所以标签名后面要求紧跟空白或 '>'。
 */
function wantsCalendarData(body: string): boolean {
  const propBlock = body.match(/<(?:[A-Za-z0-9]+:)?prop[\s>][\s\S]*?<\/(?:[A-Za-z0-9]+:)?prop>/i);
  if (!propBlock) return true;
  return /<(?:[A-Za-z0-9]+:)?calendar-data[\s/>]/i.test(propBlock[0]);
}

function parseIcalUtcStamp(val: string): Date | null {
  // Accept "20260522T100000Z" or "20260522T100000"
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  return new Date(Date.UTC(+(m[1] ?? "0"), +(m[2] ?? "1") - 1, +(m[3] ?? "1"), +(m[4] ?? "0"), +(m[5] ?? "0"), +(m[6] ?? "0")));
}

// GET /caldav/<userId>/<calId>/<uid>.ics — single event as iCalendar
async function getEvent(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const params = req.params as { userId?: string; calId?: string; uid?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const [event] = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, params.uid ?? "")))
    .limit(1);
  // Soft-deleted counts as gone — serving it would resurrect the event
  // on clients that re-fetch by href after a web-side delete.
  if (!event || event.deletedAt) return reply.code(404).send("Not Found");

  const statusMap = await loadAttendeeStatuses([event.id]);
  let ics: string;
  try {
    ics = rowToVCalendar(event, cal.name, statusMap.get(event.id));
  } catch (err) {
    req.log.warn({ caldav: "get", calId: cal.id, eventId: event.id, uid: event.uid, err: String(err) }, "caldav_event_serialize_failed");
    return reply.code(500).type("text/plain").send("Event could not be serialized");
  }
  reply
    .header("Content-Type", "text/calendar; charset=utf-8")
    .header("ETag", etagOf(event.updatedAt));
  return reply.send(ics);
}

/**
 * PUT 上传的 VALARM 覆盖到 extra.alarms 上：**有几条就是几条，一条没有就是删光**。
 *
 * 为什么是「以这次上传为准」而不是「有才覆盖」：CalDAV 的 PUT 是整份日历资源替换
 * （RFC 4791 §5.3.2），协议里根本没有「只改一个属性」的半份上传；能走到这里的请求，
 * parseEvent 已经要到了 UID + SUMMARY + DTSTART + DTEND，拿不到就在上面 400 了。
 * 也就是说客户端刚刚看过这份资源的完整内容，又完整地写了回来 —— 它没写 VALARM，
 * 意思就是「我把提醒删了」。
 *
 * 原来这行是 `if (parsed.alarms) extraPatch.alarms = parsed.alarms;`：客户端把 VALARM
 * 全删掉时 parsed.alarms 是 null，这行不执行，库里的老提醒被 `{...existing.extra}` 原样
 * 带过去。结果是用户在 iPhone 自带日历里删了提醒，手机上看着确实没了，服务端还在按
 * 老提醒给他发邮件，而且怎么删都删不掉。
 *
 * 注意这跟 .ics 订阅刷新是两码事（见 ics_import.ts）：订阅是我们单方面去拉的，
 * 上游从没看过用户在我们这儿加的提醒，它「没带 VALARM」不构成删除的意思表示。
 *
 * --- 为什么还要一个 clientHasCurrentCopy ---
 *
 * 上面那套推理有个前提：客户端手上那份**看过**我们现在这版内容。而合成 VEVENT 带上
 * VALARM 是后来才加的（rowToIcal 里那段），在那之前 GET 回去的事件根本没有 VALARM。
 * 客户端缓存的就是那份没有 VALARM 的副本，而上线既不改 events.updated_at 也不改行数
 * —— etag 和 ctag 都没变，客户端**不会重新拉**。用户第一次在手机上碰这个事件，
 * 传上来的正是那份旧副本：他什么都没删，网页上设的提醒却没了。一个没人动的事件
 * 可以在这个状态里躺一年，两端都不报错。
 *
 * 所以「没有 VALARM = 删除」只在能证明客户端手上是当前版本时才成立，而 CalDAV 里
 * 唯一的证据就是 If-Match 命中当前 etag（RFC 4791 §5.3.2 建议的更新写法，iOS /
 * macOS 日历、Thunderbird、DAVx5 都会带）。命中不了的 PUT 是一次盲写：
 * 它没写 VALARM，只说明它不知道有 VALARM，不说明用户删了提醒。
 * 顺带一提，同一份 PUT 里 transp / status / attendees / categories / organizer /
 * timezone 全是「有才覆盖」，alarms 是唯一一个「没有就是删」的键 —— 而它恰好是
 * 老客户端缓存里必然缺失的那个，两件事凑在一起才成了数据丢失。
 */
export function applyAlarmsFromPut(
  extraPatch: Record<string, unknown>,
  parsed: { alarms?: IcalEvent["alarms"] },
  evidence: { clientHasCurrentCopy: boolean },
): void {
  const alarms = Array.isArray(parsed.alarms) ? parsed.alarms : [];
  if (alarms.length) { extraPatch.alarms = alarms; return; }
  // 没有 VALARM，而且客户端手上确实是当前这一版 → 这是一次真正的删除。
  if (evidence.clientHasCurrentCopy) delete extraPatch.alarms;
  // 否则什么都不做：保留库里的提醒（见上面「窗口」那段）。
}

// PUT /caldav/<userId>/<calId>/<uid>.ics — create or update
async function putEvent(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const params = req.params as { userId?: string; calId?: string; uid?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const bodyStr = typeof req.body === "string" ? req.body : "";
  // Strict-ish content-type check: PUT'ing a CalDAV event MUST be
  // text/calendar per RFC 4791. Reject everything else with a clear
  // 415 instead of silently accepting and 400-ing later in parseEvent
  // (which would hide the actual problem). Tolerant of charset/method
  // parameters since clients add them freely.
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct && !ct.startsWith("text/calendar")) {
    return reply.code(415).type("text/plain").send("Unsupported Media Type — expected text/calendar");
  }
  req.log.info({
    caldav: "put",
    userId: user.id, calId: params.calId, uid: params.uid,
    contentType: req.headers["content-type"],
    bodyBytes: bodyStr.length,
    bodyHead: bodyStr.slice(0, 200),
    ifMatch: req.headers["if-match"], ifNoneMatch: req.headers["if-none-match"],
  }, "caldav_put");
  const parsed = parseEvent(bodyStr);
  if (!parsed) {
    req.log.warn({ caldav: "put", bodyHead: bodyStr.slice(0, 400) }, "caldav_put_parse_failed");
    return reply.code(400).send("Invalid iCalendar");
  }
  const rawVevent = extractVeventBlock(bodyStr);

  // The UID in the URL might differ from the UID in the body — use body UID as authoritative,
  // but match against URL for existing lookup.
  const urlUid = params.uid ?? parsed.uid;

  // Wrap the lookup + write in a transaction so two clients (laptop +
  // phone) PUTting the same UID near-simultaneously can't:
  //   - both see existing=null and both INSERT → second hits the unique
  //     (calendar_id, uid) index and 500s
  //   - or both see the same existing row, both pass If-Match against
  //     the same etag, and silently last-write-wins
  // Inside the tx we re-read existing with the lock implied by the
  // upcoming UPDATE on the same row, then commit atomically.
  const ifMatchHdr = req.headers["if-match"];
  const ifNoneMatchHdr = req.headers["if-none-match"];

  type WriteOutcome =
    | { kind: "ok"; stored: schema.Event; isCreate: boolean }
    | { kind: "412" }
    | { kind: "500"; err: unknown };

  const outcome: WriteOutcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, urlUid)))
      .limit(1);

    // Anything the client sent that we can't fold into structured columns (TRANSP,
    // ATTENDEE list, VALARM reminders, CATEGORIES, ORGANIZER, custom X-*) is preserved
    // by storing the raw VEVENT block; GET/REPORT prefers raw_ics so the round-trip
    // is lossless and the phone doesn't see "the server stripped my event" and delete.
    const extraPatch: Record<string, unknown> = { ...((existing?.extra as Record<string, unknown> | null) ?? {}) };
    if (parsed.transp) extraPatch.transp = parsed.transp;
    if (parsed.status) extraPatch.status = parsed.status;
    // 参与者收口成邮箱字符串数组（见 lib/attendees.ts）：库里只留一种形状，
    // 网页和已经发出去的三端才读得回来。一个能用的邮箱都摊不出来（iOS 有时用
    // `urn:uuid:…` 之类的内部身份当 ATTENDEE）就不动这个键 —— 覆盖成空数组等于
    // 替用户把人删了。
    const putAttendees = attendeeEmails(parsed.attendees);
    if (putAttendees.length) extraPatch.attendees = putAttendees;
    // 「客户端手上是不是当前这一版」——只有带 If-Match 且命中当前 etag 才算数。
    // 库里没有这一行时无所谓：删不掉任何东西。
    const clientHasCurrentCopy = !existing || (
      typeof ifMatchHdr === "string" && ifMatchHdr !== "*" && ifMatchHdr === etagOf(existing.updatedAt)
    );
    applyAlarmsFromPut(extraPatch, parsed, { clientHasCurrentCopy });
    if (parsed.organizer) extraPatch.organizer = parsed.organizer;
    if (parsed.categories) extraPatch.categories = parsed.categories;
    // Persist the IANA zone the client sent (DTSTART;TZID=…). Without this
    // an event created on iPhone in Shanghai TZ would round-trip as UTC and
    // lose its "anchored to wall-clock" semantics — re-export would show
    // the wrong time on phones in other zones.
    if (parsed.timezone) extraPatch.timezone = parsed.timezone;

    // EXDATE merge: take the union of whatever the client sent and what
    // we already have. A "delete just this occurrence" on the phone
    // shows up as a new EXDATE line; we never want to silently drop
    // exclusions a different client added (web UI, another device)
    // just because this PUT didn't echo them. Union is the safe op.
    const incomingExdates = Array.isArray(parsed.exdates) ? parsed.exdates : [];
    const existingExdates: string[] = Array.isArray(existing?.exdates) ? (existing!.exdates as string[]) : [];
    const mergedExdates = Array.from(new Set([...existingExdates, ...incomingExdates]));

    if (existing) {
      if (ifMatchHdr && ifMatchHdr !== "*" && ifMatchHdr !== etagOf(existing.updatedAt)) {
        return { kind: "412" } as const;
      }
      const [updated] = await tx
        .update(schema.events)
        .set({
          summary: parsed.summary,
          description: parsed.description ?? null,
          location: parsed.location ?? null,
          startsAt: parsed.startsAt,
          endsAt: parsed.endsAt,
          allDay: parsed.allDay,
          rrule: parsed.rrule ?? null,
          exdates: mergedExdates.length ? mergedExdates : null,
          // Un-soft-delete on resurrect (iOS PUTting an event whose UID matches
          // a previously soft-deleted row should bring it back rather than
          // tripping the UNIQUE (calendar_id, uid) constraint on insert).
          deletedAt: null,
          extra: Object.keys(extraPatch).length ? extraPatch : null,
          rawIcs: rawVevent,
          updatedAt: new Date(),
        })
        .where(eq(schema.events.id, existing.id))
        .returning();
      return { kind: "ok", stored: updated!, isCreate: false } as const;
    }
    if (ifNoneMatchHdr === "*") {
      // "Create only" precondition: but we just verified no existing row.
      // This branch is unreachable in practice but kept for explicitness.
    }
    const [inserted] = await tx
      .insert(schema.events)
      .values({
        calendarId: cal.id,
        uid: urlUid,
        summary: parsed.summary,
        description: parsed.description ?? null,
        location: parsed.location ?? null,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        allDay: parsed.allDay,
        rrule: parsed.rrule ?? null,
        exdates: mergedExdates.length ? mergedExdates : null,
        extra: Object.keys(extraPatch).length ? extraPatch : null,
        rawIcs: rawVevent,
      })
      .returning();
    return { kind: "ok", stored: inserted!, isCreate: true } as const;
  });

  if (outcome.kind === "412") return reply.code(412).send("Precondition Failed");
  const stored = outcome.stored;
  const isResurrectOrCreate = outcome.isCreate;

  // Send invitation emails to attendees who haven't received one yet.
  // For first-creation this is the full list; for updates this is the
  // *new* additions (e.g. organizer added Bob to a meeting on their
  // phone — Bob should get the invite email even though Alice was
  // already a recipient from the original PUT). Already-invited people
  // get a re-REQUEST email so their phone updates the event details.
  if (parsed.attendees && parsed.attendees.length > 0) {
    const recipientList = attendeeEmails(parsed.attendees)
      .filter((e) => e !== user.email.toLowerCase());
    if (recipientList.length > 0) {
      // Look up who we've already invited so we know who's "new" vs
      // "re-notify". A re-creation (resurrect) treats everyone as new.
      const existingTokens = isResurrectOrCreate ? [] : await db
        .select({ recipientEmail: schema.eventInviteTokens.recipientEmail })
        .from(schema.eventInviteTokens)
        .where(eq(schema.eventInviteTokens.sourceEventId, stored.id));
      const alreadyInvited = new Set(existingTokens.map((r) => r.recipientEmail.toLowerCase()));
      const newRecipients = recipientList.filter((e) => !alreadyInvited.has(e));
      const reNotifyRecipients = recipientList.filter((e) => alreadyInvited.has(e));

      const organizerName = user.displayName || user.email;
      const ics = invitationIcs({
        event: {
          uid: stored.uid,
          summary: stored.summary,
          description: stored.description,
          location: stored.location,
          startsAt: stored.startsAt,
          endsAt: stored.endsAt,
          allDay: stored.allDay,
          updatedAt: stored.updatedAt,
        },
        organizerEmail: user.email,
        organizerName,
        attendees: recipientList.map((email) => ({ email })),
        method: "REQUEST",
        // SEQUENCE must increase on each REQUEST update or RFC 5546-compliant
        // clients ignore the changes. Bump by 1 for re-notifies; new-only
        // creates start at 0.
        sequence: reNotifyRecipients.length > 0 ? 1 : 0,
      });
      const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      for (const to of newRecipients) {
        const inviteToken = newInvitationToken();
        try {
          await db.insert(schema.eventInviteTokens).values({
            token: inviteToken,
            sourceEventId: stored.id,
            recipientEmail: to,
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          });
        } catch (err) {
          req.log.warn({ err, to }, "caldav_invite_token_failed");
        }
        sendMail(eventInviteMail(to, {
          organizerEmail: user.email,
          organizerName,
          summary: stored.summary,
          description: stored.description,
          location: stored.location,
          startsAt: stored.startsAt,
          endsAt: stored.endsAt,
          allDay: stored.allDay,
          uid: stored.uid,
          timezone: (stored.extra as { timezone?: string } | null)?.timezone ?? null,
          icsBody: ics,
          inviteToken,
        })).catch((err) => req.log.warn({ err, to }, "caldav_invite_mail_failed"));
      }
      // Re-notify: reuse the existing token so the recipient's RSVP
      // history isn't reset. Their phone's calendar will update the
      // event details from the new SEQUENCE-bumped .ics.
      for (const to of reNotifyRecipients) {
        const [existing] = await db
          .select()
          .from(schema.eventInviteTokens)
          .where(and(
            eq(schema.eventInviteTokens.sourceEventId, stored.id),
            eq(schema.eventInviteTokens.recipientEmail, to),
          ))
          .limit(1);
        if (!existing) continue;
        sendMail(eventInviteMail(to, {
          organizerEmail: user.email,
          organizerName,
          summary: stored.summary,
          description: stored.description,
          location: stored.location,
          startsAt: stored.startsAt,
          endsAt: stored.endsAt,
          allDay: stored.allDay,
          uid: stored.uid,
          timezone: (stored.extra as { timezone?: string } | null)?.timezone ?? null,
          icsBody: ics,
          inviteToken: existing.token,
        })).catch((err) => req.log.warn({ err, to }, "caldav_invite_renotify_failed"));
      }
      req.log.info({
        caldav: "put_invites_sent",
        newCount: newRecipients.length,
        reNotifyCount: reNotifyRecipients.length,
        eventId: stored.id,
      }, "caldav_put_invites");
    }
  }

  reply.header("ETag", etagOf(stored.updatedAt));
  if (isResurrectOrCreate) reply.header("Location", eventHref(user.id, cal.id, stored.uid));
  return reply.code(isResurrectOrCreate ? 201 : 204).send();
}

// DELETE /caldav/<userId>/<calId>/<uid>.ics
async function deleteEvent(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return reply;
  const params = req.params as { userId?: string; calId?: string; uid?: string };
  req.log.info({ caldav: "delete", userId: user.id, calId: params.calId, uid: params.uid, ifMatch: req.headers["if-match"] }, "caldav_delete");
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const [event] = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, params.uid ?? "")))
    .limit(1);
  if (!event) return reply.code(404).send("Not Found");

  const ifMatch = req.headers["if-match"];
  if (ifMatch && ifMatch !== "*" && ifMatch !== etagOf(event.updatedAt)) {
    return reply.code(412).send("Precondition Failed");
  }

  // Already soft-deleted? Idempotent 204, don't re-fire emails.
  if (event.deletedAt) return reply.code(204).send();
  // Soft-delete + send CANCEL emails to anyone we ever invited.
  await cancelEvent(event.id, { id: user.id, email: user.email, displayName: user.displayName });
  return reply.code(204).send();
}

// ---------- Plugin ----------

export async function caldavRoutes(app: FastifyInstance) {
  // ---------- RFC 6764 service discovery ----------
  // Apple Calendar's add-account flow probes BOTH .well-known/caldav AND
  // .well-known/carddav, then OPTIONS / and PROPFIND /. Without these,
  // it gives up with the unhelpful "the account could not be added".
  // We answer .well-known/caldav with a 302 (was 301 — 301 is cached
  // permanently and breaks future path migrations) and stub carddav with
  // a 404 that still carries DAV headers so the client knows we're a
  // DAV server, just not a CardDAV one.
  app.all("/.well-known/caldav", { config: { rateLimit: false } }, async (_req, reply) => {
    return reply.code(302).header("Location", "/caldav/").send();
  });
  app.all("/.well-known/carddav", { config: { rateLimit: false } }, async (_req, reply) => {
    reply
      .header("DAV", "1, 2, 3, calendar-access")
      .code(404)
      .type("text/plain")
      .send("CardDAV not supported; CalDAV at /caldav/");
  });

  // OPTIONS / — Apple Calendar 发现流程的第二步(紧跟 .well-known)。
  // 必须不带认证就能答,因为此时客户端还不知道该用谁的凭据。
  //
  // 这里原本用 onRequest 钩子实现,但钩子注册在 CalDAV 插件的封装作用域
  // 里,只对该作用域内**已注册的路由**生效 —— 而 OPTIONS / 恰恰没有路由,
  // 请求直接落到全局 404,钩子从不触发。实测 `OPTIONS /` 返回
  // {"error":"not_found"},注释里描述的行为从未实现过。
  // 改为真正注册一条路由:与首页的 GET / 是不同方法,不会冲突。
  app.route({
    method: "OPTIONS",
    url: "/",
    config: { rateLimit: false },
    handler: async (_req, reply) => {
      setOptionsHeaders(reply);
      return reply.code(200).send();
    },
  });


  // PROPFIND / — after OPTIONS, Apple does PROPFIND on the discovery
  // root looking for current-user-principal. Without it, Apple aborts
  // with "Account information cannot be verified."
  app.route({
    method: "PROPFIND" as never,
    url: "/",
    config: { rateLimit: false },
    handler: propfindDiscoveryRoot,
  });

  const allowedMethods = ["OPTIONS", "PROPFIND"] as const;

  // ---------- /caldav root ----------
  // We dual-register every CalDAV path with AND without the trailing
  // slash. Thunderbird and some DAVx⁵ versions strip trailing slashes
  // when normalizing href values, so a follow-up PROPFIND lands on the
  // no-slash form and 404s if we only registered with-slash.
  for (const url of ["/caldav", "/caldav/"]) {
    app.route({ method: "OPTIONS", url, config: { rateLimit: false }, handler: handleOptions });
    app.route({ method: "PROPFIND" as never, url, config: { rateLimit: false }, handler: propfindRoot });
  }

  // ---------- Principal ----------
  for (const url of ["/caldav/principals/:userId", "/caldav/principals/:userId/"]) {
    app.route({ method: "OPTIONS", url, config: { rateLimit: false }, handler: handleOptions });
    app.route({ method: "PROPFIND" as never, url, config: { rateLimit: false }, handler: propfindPrincipal });
  }

  // ---------- Calendar home ----------
  for (const url of ["/caldav/:userId", "/caldav/:userId/"]) {
    app.route({ method: "OPTIONS", url, config: { rateLimit: false }, handler: handleOptions });
    app.route({ method: "PROPFIND" as never, url, config: { rateLimit: false }, handler: propfindHome });
  }

  // ---------- Single calendar ----------
  for (const url of ["/caldav/:userId/:calId", "/caldav/:userId/:calId/"]) {
    app.route({ method: "OPTIONS", url, config: { rateLimit: false }, handler: handleOptions });
    app.route({ method: "PROPFIND" as never, url, config: { rateLimit: false }, handler: propfindCalendar });
    app.route({ method: "REPORT" as never, url, config: { rateLimit: false }, handler: reportCalendar });
  }

  // Event resource
  app.route({
    method: "OPTIONS",
    url: "/caldav/:userId/:calId/:uid",
    config: { rateLimit: false },
    handler: handleOptions,
  });
  app.route({
    method: "GET",
    url: "/caldav/:userId/:calId/:uid",
    config: { rateLimit: false },
    handler: (req, reply) => {
      // Strip .ics suffix
      const p = req.params as { uid?: string };
      if (p.uid) p.uid = p.uid.replace(/\.ics$/i, "");
      return getEvent(req, reply);
    },
  });
  app.route({
    method: "PUT",
    url: "/caldav/:userId/:calId/:uid",
    config: { rateLimit: false },
    handler: (req, reply) => {
      const p = req.params as { uid?: string };
      if (p.uid) p.uid = p.uid.replace(/\.ics$/i, "");
      return putEvent(req, reply);
    },
  });
  app.route({
    method: "DELETE",
    url: "/caldav/:userId/:calId/:uid",
    config: { rateLimit: false },
    handler: (req, reply) => {
      const p = req.params as { uid?: string };
      if (p.uid) p.uid = p.uid.replace(/\.ics$/i, "");
      return deleteEvent(req, reply);
    },
  });

  void allowedMethods;
}
