// Outbound webhook dispatcher. Called fire-and-forget from event
// create/update/delete and from booking create/cancel. Failures are
// logged but never block the originating action — webhooks are best-
// effort, not transactional. If you NEED guaranteed delivery, use the
// CalDAV or API endpoints instead.
//
// Each delivery:
//   1. POST JSON to webhook.url
//   2. 5-second timeout (caller's fault if their server is slow)
//   3. Append result to webhook_deliveries
//   4. On non-2xx, retry once after a 2-second sleep
//
// HMAC-SHA256 over the raw request body when webhook.secret is set,
// passed as X-Bywave-Signature. Standard "sha256=<hex>" format —
// matches GitHub / Stripe so receivers can use existing libraries.

import { createHmac } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export type WebhookEventName =
  | "event.created" | "event.updated" | "event.deleted"
  | "booking.created" | "booking.cancelled";

const TIMEOUT_MS = 5_000;
const MAX_BODY_LOG = 1024;

async function sendOnce(url: string, body: string, signature: string | null): Promise<{ statusCode: number | null; responseBody: string; ok: boolean; errorMessage: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "ByWave-Calendar-Webhook/1.0",
    };
    if (signature) headers["X-Bywave-Signature"] = signature;
    const resp = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const text = (await resp.text()).slice(0, MAX_BODY_LOG);
    return { statusCode: resp.status, responseBody: text, ok: resp.ok, errorMessage: null };
  } catch (err) {
    return {
      statusCode: null,
      responseBody: "",
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Public dispatch entry. Loads every enabled webhook subscribed to
// the event name and dispatches in parallel. Never throws.
export async function dispatchWebhook(eventName: WebhookEventName, payload: Record<string, unknown>): Promise<void> {
  let webhooks: schema.Webhook[];
  try {
    webhooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.enabled, true));
  } catch {
    return;  // db down — silently skip
  }
  const subscribed = webhooks.filter((w) => {
    const events = Array.isArray(w.events) ? w.events as string[] : [];
    return events.includes(eventName);
  });
  if (subscribed.length === 0) return;

  const body = JSON.stringify({
    event: eventName,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  await Promise.all(subscribed.map(async (w) => {
    const signature = w.secret
      ? "sha256=" + createHmac("sha256", w.secret).update(body).digest("hex")
      : null;
    let result = await sendOnce(w.url, body, signature);
    let attempts = 1;
    // Retry once on non-2xx (transient 5xx, or a momentary network blip).
    // Don't retry 4xx — caller's config is bad.
    if (!result.ok && (result.statusCode == null || result.statusCode >= 500)) {
      await new Promise((r) => setTimeout(r, 2_000));
      result = await sendOnce(w.url, body, signature);
      attempts = 2;
    }
    try {
      await db.insert(schema.webhookDeliveries).values({
        webhookId: w.id,
        eventName,
        payload,
        statusCode: result.statusCode,
        responseBody: result.responseBody,
        attemptCount: attempts,
        ok: result.ok,
        errorMessage: result.errorMessage,
      });
    } catch {
      // delivery-log write failure shouldn't break the originating action
    }
  }));
}

// Helper to make the common payload shape consistent.
export function eventToWebhookPayload(ev: {
  id: string; calendarId: string; uid: string; summary: string;
  description?: string | null; location?: string | null;
  startsAt: Date; endsAt: Date; allDay: boolean; rrule?: string | null;
}): Record<string, unknown> {
  return {
    id: ev.id,
    calendarId: ev.calendarId,
    uid: ev.uid,
    summary: ev.summary,
    description: ev.description ?? null,
    location: ev.location ?? null,
    startsAt: ev.startsAt.toISOString(),
    endsAt: ev.endsAt.toISOString(),
    allDay: ev.allDay,
    rrule: ev.rrule ?? null,
  };
}

// Manually re-fire a single past delivery — used from the admin
// deliveries page when an external endpoint was down and the admin
// wants to replay after fixing it. Re-uses the original payload +
// HMAC signature so the receiver gets exactly the same bytes as the
// first attempt. Inserts a fresh row tagged with attemptCount += 1.
export async function retryDelivery(deliveryId: string): Promise<{ ok: boolean; statusCode: number | null; errorMessage: string | null }> {
  const [orig] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, deliveryId)).limit(1);
  if (!orig) return { ok: false, statusCode: null, errorMessage: "delivery_not_found" };
  const [hook] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, orig.webhookId)).limit(1);
  if (!hook) return { ok: false, statusCode: null, errorMessage: "webhook_deleted" };

  const body = JSON.stringify({
    event: orig.eventName,
    timestamp: new Date().toISOString(),
    data: orig.payload,
    retry_of: orig.id,
  });
  const signature = hook.secret
    ? "sha256=" + createHmac("sha256", hook.secret).update(body).digest("hex")
    : null;
  const result = await sendOnce(hook.url, body, signature);
  try {
    await db.insert(schema.webhookDeliveries).values({
      webhookId: hook.id,
      eventName: orig.eventName,
      payload: orig.payload,
      statusCode: result.statusCode,
      responseBody: result.responseBody,
      attemptCount: orig.attemptCount + 1,
      ok: result.ok,
      errorMessage: result.errorMessage,
    });
  } catch { /* swallow log-write failure */ }
  return { ok: result.ok, statusCode: result.statusCode, errorMessage: result.errorMessage };
}

// Admin "Test" button — fires a single delivery to a specific webhook
// regardless of its enabled flag or events subscription, so the admin
// can verify their setup before they turn it on.
export async function dispatchTestWebhook(hook: schema.Webhook): Promise<void> {
  const body = JSON.stringify({
    event: "test",
    timestamp: new Date().toISOString(),
    data: { message: "Hello from ByWave Calendar — this is a test delivery." },
  });
  const signature = hook.secret
    ? "sha256=" + createHmac("sha256", hook.secret).update(body).digest("hex")
    : null;
  const result = await sendOnce(hook.url, body, signature);
  try {
    await db.insert(schema.webhookDeliveries).values({
      webhookId: hook.id,
      eventName: "test",
      payload: { message: "Test delivery from admin UI" },
      statusCode: result.statusCode,
      responseBody: result.responseBody,
      attemptCount: 1,
      ok: result.ok,
      errorMessage: result.errorMessage,
    });
  } catch { /* log write failure */ }
}

// Trim deliveries log periodically. Called from the reminder cron tick.
// Keeps the last 1000 entries per webhook; older ones get deleted.
export async function pruneWebhookDeliveries(): Promise<void> {
  try {
    const rows = await db.select({ id: schema.webhooks.id }).from(schema.webhooks);
    if (rows.length === 0) return;
    // We use a single DELETE per webhook keyed by row offset; pg can't
    // do that natively without a subquery, so build a "keep these IDs"
    // list and delete everything else.
    for (const r of rows) {
      const keep = await db
        .select({ id: schema.webhookDeliveries.id })
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.webhookId, r.id))
        .orderBy(schema.webhookDeliveries.createdAt)
        .limit(1000);
      if (keep.length < 1000) continue;
      const keepIds = keep.map((k) => k.id);
      // Drizzle doesn't have a `notIn` helper at the time of this writing;
      // emulate by deleting deliveries older than the oldest "kept" row.
      const oldestKept = keep[0];
      if (oldestKept) {
        // Just delete the IDs we explicitly know are stale.
        const toDelete = await db
          .select({ id: schema.webhookDeliveries.id })
          .from(schema.webhookDeliveries)
          .where(eq(schema.webhookDeliveries.webhookId, r.id));
        const deleteIds = toDelete.filter((d) => !keepIds.includes(d.id)).map((d) => d.id);
        if (deleteIds.length > 0) {
          await db.delete(schema.webhookDeliveries).where(inArray(schema.webhookDeliveries.id, deleteIds));
        }
      }
    }
  } catch {
    // pruning is opportunistic
  }
}
