// 一个日历「内容有没有变」的令牌。CalDAV 的 ctag 和日历接口的 ETag 都问这里，口径只有一份。

import crypto from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { getSettings } from "./site_settings.js";

export function etagOf(t: Date | string): string {
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
export async function calendarCtags(calIds: string[]): Promise<Map<string, string>> {
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

/**
 * GET /events 这一次结果的令牌。结果只取决于：能看到哪些日历（名字、颜色、时区都在响应里，
 * 时区还决定怎么展开）、查的哪几个日历和哪个窗口、这些日历里的事件有没有变（calendarCtags）。
 * 算它只要一次聚合查询，比展开规则便宜得多；网页每 30 秒轮询一次，绝大多数时候数据没变。
 */
export async function eventsWindowEtag(
  allowed: string[],
  visible: Array<{ id: string; name: string; color: string | null; timezone: string | null }>,
  from: string,
  to: string,
): Promise<string> {
  const tags = await calendarCtags(allowed);
  const parts = [...tags.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const calendars = [...visible].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return etagOf(JSON.stringify([from, to, parts, calendars]));
}

/** If-None-Match 命中了吗。反向代理开 gzip 时会把令牌改成弱形式（W/"..."），也算。 */
export function etagMatches(header: unknown, tag: string): boolean {
  if (typeof header !== "string") return false;
  return header.split(",").some((h) => h.trim().replace(/^W\//, "") === tag);
}
