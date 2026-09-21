import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { parseEvents, type IcalEvent } from "./ical.js";
import { safeFetch, SsrfBlockedError } from "./ssrf_guard.js";
import { env } from "../env.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on remote ICS responses

export type ImportResult = {
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
};

export async function importIcsText(
  calendarId: string,
  text: string,
  opts: { sourceTag?: string | null } = {},
): Promise<ImportResult> {
  const parsed = parseEvents(text);
  return upsertEvents(calendarId, parsed, opts.sourceTag ?? null);
}

export async function fetchIcsUrl(url: string): Promise<string> {
  // Some providers use webcal://; rewrite to https.
  let normalized = url.trim();
  if (normalized.toLowerCase().startsWith("webcal://")) {
    normalized = "https://" + normalized.slice(9);
  }
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("URL 必须以 http(s):// 开头（webcal:// 会自动改写为 https://）");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body: string;
  try {
    // SSRF guard: this URL is fully user-controlled (ICS subscription).
    // safeFetch validates protocol, rejects embedded credentials, blocks
    // private/loopback/link-local/reserved IP targets, and re-validates
    // every redirect hop. Operators can opt into internal targets via
    // ICS_ALLOW_PRIVATE_NETWORK.
    const resp = await safeFetch(normalized, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "ByWave-Calendar/1.0 (ICS importer)" },
      allowPrivate: env.ICS_ALLOW_PRIVATE_NETWORK,
    });
    if (!resp.ok) throw new Error(`远程返回 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error(`文件过大（>${MAX_BYTES / 1024 / 1024} MB）`);
    body = buf.toString("utf8");
  } catch (err) {
    // Surface the SSRF rejection as a clean, user-readable message rather
    // than leaking it as an opaque fetch failure.
    if (err instanceof SsrfBlockedError) throw new Error(err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!body.toUpperCase().includes("BEGIN:VCALENDAR")) {
    throw new Error("返回内容不是 iCalendar 格式（缺少 BEGIN:VCALENDAR）");
  }
  return body;
}

/**
 * 算出这次导入要写进 events.extra 的值：**在现有 extra 上浅合并**，不是整块替换。
 *
 * 原来这里是 `const extra = {}; if (sourceTag) extra.source = sourceTag;`，insert 和
 * onConflictDoUpdate 都写这一块。于是订阅每刷新一次（默认 5 分钟一轮），用户给这个
 * 事件设的提醒、分类、参与者、时区就被整块抹成 `{source}` —— 没有任何报错，
 * 用户只会发现「提醒时不时就自己没了」。
 *
 * alarms 的口径和 CalDAV PUT 故意不同：
 *   - 上游带了 VALARM → 以上游为准。订阅进来的日程本来就带提醒（球赛开赛前 1 小时、
 *     课表提前 15 分钟），不落等于把上游信息丢了，用户还得自己在每个事件上重设一遍。
 *   - 上游没带 VALARM → **保留库里已有的**，不清空。订阅刷新是我们单方面去拉的，
 *     上游从没看过用户在我们这儿加的提醒，它「没有 VALARM」只说明这个源不发提醒
 *     （节假日、球赛表大多如此），不构成「删掉提醒」的意思表示。
 *     CalDAV PUT 那边能当成删除，是因为客户端刚完整读过这份资源又完整写了回来。
 */
export function mergeImportExtra(
  existingExtra: unknown,
  sourceTag: string | null,
  alarms: IcalEvent["alarms"],
): Record<string, unknown> | null {
  const base = existingExtra && typeof existingExtra === "object" && !Array.isArray(existingExtra)
    ? { ...(existingExtra as Record<string, unknown>) }
    : {};
  if (sourceTag) base.source = sourceTag;
  if (Array.isArray(alarms) && alarms.length) base.alarms = alarms;
  return Object.keys(base).length ? base : null;
}

/**
 * 键排序后再 stringify，只用来判「这次刷新有没有真的变」。
 *
 * 不能直接比 JSON 文本：Postgres 的 jsonb 会按「键长度 → 字节序」重排键，读回来的
 * `{"action":…,"trigger":…,"description":…}` 和我们刚拼出来的
 * `{"trigger":…,"action":…,"description":…}` 内容一模一样、文本不同。
 * 直接比就等于每 5 分钟判定一次「变了」、白写一次 updatedAt，而 CalDAV 的 etag 就是
 * etagOf(updatedAt) —— etag 一直在动，Apple 日历带 If-Match 的 PUT 就会 412，
 * 用户看到的是「无法更新日历」。
 */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

async function upsertEvents(
  calendarId: string,
  parsed: IcalEvent[],
  sourceTag: string | null,
): Promise<ImportResult> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const ev of parsed) {
    if (!ev.uid || !ev.summary) { skipped++; continue; }
    // Stable synthetic uid for suspiciously-short source uids.
    //
    // BUG (fixed here): this used to be `${ev.uid}-${newEventUid()}` — a
    // RANDOM suffix minted fresh on every call. That broke idempotency:
    // the (calendarId, uid) conflict target never matched on re-import, so
    // every manual re-import AND every 5-minute subscription refresh
    // INSERTED a brand-new row → the "one event became several copies"
    // duplication. Derive the suffix DETERMINISTICALLY from the event's
    // identity instead, so the same source event maps to the same row
    // across imports, while two genuinely-distinct events that happen to
    // share a short source uid still resolve to different uids.
    const uid = ev.uid.length >= 8
      ? ev.uid
      : `${ev.uid}-${createHash("sha1")
          .update(`${ev.uid}|${ev.summary}|${ev.startsAt.toISOString()}|${ev.endsAt.toISOString()}`)
          .digest("hex")
          .slice(0, 12)}`;

    const desc = ev.description ?? null;
    const loc = ev.location ?? null;
    const rrule = ev.rrule ?? null;

    // Look up the current row so we can SKIP no-op writes. Re-writing
    // updatedAt on every refresh — even when nothing changed — churns the
    // CalDAV etag (etag = etagOf(updatedAt)). Apple Calendar caches etags;
    // a perpetually-moving etag makes its If-Match PUTs fail with 412 →
    // it surfaces "无法更新日历 / The calendar could not be updated". Only
    // touch the row when a user-visible field actually differs.
    const [existing] = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uid, uid)))
      .limit(1);

    const extraVal = mergeImportExtra(existing?.extra ?? null, sourceTag, ev.alarms ?? null);

    if (existing) {
      // Leave soft-deleted rows alone: don't resurrect something the user
      // (or the dedupe script) removed, and don't churn its updatedAt.
      if (existing.deletedAt != null) { skipped++; continue; }
      const unchanged =
        existing.summary === ev.summary &&
        (existing.description ?? null) === desc &&
        (existing.location ?? null) === loc &&
        existing.startsAt.getTime() === ev.startsAt.getTime() &&
        existing.endsAt.getTime() === ev.endsAt.getTime() &&
        existing.allDay === ev.allDay &&
        (existing.rrule ?? null) === rrule &&
        // 提醒也要算进「有没有变」。不算的话上游把提醒从「提前 1 小时」改成「提前 1 天」
        // 而别的字段没动，这里会判定 unchanged 直接 skip，新提醒永远落不了库 ——
        // extraVal 已经算好了，只是没人写进去，症状是「上游改了但我们这边没反应」。
        stableJson(extraVal) === stableJson(existing.extra ?? null);
      if (unchanged) { skipped++; continue; }
    }

    const result = await db
      .insert(schema.events)
      .values({
        calendarId,
        uid,
        summary: ev.summary,
        description: desc,
        location: loc,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        allDay: ev.allDay,
        rrule,
        extra: extraVal,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.events.calendarId, schema.events.uid],
        set: {
          summary: ev.summary,
          description: desc,
          location: loc,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          allDay: ev.allDay,
          rrule,
          extra: extraVal,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.events.id, inserted: sql<boolean>`(xmax = 0)` });
    const row = result[0];
    if (!row) { skipped++; continue; }
    if (row.inserted) inserted++; else updated++;
  }

  return { inserted, updated, skipped, total: parsed.length };
}

// ---------- Subscription refresh ----------

export async function refreshSubscription(subId: string): Promise<{ ok: true; result: ImportResult } | { ok: false; error: string }> {
  const [sub] = await db
    .select()
    .from(schema.calendarSubscriptions)
    .where(eq(schema.calendarSubscriptions.id, subId))
    .limit(1);
  if (!sub) return { ok: false, error: "subscription_not_found" };
  try {
    const text = await fetchIcsUrl(sub.url);
    // Surface a clear error when the upstream returned HTML / login page
    // instead of an actual ICS feed. Without this check refreshSubscription
    // happily "succeeds" with 0 events, hiding the real issue from the user.
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("BEGIN:VCALENDAR")) {
      const preview = trimmed.slice(0, 80).replace(/\s+/g, " ");
      throw new Error(`URL didn't return an ICS feed (got: "${preview}…"). Check the link — needs to be a webcal:// or .ics URL, not an HTML page.`);
    }
    const result = await importIcsText(sub.calendarId, text, { sourceTag: `sub:${sub.id}` });
    await db
      .update(schema.calendarSubscriptions)
      .set({
        lastFetchedAt: new Date(),
        lastStatus: "ok",
        lastError: null,
        lastEventCount: result.total,
      })
      .where(eq(schema.calendarSubscriptions.id, sub.id));
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.calendarSubscriptions)
      .set({
        lastFetchedAt: new Date(),
        lastStatus: "error",
        lastError: msg.slice(0, 500),
      })
      .where(eq(schema.calendarSubscriptions.id, sub.id));
    return { ok: false, error: msg };
  }
}

// Background scheduler: every 5 minutes, refresh any subscription whose
// (last_fetched_at + refresh_minutes) is in the past, or which has never run.
let schedulerStarted = false;
const FIVE_MIN = 5 * 60 * 1000;

export function startSubscriptionScheduler(logger: { info: (m: string) => void; warn: (m: unknown) => void }): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = async () => {
    try {
      const rows = await db
        .select({ id: schema.calendarSubscriptions.id })
        .from(schema.calendarSubscriptions)
        .where(sql`(${schema.calendarSubscriptions.lastFetchedAt} IS NULL
          OR ${schema.calendarSubscriptions.lastFetchedAt} + (${schema.calendarSubscriptions.refreshMinutes} * interval '1 minute') < now())`);
      for (const r of rows) {
        const res = await refreshSubscription(r.id);
        if (!res.ok) logger.warn({ subId: r.id, error: res.error });
      }
    } catch (err) {
      logger.warn({ err });
    }
  };
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, FIVE_MIN);
  logger.info("subscription scheduler started (5-min tick)");
}
