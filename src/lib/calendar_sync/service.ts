import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { synchronize } from "./engine.js";
import { ByWaveCalendar } from "./bywave.js";
import { MicrosoftClient, MicrosoftError, refreshMicrosoftLogin } from "./microsoft.js";
import { openToken, sealToken } from "./secrets.js";
import { stateSchema, SyncUnavailableError } from "./model.js";

type Account = typeof schema.calendarSyncAccounts.$inferSelect;
export async function withSyncAccount<T>(userId: string, work: (account: Account, heartbeat: () => Promise<void>) => Promise<T>): Promise<T> {
  const lease = randomUUID(), now = new Date();
  const [account] = await db.update(schema.calendarSyncAccounts).set({ lease, leaseUntil: new Date(now.getTime() + 120_000) })
    .where(and(eq(schema.calendarSyncAccounts.userId, userId), or(isNull(schema.calendarSyncAccounts.leaseUntil), lte(schema.calendarSyncAccounts.leaseUntil, now)))).returning();
  if (!account) throw new SyncUnavailableError("sync_busy");
  const heartbeat = async () => {
    const [user] = await db.select({ disabledAt: schema.users.disabledAt }).from(schema.users).where(eq(schema.users.id, userId));
    if (!user || user.disabledAt) throw new SyncUnavailableError("account_disabled");
    const rows = await db.update(schema.calendarSyncAccounts).set({ leaseUntil: new Date(Date.now() + 120_000) })
      .where(and(eq(schema.calendarSyncAccounts.userId, userId), eq(schema.calendarSyncAccounts.lease, lease))).returning({ id: schema.calendarSyncAccounts.userId });
    if (!rows.length) throw new SyncUnavailableError("sync_lease_lost");
  };
  try { await heartbeat(); return await work(account, heartbeat); }
  finally {
    await db.update(schema.calendarSyncAccounts).set({ lease: null, leaseUntil: null })
      .where(and(eq(schema.calendarSyncAccounts.userId, userId), eq(schema.calendarSyncAccounts.lease, lease)));
  }
}
export async function microsoftFor(account: Account, heartbeat: () => Promise<void>): Promise<MicrosoftClient> {
  await heartbeat();
  const tokens = await refreshMicrosoftLogin(account.clientId, openToken(account.userId, account.refreshToken));
  if (tokens.refresh_token) {
    await heartbeat();
    await db.update(schema.calendarSyncAccounts).set({ refreshToken: sealToken(account.userId, tokens.refresh_token) })
      .where(and(eq(schema.calendarSyncAccounts.userId, account.userId), eq(schema.calendarSyncAccounts.lease, account.lease!)));
  }
  return new MicrosoftClient(tokens.access_token, async (input, init) => { await heartbeat(); return fetch(input, init); });
}
export function syncError(error: unknown): string {
  if (error instanceof SyncUnavailableError) return error.code;
  return "sync_unavailable";
}
export async function syncAccount(userId: string): Promise<void> {
  await withSyncAccount(userId, async (account, heartbeat) => {
    const pairs = await db.select().from(schema.calendarSyncPairs).where(and(eq(schema.calendarSyncPairs.userId, userId), eq(schema.calendarSyncPairs.enabled, true), lte(schema.calendarSyncPairs.nextRunAt, new Date()))).orderBy(asc(schema.calendarSyncPairs.nextRunAt));
    if (!pairs.length) return;
    let microsoft: MicrosoftClient;
    try { microsoft = await microsoftFor(account, heartbeat); }
    catch (e) {
      await db.update(schema.calendarSyncPairs).set({ error: syncError(e), nextRunAt: new Date(Date.now() + 300_000) }).where(eq(schema.calendarSyncPairs.userId, userId));
      return;
    }
    const from = new Date(Date.now() - 90 * 86400_000), to = new Date(Date.now() + 365 * 86400_000);
    for (const pair of pairs) {
      try {
        await heartbeat();
        const pairHeartbeat = async () => {
          await heartbeat();
          const [active] = await db.select({ id: schema.calendarSyncPairs.id }).from(schema.calendarSyncPairs)
            .innerJoin(schema.calendars, eq(schema.calendars.id, schema.calendarSyncPairs.calendarId))
            .where(and(eq(schema.calendarSyncPairs.id, pair.id), eq(schema.calendarSyncPairs.userId, userId),
              eq(schema.calendarSyncPairs.enabled, true), eq(schema.calendars.ownerId, userId)));
          if (!active) throw new SyncUnavailableError("calendar_unavailable");
        };
        const state = stateSchema.parse(pair.state);
        const left = new ByWaveCalendar(userId, pair.calendarId, pair.id, from, to);
        const right = {
          findOrigin: (origin: string) => microsoft.findOrigin(pair.remoteId, origin),
          snapshot: (tracked: string[]) => microsoft.snapshot(pair.remoteId, from.toISOString(), to.toISOString(), tracked),
          save: (content: Parameters<MicrosoftClient["save"]>[1], current?: Parameters<MicrosoftClient["save"]>[2], origin?: string) => microsoft.save(pair.remoteId, content, current, origin),
          remove: (item: Parameters<MicrosoftClient["remove"]>[1]) => microsoft.remove(pair.remoteId, item),
        };
        const conflicts = await synchronize(pair.id, state, left, right, async value => {
          await pairHeartbeat();
          await db.update(schema.calendarSyncPairs).set({ state: value }).where(and(eq(schema.calendarSyncPairs.id, pair.id), eq(schema.calendarSyncPairs.userId, userId)));
        }, pairHeartbeat);
        await db.update(schema.calendarSyncPairs).set({ conflicts, error: null, lastSyncedAt: new Date(), nextRunAt: new Date(Date.now() + 60_000) }).where(eq(schema.calendarSyncPairs.id, pair.id));
      } catch (e) {
        if (syncError(e) === "sync_lease_lost" || syncError(e) === "account_disabled") throw e;
        await db.update(schema.calendarSyncPairs).set({ error: syncError(e), nextRunAt: new Date(Date.now() + (e instanceof MicrosoftError ? e.retryAfter : 60) * 1000) }).where(eq(schema.calendarSyncPairs.id, pair.id));
      }
    }
  });
}
export function startCalendarSyncScheduler(warn: (message: string) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await db.select({ userId: schema.calendarSyncPairs.userId }).from(schema.calendarSyncPairs)
        .where(and(eq(schema.calendarSyncPairs.enabled, true), lte(schema.calendarSyncPairs.nextRunAt, new Date())))
        .orderBy(asc(schema.calendarSyncPairs.nextRunAt)).limit(50);
      for (const id of new Set(due.map(x => x.userId))) {
        try { await syncAccount(id); } catch (e) { if (syncError(e) !== "sync_busy") warn("[calendar-sync] " + syncError(e)); }
      }
      await db.delete(schema.calendarSyncLogins).where(lte(schema.calendarSyncLogins.expiresAt, new Date()));
    } catch { warn("[calendar-sync] scheduler_unavailable"); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
