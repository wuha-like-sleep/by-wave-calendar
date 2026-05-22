// Web Push notifications. Uses the W3C Push API + RFC 8030 protocol.
// VAPID keys identify our server to FCM / Mozilla Push / Apple Push;
// generated lazily on first /admin/push visit, then persisted so
// existing subscriptions stay valid across restarts.

import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { getSettings, updateSettings } from "./site_settings.js";

let vapidConfigured = false;

// Lazy initialization. Reads keys from site_settings; generates new
// ones and persists them if missing. Idempotent — safe to call from
// any push-sending path.
export async function ensureVapidKeys(): Promise<{ publicKey: string; privateKey: string; subject: string }> {
  const settings = await getSettings();
  let pub = settings.vapidPublicKey;
  let priv = settings.vapidPrivateKey;
  let subject = settings.vapidSubject;

  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    // Default subject is the admin email — but we don't always know
    // who that is. Use a placeholder that the admin can edit later.
    subject = subject || "mailto:admin@example.com";
    await updateSettings({
      vapidPublicKey: pub,
      vapidPrivateKey: priv,
      vapidSubject: subject,
    });
  }

  if (!vapidConfigured) {
    webpush.setVapidDetails(subject || "mailto:admin@example.com", pub, priv);
    vapidConfigured = true;
  }
  return { publicKey: pub, privateKey: priv, subject: subject || "mailto:admin@example.com" };
}

// Public key for the frontend to pass to PushManager.subscribe().
// Cached after first call. Safe to expose — the private key never
// leaves the server.
export async function getPublicVapidKey(): Promise<string> {
  const { publicKey } = await ensureVapidKeys();
  return publicKey;
}

export type PushPayload = {
  title: string;
  body: string;
  // Click-through URL when the user taps the notification.
  url?: string;
  // Optional tag — multiple notifications with the same tag collapse
  // into one in the OS notification center.
  tag?: string;
};

// Send a push to every device the user has registered. Failures are
// logged; subscriptions returning 404/410 (browser revoked) are
// auto-deleted so we stop trying to reach them.
export async function pushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; failed: number }> {
  await ensureVapidKeys();
  const subs = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
  if (subs.length === 0) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const body = JSON.stringify(payload);
  const now = new Date();

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 24 * 3600 },  // expire after 1 day if undelivered
      );
      sent++;
      // Bookkeeping; opportunistic, ignore failures.
      void db.update(schema.pushSubscriptions).set({ lastUsedAt: now }).where(eq(schema.pushSubscriptions.id, sub.id)).catch(() => undefined);
    } catch (err) {
      failed++;
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Browser/OS revoked. Stop trying.
        void db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id)).catch(() => undefined);
      }
    }
  }));
  return { sent, failed };
}
