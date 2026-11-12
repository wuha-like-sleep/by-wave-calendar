import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gt, lte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { loadFullSession, type LoadedSession } from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { readFlash, redirectWithFlash } from "../lib/flash.js";
import { tForRequest } from "../lib/i18n.js";
import { createAppPassword } from "../lib/app_password.js";
import { appleCalendarProfile } from "../lib/calendar_sync/apple_profile.js";
import { emptyState, stateSchema, SyncUnavailableError, type Conflict } from "../lib/calendar_sync/model.js";
import { MicrosoftClient, MicrosoftError, pollMicrosoftLogin, startMicrosoftLogin } from "../lib/calendar_sync/microsoft.js";
import { openToken, sealToken } from "../lib/calendar_sync/secrets.js";
import { microsoftFor, syncError, withSyncAccount } from "../lib/calendar_sync/service.js";

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
      account, calendars, pairs, login, remote, remoteError, appleAvailable, configured: Boolean(env.MICROSOFT_CALENDAR_CLIENT_ID) });
  });
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
    const clientId = env.MICROSOFT_CALENDAR_CLIENT_ID;
    if (!clientId) throw new SyncUnavailableError("microsoft_not_configured");
    const { user, sessionId } = sessions.get(req)!;
    const result = await startMicrosoftLogin(clientId);
    const data = { userId: user.id, sessionHash: fingerprint(sessionId), clientId,
      deviceCode: sealToken("login:" + user.id, result.device_code), userCode: result.user_code,
      verificationUri: result.verification_uri, interval: Math.ceil(result.interval),
      expiresAt: new Date(Date.now() + result.expires_in * 1000), nextPollAt: new Date(Date.now() + result.interval * 1000) };
    await db.insert(schema.calendarSyncLogins).values(data).onConflictDoUpdate({ target: schema.calendarSyncLogins.userId, set: data });
    return reply.redirect(ROOT);
  });
  app.post("/app/settings/calendar-sync/microsoft/finish", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user, sessionId } = sessions.get(req)!;
    const now = new Date();
    // Claim a poll across workers. Device codes never enter HTML, logs or URLs.
    const [login] = await db.update(schema.calendarSyncLogins).set({ nextPollAt: new Date(Date.now() + 30_000) })
      .where(and(eq(schema.calendarSyncLogins.userId, user.id), eq(schema.calendarSyncLogins.sessionHash, fingerprint(sessionId)), gt(schema.calendarSyncLogins.expiresAt, now), lte(schema.calendarSyncLogins.nextPollAt, now))).returning();
    if (!login) throw new SyncUnavailableError("authorization_pending");
    const sameLogin = and(eq(schema.calendarSyncLogins.userId, user.id), eq(schema.calendarSyncLogins.deviceCode, login.deviceCode));
    try {
      const tokens = await pollMicrosoftLogin(login.clientId, openToken("login:" + user.id, login.deviceCode));
      if (!tokens.refresh_token) throw new SyncUnavailableError("microsoft_reconnect");
      const account = await new MicrosoftClient(tokens.access_token).account();
      const values = { userId: user.id, accountId: account.id, label: account.mail || account.userPrincipalName || account.displayName || "Microsoft", clientId: login.clientId, refreshToken: sealToken(user.id, tokens.refresh_token) };
      // Keep existing mappings on reconnect; silently switching Microsoft accounts
      // would otherwise interpret every old remote event as a deletion.
      await db.transaction(async tx => {
        const [active] = await tx.select().from(schema.calendarSyncLogins).where(sameLogin).for("update");
        if (!active || active.expiresAt <= new Date()) throw new SyncUnavailableError("expired_token");
        const [existing] = await tx.select().from(schema.calendarSyncAccounts).where(eq(schema.calendarSyncAccounts.userId, user.id)).for("update");
        if (existing && existing.accountId !== account.id) throw new SyncUnavailableError("account_mismatch");
        if (existing?.leaseUntil && existing.leaseUntil > new Date()) throw new SyncUnavailableError("sync_busy");
        if (existing) await tx.update(schema.calendarSyncAccounts).set(values).where(eq(schema.calendarSyncAccounts.userId, user.id));
        else await tx.insert(schema.calendarSyncAccounts).values(values);
      });
      await db.delete(schema.calendarSyncLogins).where(sameLogin);
      return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.connected") });
    } catch (e) {
      if (e instanceof MicrosoftError && ["authorization_pending", "slow_down"].includes(e.code)) {
        const interval = login.interval + (e.code === "slow_down" ? 5 : 0);
        await db.update(schema.calendarSyncLogins).set({ interval, nextPollAt: new Date(Date.now() + interval * 1000) }).where(sameLogin);
      } else await db.delete(schema.calendarSyncLogins).where(sameLogin);
      throw e;
    }
  });
  app.post("/app/settings/calendar-sync/microsoft/calendar", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user } = sessions.get(req)!;
    await withSyncAccount(user.id, async (a, beat) => (await microsoftFor(a, beat)).createCalendar("ByWave Calendar"));
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.calendarCreated") });
  });
  app.post("/app/settings/calendar-sync/pairs", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user } = sessions.get(req)!;
    const body = z.object({ calendarId: z.string().uuid(), remoteId: z.string().min(1).max(2048) }).parse(req.body);
    await withSyncAccount(user.id, async (a, beat) => {
      const [calendar] = await db.select().from(schema.calendars).where(and(eq(schema.calendars.id, body.calendarId), eq(schema.calendars.ownerId, user.id)));
      if (!calendar) throw new SyncUnavailableError("calendar_unavailable");
      const current = await db.select().from(schema.calendarSyncPairs).where(eq(schema.calendarSyncPairs.userId, user.id));
      if (current.length >= 10) throw new SyncUnavailableError("calendar_limit");
      const remote = (await (await microsoftFor(a, beat)).calendars()).find(c => c.id === body.remoteId);
      if (!remote || current.some(p => p.calendarId === calendar.id || p.remoteId === remote.id)) throw new SyncUnavailableError("calendar_unavailable");
      await db.insert(schema.calendarSyncPairs).values({ userId: user.id, calendarId: calendar.id, remoteId: remote.id, remoteName: remote.name, state: emptyState() });
    });
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.queued") });
  });
  app.post("/app/settings/calendar-sync/pairs/action", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user } = sessions.get(req)!;
    const body = z.object({ id: z.string().uuid(), action: z.enum(["pause", "resume", "sync", "resolve"]), key: z.string().max(2048).optional(), side: z.enum(["left", "right"]).optional() }).parse(req.body);
    await withSyncAccount(user.id, async () => {
      const [pair] = await db.select().from(schema.calendarSyncPairs).where(and(eq(schema.calendarSyncPairs.id, body.id), eq(schema.calendarSyncPairs.userId, user.id)));
      if (!pair) throw new SyncUnavailableError("calendar_unavailable");
      const update: Partial<typeof schema.calendarSyncPairs.$inferInsert> = { nextRunAt: new Date() };
      if (body.action === "pause") update.enabled = false;
      if (body.action === "resume") update.enabled = true;
      if (body.action === "resolve") {
        const conflict = (pair.conflicts as Conflict[]).find(c => c.key === body.key);
        if (!conflict || !body.side) throw new SyncUnavailableError("calendar_changed_retry");
        const state = stateSchema.parse(pair.state);
        state.resolutions[conflict.key] = { side: body.side, leftRevision: conflict.left?.revision ?? null, rightRevision: conflict.right?.revision ?? null };
        update.state = state;
      }
      await db.update(schema.calendarSyncPairs).set(update).where(eq(schema.calendarSyncPairs.id, pair.id));
    });
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.saved") });
  });
  app.post("/app/settings/calendar-sync/microsoft/disconnect", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { user } = sessions.get(req)!;
    z.object({ confirm: z.literal("disconnect") }).parse(req.body);
    await withSyncAccount(user.id, async () => {
      await db.delete(schema.calendarSyncLogins).where(eq(schema.calendarSyncLogins.userId, user.id));
      await db.delete(schema.calendarSyncAccounts).where(eq(schema.calendarSyncAccounts.userId, user.id));
    });
    return redirectWithFlash(reply, ROOT, { success: tForRequest(req)("calendarSync.disconnected") });
  });
}
function fingerprint(sid: string): string { return createHash("sha256").update(sid).digest("hex"); }
