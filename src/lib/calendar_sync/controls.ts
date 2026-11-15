import { wakeCalendarSync } from "./queue.js";
import { createHash } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../../db/client.js";
import { emptyState, stateSchema, SyncUnavailableError, type Conflict } from "./model.js";
import { MicrosoftClient, MicrosoftError, pollMicrosoftLogin, startMicrosoftLogin } from "./microsoft.js";
import { openToken, sealToken } from "./secrets.js";
import { microsoftFor, withSyncAccount } from "./service.js";

import { getMicrosoftCalendarConfig } from "./config.js";

export async function startCalendarLogin(userId: string, binding: string) {
    const { clientId } = await getMicrosoftCalendarConfig();
    if (!clientId) throw new SyncUnavailableError("microsoft_not_configured");
    const result = await startMicrosoftLogin(clientId);
    const data = { userId: userId, sessionHash: fingerprint(binding), clientId,
      deviceCode: sealToken("login:" + userId, result.device_code), userCode: result.user_code,
      verificationUri: result.verification_uri, interval: Math.ceil(result.interval),
      expiresAt: new Date(Date.now() + result.expires_in * 1000), nextPollAt: new Date(Date.now() + result.interval * 1000) };
    await db.insert(schema.calendarSyncLogins).values(data).onConflictDoUpdate({ target: schema.calendarSyncLogins.userId, set: data });
}

export async function finishCalendarLogin(userId: string, binding: string) {
    const now = new Date();
    // Claim a poll across workers. Device codes never enter HTML, logs or URLs.
    const [login] = await db.update(schema.calendarSyncLogins).set({ nextPollAt: new Date(Date.now() + 30_000) })
      .where(and(eq(schema.calendarSyncLogins.userId, userId), eq(schema.calendarSyncLogins.sessionHash, fingerprint(binding)), gt(schema.calendarSyncLogins.expiresAt, now), lte(schema.calendarSyncLogins.nextPollAt, now))).returning();
    if (!login) throw new SyncUnavailableError("authorization_pending");
    const sameLogin = and(eq(schema.calendarSyncLogins.userId, userId), eq(schema.calendarSyncLogins.deviceCode, login.deviceCode));
    try {
      const tokens = await pollMicrosoftLogin(login.clientId, openToken("login:" + userId, login.deviceCode));
      if (!tokens.refresh_token) throw new SyncUnavailableError("microsoft_reconnect");
      const account = await new MicrosoftClient(tokens.access_token).account();
      const values = { userId: userId, accountId: account.id, label: account.mail || account.userPrincipalName || account.displayName || "Microsoft", clientId: login.clientId, refreshToken: sealToken(userId, tokens.refresh_token) };
      // Keep existing mappings on reconnect; silently switching Microsoft accounts
      // would otherwise interpret every old remote event as a deletion.
      await db.transaction(async tx => {
        const [active] = await tx.select().from(schema.calendarSyncLogins).where(sameLogin).for("update");
        if (!active || active.expiresAt <= new Date()) throw new SyncUnavailableError("expired_token");
        const [existing] = await tx.select().from(schema.calendarSyncAccounts).where(eq(schema.calendarSyncAccounts.userId, userId)).for("update");
        if (existing && existing.accountId !== account.id) throw new SyncUnavailableError("account_mismatch");
        if (existing?.leaseUntil && existing.leaseUntil > new Date()) throw new SyncUnavailableError("sync_busy");
        if (existing) await tx.update(schema.calendarSyncAccounts).set(values).where(eq(schema.calendarSyncAccounts.userId, userId));
        else await tx.insert(schema.calendarSyncAccounts).values(values);
      });
      await db.delete(schema.calendarSyncLogins).where(sameLogin);
      return;
    } catch (e) {
      if (e instanceof MicrosoftError && ["authorization_pending", "slow_down"].includes(e.code)) {
        const interval = login.interval + (e.code === "slow_down" ? 5 : 0);
        await db.update(schema.calendarSyncLogins).set({ interval, nextPollAt: new Date(Date.now() + interval * 1000) }).where(sameLogin);
      } else await db.delete(schema.calendarSyncLogins).where(sameLogin);
      throw e;
    }
}

export async function createOutlookCalendar(userId: string) {
    await withSyncAccount(userId, async (a, beat) => (await microsoftFor(a, beat)).createCalendar("ByWave Calendar"));
}

export async function createCalendarPair(userId: string, input: unknown) {
    const body = z.object({ calendarId: z.string().uuid(), remoteId: z.string().min(1).max(2048) }).parse(input);
    await withSyncAccount(userId, async (a, beat) => {
      const [calendar] = await db.select().from(schema.calendars).where(and(eq(schema.calendars.id, body.calendarId), eq(schema.calendars.ownerId, userId)));
      if (!calendar) throw new SyncUnavailableError("calendar_unavailable");
      const current = await db.select().from(schema.calendarSyncPairs).where(eq(schema.calendarSyncPairs.userId, userId));
      if (current.length >= 10) throw new SyncUnavailableError("calendar_limit");
      const remote = (await (await microsoftFor(a, beat)).calendars()).find(c => c.id === body.remoteId);
      if (!remote || current.some(p => p.calendarId === calendar.id || p.remoteId === remote.id)) throw new SyncUnavailableError("calendar_unavailable");
      await db.insert(schema.calendarSyncPairs).values({ userId: userId, calendarId: calendar.id, remoteId: remote.id, remoteName: remote.name, state: emptyState() });
    });
    wakeCalendarSync();
}

export async function updateCalendarPair(userId: string, input: unknown) {
    const body = z.object({ id: z.string().uuid(), action: z.enum(["pause", "resume", "sync", "resolve"]), key: z.string().max(2048).optional(), side: z.enum(["left", "right"]).optional(), leftRevision: z.string().max(2048).optional(), rightRevision: z.string().max(2048).optional() }).parse(input);
    await withSyncAccount(userId, async () => {
      const [pair] = await db.select().from(schema.calendarSyncPairs).where(and(eq(schema.calendarSyncPairs.id, body.id), eq(schema.calendarSyncPairs.userId, userId)));
      if (!pair) throw new SyncUnavailableError("calendar_unavailable");
      const update: Partial<typeof schema.calendarSyncPairs.$inferInsert> = { nextRunAt: new Date() };
      if (body.action === "pause") update.enabled = false;
      if (body.action === "resume") update.enabled = true;
      if (body.action === "resolve") {
        const conflict = (pair.conflicts as Conflict[]).find(c => c.key === body.key);
        if (!conflict || !body.side || body.leftRevision !== (conflict.left?.revision ?? "") || body.rightRevision !== (conflict.right?.revision ?? "")) throw new SyncUnavailableError("calendar_changed_retry");
        const state = stateSchema.parse(pair.state);
        state.resolutions[conflict.key] = { side: body.side, leftRevision: conflict.left?.revision ?? null, rightRevision: conflict.right?.revision ?? null };
        update.state = state;
      }
      await db.update(schema.calendarSyncPairs).set(update).where(eq(schema.calendarSyncPairs.id, pair.id));
    });
    wakeCalendarSync();
}

export async function disconnectOutlook(userId: string) {
    await withSyncAccount(userId, async () => {
      await db.delete(schema.calendarSyncLogins).where(eq(schema.calendarSyncLogins.userId, userId));
      await db.delete(schema.calendarSyncAccounts).where(eq(schema.calendarSyncAccounts.userId, userId));
    });
}

export function fingerprint(binding: string): string { return createHash("sha256").update(binding).digest("hex"); }
