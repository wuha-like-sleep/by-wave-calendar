import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { parseEvents, type IcalEvent } from "./ical.js";
import { newEventUid } from "./ids.js";

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
    const resp = await fetch(normalized, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "ByWave-Calendar/1.0 (ICS importer)" },
    });
    if (!resp.ok) throw new Error(`远程返回 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error(`文件过大（>${MAX_BYTES / 1024 / 1024} MB）`);
    body = buf.toString("utf8");
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
    // Generate a stable uid if the source uid is suspiciously short.
    const uid = ev.uid.length >= 8 ? ev.uid : `${ev.uid}-${newEventUid()}`;
    const extra: Record<string, unknown> = {};
    if (sourceTag) extra.source = sourceTag;
    const values = {
      calendarId,
      uid,
      summary: ev.summary,
      description: ev.description ?? null,
      location: ev.location ?? null,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      allDay: ev.allDay,
      rrule: ev.rrule ?? null,
      extra: Object.keys(extra).length ? extra : null,
      updatedAt: new Date(),
    };
    const result = await db
      .insert(schema.events)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.events.calendarId, schema.events.uid],
        set: {
          summary: values.summary,
          description: values.description,
          location: values.location,
          startsAt: values.startsAt,
          endsAt: values.endsAt,
          allDay: values.allDay,
          rrule: values.rrule,
          extra: values.extra,
          updatedAt: values.updatedAt,
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
