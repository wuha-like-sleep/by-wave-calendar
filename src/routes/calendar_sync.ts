import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { requireUserOrSend } from "../lib/session.js";
import { ok, err } from "../lib/api_response.js";
import { tForRequest } from "../lib/i18n.js";
import { createAppPassword, listAppPasswords, revokeAppPassword } from "../lib/app_password.js";
import { appleCalendarProfile } from "../lib/calendar_sync/apple_profile.js";
import { getMicrosoftCalendarConfig } from "../lib/calendar_sync/config.js";
import { fingerprint, startCalendarLogin, finishCalendarLogin, createOutlookCalendar, createCalendarPair, updateCalendarPair, disconnectOutlook } from "../lib/calendar_sync/controls.js";
import { microsoftFor, syncError, withSyncAccount } from "../lib/calendar_sync/service.js";
import { SyncUnavailableError } from "../lib/calendar_sync/model.js";

// Device credentials only: a calendar-scoped third-party OAuth token must never
// turn into an app password or a persistent Microsoft account connection.
export async function nativeCalendarSyncRoutes(app: FastifyInstance) {
  const devices = new WeakMap<FastifyRequest, string>();
  app.addHook("preHandler", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const auth = req as FastifyRequest & { authVia?: string; deviceId?: string };
    if (!req.headers.authorization?.toLowerCase().startsWith("bearer ") || !auth.authVia?.startsWith("device:") || !auth.deviceId) {
      return err(req, reply, 403, "device_required");
    }
    devices.set(req, "native-calendar:" + auth.deviceId);
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError) return err(req, reply, 400, "invalid_request");
    const code = syncError(error);
    const known = ["sync_busy", "authorization_pending", "slow_down", "expired_token", "authorization_declined", "invalid_grant", "microsoft_reconnect", "calendar_changed_retry", "account_mismatch", "microsoft_not_configured", "calendar_requires_https_origin"];
    const message = tForRequest(req)("calendarSync.error." + (known.includes(code) ? code : "unavailable"));
    return err(req, reply, error instanceof SyncUnavailableError ? 409 : 503, code, message);
  });
  app.get("/calendar-sync", async (req, reply) => {
    const user = req.user!;
    const [account] = await db.select({ label: schema.calendarSyncAccounts.label }).from(schema.calendarSyncAccounts).where(eq(schema.calendarSyncAccounts.userId, user.id));
    const calendars = await db.select({ id: schema.calendars.id, name: schema.calendars.name, color: schema.calendars.color }).from(schema.calendars).where(eq(schema.calendars.ownerId, user.id));
    const rows = await db.select().from(schema.calendarSyncPairs).where(eq(schema.calendarSyncPairs.userId, user.id));
    // Never expose the synchronization snapshot (contains historic event data),
    // tokens, leases, device code or login binding to the native client.
    const pairs = rows.map(({ id, calendarId, remoteId, remoteName, enabled, conflicts, error, lastSyncedAt }) => ({ id, calendarId, remoteId, remoteName, enabled, conflicts, error, lastSyncedAt }));
    const [login] = await db.select({ userCode: schema.calendarSyncLogins.userCode, verificationUri: schema.calendarSyncLogins.verificationUri, expiresAt: schema.calendarSyncLogins.expiresAt, interval: schema.calendarSyncLogins.interval })
      .from(schema.calendarSyncLogins).where(and(eq(schema.calendarSyncLogins.userId, user.id), eq(schema.calendarSyncLogins.sessionHash, fingerprint(devices.get(req)!)), gt(schema.calendarSyncLogins.expiresAt, new Date())));
    let remote: { id: string; name: string }[] | null = null, remoteError = false;
    const query = z.object({ remote: z.enum(["0", "1"]).optional() }).parse(req.query);
    if (account && query.remote !== "0") {
      try { remote = await withSyncAccount(user.id, async (a, beat) => (await microsoftFor(a, beat)).calendars()); }
      catch { remoteError = true; }
    }
    let appleAvailable = true;
    try { appleCalendarProfile(env.PUBLIC_BASE_URL, user); } catch { appleAvailable = false; }
    return ok(req, reply, { configured: (await getMicrosoftCalendarConfig()).configured, account: account ?? null, calendars, pairs, login: login ?? null, remote, remoteError,
      apple: { available: appleAvailable, serverUrl: env.PUBLIC_BASE_URL + "/caldav/", username: user.email, passwords: await listAppPasswords(user.id) } });
  });
  app.post("/calendar-sync/action", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = req.user!, binding = devices.get(req)!;
    const { action } = z.object({ action: z.enum(["connect", "finish", "cancel", "create-calendar", "pair", "pause", "resume", "sync", "resolve", "disconnect", "apple-password", "apple-settings", "revoke-password"]) }).parse(req.body);
    const input = req.body as Record<string, unknown>;
    switch (action) {
      case "connect": await startCalendarLogin(user.id, binding); break;
      case "finish": await finishCalendarLogin(user.id, binding); break;
      case "cancel": await db.delete(schema.calendarSyncLogins).where(and(eq(schema.calendarSyncLogins.userId, user.id), eq(schema.calendarSyncLogins.sessionHash, fingerprint(binding)))); break;
      case "create-calendar": await createOutlookCalendar(user.id); break;
      case "pair": await createCalendarPair(user.id, input); break;
      case "pause": case "resume": case "sync": case "resolve": await updateCalendarPair(user.id, input); break;
      case "disconnect": z.object({ confirm: z.literal("disconnect") }).parse(input); await disconnectOutlook(user.id); break;
      case "apple-password": {
        const { label, calendarIds } = z.object({ label: z.string().trim().min(1).max(100), calendarIds: z.array(z.string().uuid()).min(1).max(100) }).parse(input);
        await validateCalendarSelection(user.id, calendarIds);
        if ((await listAppPasswords(user.id)).length >= 30) throw new SyncUnavailableError("calendar_limit");
        return ok(req, reply, { password: await createAppPassword(user.id, label, calendarIds) });
      }
      case "apple-settings": {
        const { id, calendarIds, paused } = z.object({ id: z.string().uuid(), calendarIds: z.array(z.string().uuid()).max(100).nullable().optional(), paused: z.boolean() }).parse(input);
        if (calendarIds != null) await validateCalendarSelection(user.id, calendarIds);
        await db.update(schema.appPasswords).set({ ...(calendarIds === undefined ? {} : { calendarIds }), paused }).where(and(eq(schema.appPasswords.id, id), eq(schema.appPasswords.userId, user.id)));
        break;
      }
      case "revoke-password": {
        const { id } = z.object({ id: z.string().uuid() }).parse(input);
        await revokeAppPassword(user.id, id); break;
      }
    }
    return ok(req, reply, { saved: true });
  });
  app.get("/calendar-sync/apple-profile", async (req, reply) => {
    let profile: string;
    try { profile = appleCalendarProfile(env.PUBLIC_BASE_URL, req.user!); }
    catch { throw new SyncUnavailableError("calendar_requires_https_origin"); }
    return ok(req, reply, { profile });
  });
}

async function validateCalendarSelection(userId: string, ids: string[]) {
  const owned = await db.select({ id: schema.calendars.id }).from(schema.calendars).where(eq(schema.calendars.ownerId, userId));
  if (ids.some(id => !owned.some(c => c.id === id))) throw new SyncUnavailableError("calendar_unavailable");
}
