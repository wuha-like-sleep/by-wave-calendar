import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { sendMail } from "./mailer.js";
import { loginAlertMail } from "./email_templates.js";
import { env } from "../env.js";

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function hash(s: string): string {
  return createHash("sha256").update(env.SESSION_SECRET).update(s).digest("hex");
}

export async function notifyLoginSuccess(
  req: FastifyRequest,
  user: { id: string; email: string; displayName?: string | null },
  method: "password" | "passkey" | "mfa",
): Promise<void> {
  const ip = req.ip ?? "unknown";
  const ua = (req.headers["user-agent"] as string | undefined) ?? "unknown";
  const ipHash = hash(ip);
  const uaHash = hash(ua);
  const now = new Date();

  // Check dedup
  const [existing] = await db
    .select({ lastSentAt: schema.loginAlerts.lastSentAt })
    .from(schema.loginAlerts)
    .where(and(
      eq(schema.loginAlerts.userId, user.id),
      eq(schema.loginAlerts.ipHash, ipHash),
      eq(schema.loginAlerts.uaHash, uaHash),
    ))
    .limit(1);

  if (existing && now.getTime() - existing.lastSentAt.getTime() < DEDUP_WINDOW_MS) {
    // Still within dedup window; just bump timestamp silently.
    await db
      .update(schema.loginAlerts)
      .set({ lastSentAt: now })
      .where(and(
        eq(schema.loginAlerts.userId, user.id),
        eq(schema.loginAlerts.ipHash, ipHash),
        eq(schema.loginAlerts.uaHash, uaHash),
      ));
    return;
  }

  const mail = loginAlertMail(user.email, {
    email: user.email,
    displayName: user.displayName,
    loginAt: now,
    ip,
    userAgent: ua,
    method,
  });
  // Fire-and-forget; failures should not block login.
  void sendMail(mail).catch((err) => req.log.warn({ err }, "login_alert_send_failed"));

  // Upsert dedup record
  await db
    .insert(schema.loginAlerts)
    .values({ userId: user.id, ipHash, uaHash, lastSentAt: now })
    .onConflictDoUpdate({
      target: [schema.loginAlerts.userId, schema.loginAlerts.ipHash, schema.loginAlerts.uaHash],
      set: { lastSentAt: now },
    });
}
