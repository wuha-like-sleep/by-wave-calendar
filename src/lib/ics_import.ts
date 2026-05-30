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
    const extra: Record<string, unknown> = {};
    if (sourceTag) extra.source = sourceTag;
    const extraVal = Object.keys(extra).length ? extra : null;

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
        (existing.rrule ?? null) === rrule;
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
