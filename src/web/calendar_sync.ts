import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { loadFullSession, type LoadedSession } from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { readFlash, redirectWithFlash } from "../lib/flash.js";
import { tForRequest } from "../lib/i18n.js";
import { createAppPassword } from "../lib/app_password.js";
import { appleCalendarProfile } from "../lib/calendar_sync/apple_profile.js";
import { SyncUnavailableError } from "../lib/calendar_sync/model.js";
import { microsoftFor, syncError, withSyncAccount } from "../lib/calendar_sync/service.js";

import { getMicrosoftCalendarConfig } from "../lib/calendar_sync/config.js";

import { fingerprint, startCalendarLogin, finishCalendarLogin, createOutlookCalendar, createCalendarPair, updateCalendarPair, disconnectOutlook } from "../lib/calendar_sync/controls.js";

const ROOT = "/app/settings/calendar-sync";
export async function calendarSyncRoutes(app: FastifyInstance) {
  const sessions = new WeakMap<FastifyRequest, LoadedSession>();
  app.addHook("preHandler", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const session = await loadFullSession(req);
    if (!session) return reply.redirect("/login");
    sessions.set(req, session);
  });
  app.setErrorHandler((error, req, reply) => {
    const code = syncError(error);
    const known = ["sync_busy", "authorization_pending", "slow_down", "expired_token", "authorization_declined", "invalid_grant", "microsoft_reconnect", "calendar_changed_retry", "account_mismatch", "microsoft_not_configured", "calendar_requires_https_origin"];
    return redirectWithFlash(reply, ROOT, { error: tForRequest(req)("calendarSync.error." + (known.includes(code) ? code : "unavailable")) });
  });
  app.get("/app/settings/calendar-sync", async (req, reply) => {
    const { user, sessionId } = sessions.get(req)!;
    const [account] = await db.select({ label: schema.calendarSyncAccounts.label }).from(schema.calendarSyncAccounts).where(eq(schema.calendarSyncAccounts.userId, user.id));
    const calendars = await db.select().from(schema.calendars).where(eq(schema.calendars.ownerId, user.id));
    const pairs = await db.select().from(schema.calendarSyncPairs).where(eq(schema.calendarSyncPairs.userId, user.id));
    const [login] = await db.select({ userCode: schema.calendarSyncLogins.userCode, verificationUri: schema.calendarSyncLogins.verificationUri, expiresAt: schema.calendarSyncLogins.expiresAt })
      .from(schema.calendarSyncLogins).where(and(eq(schema.calendarSyncLogins.userId, user.id), eq(schema.calendarSyncLogins.sessionHash, fingerprint(sessionId)), gt(schema.calendarSyncLogins.expiresAt, new Date())));
    let remote: { id: string; name: string }[] = [], remoteError = false;
    if (account) {
      try { remote = await withSyncAccount(user.id, async (a, beat) => (await microsoftFor(a, beat)).calendars()); }
      catch { remoteError = true; }
    }
    let appleAvailable = true;
    try { appleCalendarProfile(env.PUBLIC_BASE_URL, user); } catch { appleAvailable = false; }
    return reply.view("app/calendar-sync", { title: tForRequest(req)("calendarSync.title"), user, flash: readFlash(req, reply), csrfToken: csrfTokenFor(req),
      account, calendars, pairs, login, remote, remoteError, appleAvailable, configured: (await getMicrosoftCalendarConfig()).configured });
  });
  app.get("/app/settings/calendar-sync/status", async () => ({
    microsoftConfigured: (await getMicrosoftCalendarConfig()).configured,
  }));
  app.get("/app/settings/calendar-sync/apple.mobileconfig", async (req, reply) => {
    let profile: string;
    try { profile = appleCalendarProfile(env.PUBLIC_BASE_URL, sessions.get(req)!.user); }
    catch { throw new SyncUnavailableError("calendar_requires_https_origin"); }
    return reply.header("Content-Disposition", 'attachment; filename="ByWave-Calendar.mobileconfig"').type("application/x-apple-aspen-config").send(profile);
  });
  app.post("/app/settings/calendar-sync/apple-password", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const issued = await createAppPassword(sessions.get(req)!.user.id, "macOS Calendar");
    return redirectWithFlash(reply, ROOT, { newAppPassword: issued.plain, newAppLabel: "macOS Calendar" });
  });
  app.post("/app/settings/calendar-sync/microsoft/start", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user, sessionId } = sessions.get(req)!;
    await startCalendarLogin(user.id, sessionId);
    return reply.redirect(ROOT);
  });
  app.post("/app/settings/calendar-sync/microsoft/finish", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user, sessionId } = sessions.get(req)!;
    await finishCalendarLogin(user.id, sessionId);
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.connected") });
  });
  app.post("/app/settings/calendar-sync/microsoft/calendar", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user } = sessions.get(req)!;
    await createOutlookCalendar(user.id);
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.calendarCreated") });
  });
  app.post("/app/settings/calendar-sync/pairs", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user } = sessions.get(req)!;
    await createCalendarPair(user.id, req.body);
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.queued") });
  });
  app.post("/app/settings/calendar-sync/pairs/action", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user } = sessions.get(req)!;
    await updateCalendarPair(user.id, req.body);
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.saved") });
  });
  app.post("/app/settings/calendar-sync/microsoft/disconnect", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user } = sessions.get(req)!;
    z.object({ confirm: z.literal("disconnect") }).parse(req.body);
    await disconnectOutlook(user.id);
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.disconnected") });
  });
}
