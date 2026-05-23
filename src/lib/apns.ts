// Apple Push Notification Service (HTTP/2, token-based).
//
// We fire SILENT pushes (content-available: 1, no alert/sound) when an
// event changes on the server. iOS wakes the APP in the background for
// up to ~30 seconds — long enough to re-fetch /events, update local
// cache, and refresh EventKit mirror. The user sees the change the
// next time they open the APP; no visible notification.
//
// Setup (per-server):
//   1. Apple Developer Console → Keys → "+" → APN service → download .p8
//   2. Set env vars: APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID
//   3. APNS_PRODUCTION=false for TestFlight/dev builds; true for App Store
//
// Without env vars, all functions in this file no-op gracefully.

import { promises as fs } from "node:fs";
import path from "node:path";
import apn from "@parse/node-apn";
import { eq, and, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";

type Provider = InstanceType<typeof apn.Provider>;

// Lazily initialized provider. We hold a single instance for the lifetime
// of the process — APNs is HTTP/2 with persistent connections, so reusing
// the same Provider is much more efficient than reconstructing per send.
let providerPromise: Promise<Provider | null> | null = null;

function isConfigured(): boolean {
  return !!(env.APNS_KEY_PATH && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID);
}

async function getProvider(): Promise<Provider | null> {
  if (!isConfigured()) return null;
  if (providerPromise) return providerPromise;
  providerPromise = (async () => {
    try {
      const keyPath = path.resolve(env.APNS_KEY_PATH!);
      const key = await fs.readFile(keyPath, "utf8");
      // node-apn auto-handles HTTP/2 connection pooling + JWT rotation.
      return new apn.Provider({
        token: { key, keyId: env.APNS_KEY_ID!, teamId: env.APNS_TEAM_ID! },
        production: env.APNS_PRODUCTION,
      });
    } catch (err) {
      // Misconfigured paths shouldn't crash the server. Log once.
      console.warn("[apns] init failed — push disabled:", (err as Error).message);
      return null;
    }
  })();
  return providerPromise;
}

// Fire silent push to every active iOS device for the given user. Logs
// failures but never throws — push is best-effort.
//
// payload is opaque to APNs; the iOS APP reads it from the userInfo
// dict when delivered. Keep it small (APNs limit is 4KB).
export async function sendSilentPushToUser(
  userId: string,
  payload: Record<string, unknown>,
): Promise<{ sent: number; failed: number }> {
  if (!isConfigured()) return { sent: 0, failed: 0 };

  // Find every active iOS device for this user that has registered a
  // push token. Android/desktop devices are skipped (they don't use APNs).
  const devices = await db
    .select({ id: schema.devices.id, pushToken: schema.devices.pushToken })
    .from(schema.devices)
    .where(and(
      eq(schema.devices.userId, userId),
      eq(schema.devices.kind, "ios"),
      isNull(schema.devices.revokedAt),
      isNotNull(schema.devices.pushToken),
    ));
  if (devices.length === 0) return { sent: 0, failed: 0 };

  const provider = await getProvider();
  if (!provider) return { sent: 0, failed: 0 };

  const note = new apn.Notification();
  // apn types contentAvailable as boolean, but at the wire layer it
  // becomes `"content-available": 1`. Both behave the same way.
  note.contentAvailable = true;          // silent push — wake APP in background
  note.priority = 5;                    // low priority for silent (per Apple guidelines)
  note.topic = env.APNS_BUNDLE_ID!;
  note.pushType = "background";         // required for content-available since iOS 13
  note.payload = payload;
  note.expiry = Math.floor(Date.now() / 1000) + 24 * 3600;  // drop after 1d if undelivered

  let sent = 0, failed = 0;
  for (const d of devices) {
    if (!d.pushToken) continue;
    try {
      const result = await provider.send(note, d.pushToken);
      sent += result.sent.length;
      failed += result.failed.length;
      // BadDeviceToken / Unregistered → device's app was uninstalled or
      // re-registered. Clear the stale token so we stop hammering APNs.
      for (const f of result.failed) {
        const reason = f.response?.reason;
        if (reason === "BadDeviceToken" || reason === "Unregistered") {
          await db.update(schema.devices)
            .set({ pushToken: null })
            .where(eq(schema.devices.id, d.id));
        }
      }
    } catch (err) {
      failed++;
      // network blip — leave token, will succeed next time
    }
  }
  return { sent, failed };
}

// Convenience: push the "an event changed" signal. iOS doesn't care
// about the specifics — it just re-fetches /events on receipt.
export async function pushEventChanged(userId: string, eventId: string, eventName: string): Promise<void> {
  await sendSilentPushToUser(userId, {
    type: "event_changed",
    eventId,
    event: eventName,
    ts: Date.now(),
  });
}

// Called once at server boot to log the configured state (or its
// absence) — makes "why isn't push working" diagnosable from pm2 logs.
export function logApnsStartup(log: { info: (m: string) => void }): void {
  if (!isConfigured()) {
    log.info("[apns] not configured (APNS_KEY_PATH/KEY_ID/TEAM_ID/BUNDLE_ID env vars empty) — push disabled");
    return;
  }
  log.info(`[apns] ready · bundle=${env.APNS_BUNDLE_ID} · ${env.APNS_PRODUCTION ? "production" : "sandbox"}`);
}
