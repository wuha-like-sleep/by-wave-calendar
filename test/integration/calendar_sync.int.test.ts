import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/db/client.js", async () => { const h = await import("./harness.js"); return { db: h.db, schema: h.schema }; });
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { db, schema, ensureSchema, resetDb, makeUser, makeCalendar, makeEvent, loginAs } from "./harness.js";
process.env.PUBLIC_BASE_URL = "https://calendar.example";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { ByWaveCalendar } = await import("../../src/lib/calendar_sync/bywave.js");
const { withSyncAccount } = await import("../../src/lib/calendar_sync/service.js");
const { sealToken, openToken } = await import("../../src/lib/calendar_sync/secrets.js");
const { calendarSyncRoutes } = await import("../../src/web/calendar_sync.js");
const { emptyState } = await import("../../src/lib/calendar_sync/model.js");
const { getSettings, reloadSettings } = await import("../../src/lib/site_settings.js");
const ROOT = "/app/settings/calendar-sync";
const from = new Date("2026-01-01"), to = new Date("2027-04-01");
let app: FastifyInstance, uid: string, calendarId: string, sid: string;
const pages: JSDOM[] = [];
beforeAll(async () => {
  await ensureSchema();
  app = Fastify(); await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" }); await app.register(formbody);
  await app.register(view, { engine: { ejs }, root: path.resolve("src/views"), defaultContext: { t: (key: string) => key } });
  await app.register(calendarSyncRoutes); await app.ready();
});
afterAll(async () => app.close());
afterEach(() => { vi.restoreAllMocks(); for (const page of pages.splice(0)) page.window.close(); });
beforeEach(async () => {
  await resetDb(); reloadSettings(); await getSettings();
  const user = await makeUser("owner@example.com"); uid = user.id; calendarId = (await makeCalendar(uid)).id; sid = await loginAs(app, uid);
});
const adapter = () => new ByWaveCalendar(uid, calendarId, "pair", from, to);
async function account() {
  await db.insert(schema.calendarSyncAccounts).values({ userId: uid, accountId: "microsoft", label: "outlook@example.com", clientId: "00000000-0000-4000-a000-000000000000", refreshToken: sealToken(uid, "refresh-secret") });
}
async function csrf() {
  const response = await app.inject({ url: ROOT, headers: { cookie: sid } }); expect(response.statusCode, response.body).toBe(200);
  const page = new JSDOM(response.body); pages.push(page);
  return (page.window.document.querySelector('[name="_csrf"]') as HTMLInputElement).value;
}
describe("ByWave adapter", () => {
  it.each([false, true])("normalizes old all-day inclusive ends for native snapshots (recurring=%s) without rewriting stored dates", async recurring => {
    const a = adapter();
    const fixtures = [
      ["2026-06-01T23:59:59.999Z", "2026-06-02T00:00:00.000Z"],
      ["2026-06-02T00:00:00.000Z", "2026-06-02T00:00:00.000Z"],
      ["2026-06-03T23:59:59.000Z", "2026-06-04T00:00:00.000Z"],
      ["2026-06-04T00:00:00.000Z", "2026-06-04T00:00:00.000Z"],
    ];
    for (const [storedEnd, expectedEnd] of fixtures) {
      const row = await makeEvent(calendarId, "all-day-" + storedEnd);
      await db.update(schema.events).set({ startsAt: new Date("2026-06-01T00:00:00Z"), endsAt: new Date(storedEnd!), allDay: true, rrule: recurring ? "FREQ=WEEKLY;COUNT=2" : null }).where(eq(schema.events.id, row.id));
      const items = [...(await a.snapshot([])).values()].filter(item => item.id.startsWith(row.id));
      expect(items).toHaveLength(recurring ? 2 : 1);
      expect(items[0]!.content).toMatchObject({ startsAt: "2026-06-01T00:00:00.000Z", endsAt: expectedEnd, allDay: true });
      if (recurring) expect(new Date(items[1]!.content.endsAt).getTime() - new Date(items[0]!.content.endsAt).getTime()).toBe(7 * 86400000);
      expect((await db.select().from(schema.events).where(eq(schema.events.id, row.id)))[0]!.endsAt.toISOString()).toBe(storedEnd);
    }
  });
  it("imports native source zones and preserves exact existing city and unrelated metadata on round trips", async () => {
    const a = adapter();
    const content = { summary: "Source meeting", description: "", location: "", startsAt: "2026-11-28T13:30:00.000Z", endsAt: "2026-11-28T14:30:00.000Z", allDay: false,
      timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" };
    const created = await a.save(content, undefined, "outlook:zones");
    await db.update(schema.events).set({ extra: { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai", alarms: [{ trigger: "-PT10M", action: "DISPLAY" }], url: "https://example.test/keep" } }).where(eq(schema.events.id, created.id));
    const current = (await a.snapshot([])).get(created.id)!;
    const saved = await a.save({ ...current.content, summary: "Native title edit", timezone: "Australia/Sydney" }, current);
    const stored = (await db.select().from(schema.events).where(eq(schema.events.id, saved.id)))[0]!;
    expect(stored.startsAt.toISOString()).toBe(content.startsAt); expect(stored.endsAt.toISOString()).toBe(content.endsAt);
    expect(stored.extra).toMatchObject({ timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai", alarms: expect.any(Array), url: "https://example.test/keep" });
    const cleared = await a.save({ ...saved.content, endTimezone: null }, saved);
    expect(cleared.content.endTimezone).toBeNull();
    expect((await db.select().from(schema.events).where(eq(schema.events.id, saved.id)))[0]!.extra).not.toHaveProperty("endTimezone");
  });
  it("creates idempotently and preserves metadata on updates", async () => {
    const a = adapter(); const row = await makeEvent(calendarId, "existing");
    await db.update(schema.events).set({ extra: { alarms: [{ action: "DISPLAY", trigger: -600 }], timezone: "Australia/Melbourne" } }).where(eq(schema.events.id, row.id));
    const item = (await a.snapshot([])).get(row.id)!;
    const edited = await a.save({ ...item.content, summary: "Edited" }, item);
    expect(edited.content.summary).toBe("Edited");
    expect((await db.select().from(schema.events).where(eq(schema.events.id, row.id)))[0]!.extra).toMatchObject({ timezone: "Australia/Melbourne", alarms: expect.any(Array) });
    const one = await a.save(item.content, undefined, "outlook:origin"); const two = await a.save(item.content, undefined, "outlook:origin"); expect(one.id).toBe(two.id);
  });
  it("rejects stale writes and deletions", async () => {
    const row = await makeEvent(calendarId, "e"), a = adapter(), old = (await a.snapshot([])).get(row.id)!;
    await db.update(schema.events).set({ summary: "Other editor" }).where(eq(schema.events.id, row.id));
    await expect(a.save({ ...old.content, summary: "Lost update" }, old)).rejects.toThrow("sync_conflict");
    await expect(a.remove(old)).rejects.toThrow("sync_conflict");
    expect((await db.select().from(schema.events).where(eq(schema.events.id, row.id)))[0]!.deletedAt).toBeNull();
  });
  it("resolves tracked events outside the window and soft deletion separately", async () => {
    const row = await makeEvent(calendarId, "e"), a = adapter();
    await db.update(schema.events).set({ startsAt: new Date("2028-01-01"), endsAt: new Date("2028-01-02") }).where(eq(schema.events.id, row.id));
    expect((await a.snapshot([])).size).toBe(0); const tracked = (await a.snapshot([row.id])).get(row.id)!; expect(tracked).toBeDefined();
    await a.remove(tracked); expect((await a.snapshot([row.id])).size).toBe(0);
  });
  it("expands through DST and detaches one occurrence without losing its stable identity", async () => {
    const row = await makeEvent(calendarId, "recurring");
    await db.update(schema.events).set({ startsAt: new Date("2026-03-29T22:00:00Z"), endsAt: new Date("2026-03-29T23:00:00Z"), rrule: "FREQ=WEEKLY;COUNT=3", extra: { timezone: "Australia/Melbourne" } }).where(eq(schema.events.id, row.id));
    const a = adapter(), items = [...(await a.snapshot([])).values()];
    expect(items.map(i => i.content.startsAt)).toEqual(["2026-03-29T22:00:00.000Z", "2026-04-05T23:00:00.000Z", "2026-04-12T23:00:00.000Z"]);
    const edited = await a.save({ ...items[1]!.content, summary: "One exception" }, items[1]); expect(edited.id).toBe(items[1]!.id);
    const after = await a.snapshot(items.map(i => i.id)); expect(after.size).toBe(3); expect(after.get(edited.id)!.content.summary).toBe("One exception");
    await a.remove(after.get(edited.id)!); expect((await a.snapshot(items.map(i => i.id))).size).toBe(2);
  });
  it("rejects malformed recurrence instead of reporting deletions", async () => {
    const row = await makeEvent(calendarId, "bad"); await db.update(schema.events).set({ rrule: "THIS IS NOT A RULE" }).where(eq(schema.events.id, row.id));
    await expect(adapter().snapshot([])).rejects.toThrow("unsupported_recurrence");
  });
  it("deletes a recurring batch from one snapshot without treating its own exclusions as conflicts", async () => {
    const row = await makeEvent(calendarId, "delete-series");
    await db.update(schema.events).set({ startsAt: new Date("2026-06-01T09:00:00Z"), endsAt: new Date("2026-06-01T10:00:00Z"), rrule: "FREQ=DAILY;COUNT=8" }).where(eq(schema.events.id, row.id));
    const a = adapter(), items = [...(await a.snapshot([])).values()];
    expect(items).toHaveLength(8);
    for (const item of items) await a.remove(item);
    expect((await a.snapshot(items.map(i => i.id))).size).toBe(0);
    expect((await db.select().from(schema.events).where(eq(schema.events.id, row.id)))[0]!.exdates).toHaveLength(8);
  });
  it("applies multiple recurring edits and deletions in one pass", async () => {
    const row = await makeEvent(calendarId, "edit-series");
    await db.update(schema.events).set({ startsAt: new Date("2026-06-01T09:00:00Z"), endsAt: new Date("2026-06-01T10:00:00Z"), rrule: "FREQ=DAILY;COUNT=3" }).where(eq(schema.events.id, row.id));
    const a = adapter(), items = [...(await a.snapshot([])).values()];
    await a.save({ ...items[0]!.content, summary: "First exception" }, items[0]);
    await a.remove(items[1]!);
    await a.save({ ...items[2]!.content, summary: "Last exception" }, items[2]);
    const result = await a.snapshot(items.map(i => i.id));
    expect(result.size).toBe(2);
    expect(result.get(items[0]!.id)!.content.summary).toBe("First exception");
    expect(result.get(items[2]!.id)!.content.summary).toBe("Last exception");
  });
  it("still rejects an outside edit between mutations of the same series", async () => {
    const row = await makeEvent(calendarId, "concurrent-series");
    await db.update(schema.events).set({ startsAt: new Date("2026-06-01T09:00:00Z"), endsAt: new Date("2026-06-01T10:00:00Z"), rrule: "FREQ=DAILY;COUNT=3" }).where(eq(schema.events.id, row.id));
    const a = adapter(), items = [...(await a.snapshot([])).values()];
    await a.remove(items[0]!);
    await db.update(schema.events).set({ summary: "Edited on another device" }).where(eq(schema.events.id, row.id));
    await expect(a.remove(items[1]!)).rejects.toThrow("sync_conflict");
    await expect(a.save({ ...items[2]!.content, summary: "Stale edit" }, items[2])).rejects.toThrow("sync_conflict");
    const current = (await db.select().from(schema.events).where(eq(schema.events.id, row.id)))[0]!;
    expect(current.summary).toBe("Edited on another device");
    expect(current.exdates).toHaveLength(1);
  });
  it("never reads another user's calendar", async () => {
    const other = await makeUser("other@example.com");
    await expect(new ByWaveCalendar(other.id, calendarId, "p", from, to).snapshot([])).rejects.toThrow("calendar_unavailable");
  });
});
describe("account security and lease", () => {
  it("encrypts refresh tokens and binds them to the owner", () => {
    const encrypted = sealToken(uid, "secret"); expect(encrypted).not.toContain("secret"); expect(openToken(uid, encrypted)).toBe("secret");
    expect(() => openToken("another-user", encrypted)).toThrow();
    const bytes = Buffer.from(encrypted, "base64url"); bytes[15] = bytes[15]! ^ 1; expect(() => openToken(uid, bytes.toString("base64url"))).toThrow();
  });
  it("prevents two workers from mutating an account and releases on failure", async () => {
    await account();
    await expect(withSyncAccount(uid, async () => {
      await expect(withSyncAccount(uid, async () => {})).rejects.toThrow("sync_busy"); throw new Error("test failure");
    })).rejects.toThrow("test failure");
    await expect(withSyncAccount(uid, async () => "released")).resolves.toBe("released");
  });
  it("invalidates a worker heartbeat after the lease is taken over", async () => {
    await account();
    await withSyncAccount(uid, async (_a, beat) => {
      await db.update(schema.calendarSyncAccounts).set({ lease: "00000000-0000-4000-a000-000000000001" }).where(eq(schema.calendarSyncAccounts.userId, uid));
      await expect(beat()).rejects.toThrow("sync_lease_lost");
    });
  });
});
describe("setup routes", () => {
  it("requires full authentication and CSRF for every write", async () => {
    expect((await app.inject({ url: ROOT })).statusCode).toBe(302);
    for (const action of ["apple-password", "microsoft/start", "microsoft/finish", "microsoft/calendar", "pairs", "pairs/action", "microsoft/disconnect"]) {
      expect((await app.inject({ method: "POST", url: ROOT + "/" + action, headers: { cookie: sid }, payload: {} })).statusCode).toBe(403);
    }
    await db.update(schema.users).set({ mfaEnabled: true }).where(eq(schema.users.id, uid));
    await db.update(schema.sessions).set({ mfaSatisfied: false }).where(eq(schema.sessions.userId, uid));
    expect((await app.inject({ url: ROOT, headers: { cookie: sid } })).statusCode).toBe(302);
  });
  it("keeps the generated password out of redirects and displays it only once", async () => {
    const _csrf = await csrf(); const response = await app.inject({ method: "POST", url: ROOT + "/apple-password", headers: { cookie: sid }, payload: { _csrf } });
    expect(response.statusCode).toBe(302); expect(response.headers.location).toBe(ROOT); expect(response.headers["cache-control"]).toBe("no-store");
    const flash = response.cookies.find(c => c.name === "bwc_flash")!;
    const page = await app.inject({ url: ROOT, headers: { cookie: sid + "; bwc_flash=" + encodeURIComponent(flash.value) } });
    expect(page.body).toMatch(/[A-Z2-9]{8}-[A-Z2-9]{24}/); expect(page.cookies.find(c => c.name === "bwc_flash")!.value).toBe("");
    expect((await app.inject({ url: ROOT, headers: { cookie: sid } })).body).not.toMatch(/[A-Z2-9]{8}-[A-Z2-9]{24}/);
  });
  it("does not let another account pause or resolve a pair", async () => {
    await account(); const [pair] = await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "remote", remoteName: "Remote", state: emptyState() }).returning();
    const owner = uid; const other = await makeUser("other@example.com"); uid = other.id; sid = await loginAs(app, uid); await account();
    const _csrf = await csrf();
    await app.inject({ method: "POST", url: ROOT + "/pairs/action", headers: { cookie: sid }, payload: { _csrf, id: pair!.id, action: "pause" } });
    const [unchanged] = await db.select().from(schema.calendarSyncPairs).where(eq(schema.calendarSyncPairs.userId, owner)); expect(unchanged!.enabled).toBe(true);
  });
  it("disconnect removes credentials and mappings while retaining calendar events", async () => {
    const _csrf = await csrf(); await account(); const row = await makeEvent(calendarId, "kept");
    await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "remote", remoteName: "Remote", state: emptyState() });
    await app.inject({ method: "POST", url: ROOT + "/microsoft/disconnect", headers: { cookie: sid }, payload: { _csrf, confirm: "disconnect" } });
    expect(await db.select().from(schema.calendarSyncAccounts)).toHaveLength(0); expect(await db.select().from(schema.calendarSyncPairs)).toHaveLength(0);
    expect((await db.select().from(schema.events).where(eq(schema.events.id, row.id)))[0]!.deletedAt).toBeNull();
  });
});

describe("Microsoft authorization and worker", () => {
  const graphEvent = (id: string, summary: string) => ({ id, changeKey: "v1", "@odata.etag": 'W/"v1"', subject: summary,
    body: { contentType: "text", content: "" }, location: { displayName: "" },
    start: { dateTime: new Date(Date.now() + 3600_000).toISOString().replace("Z", ""), timeZone: "UTC" },
    end: { dateTime: new Date(Date.now() + 7200_000).toISOString().replace("Z", ""), timeZone: "UTC" }, isAllDay: false });
  it("keeps device codes and refresh tokens server-side and binds authorization to the initiating session", async () => {
    const { env } = await import("../../src/env.js"); const old = env.MICROSOFT_CALENDAR_CLIENT_ID;
    env.MICROSOFT_CALENDAR_CLIENT_ID = "00000000-0000-4000-a000-000000000000";
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/devicecode')) return Response.json({ device_code: "private-device-code", user_code: "PUBLIC-CODE", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 });
      if (url.includes('/token')) return Response.json({ access_token: "private-access-token", refresh_token: "private-refresh-token", expires_in: 3600 });
      if (url.includes('/me?')) return Response.json({ id: "microsoft-user", mail: "connected@example.com" });
      return Response.json({ value: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const _csrf = await csrf();
      await app.inject({ method: "POST", url: ROOT + "/microsoft/start", headers: { cookie: sid }, payload: { _csrf } });
      const [pending] = await db.select().from(schema.calendarSyncLogins); expect(pending!.deviceCode).not.toContain("private-device-code");
      const page = await app.inject({ url: ROOT, headers: { cookie: sid } }); expect(page.body).toContain("PUBLIC-CODE"); expect(page.body).not.toContain("private-device-code");
      const originalSession = sid; sid = await loginAs(app, uid); const otherCsrf = await csrf();
      await db.update(schema.calendarSyncLogins).set({ nextPollAt: new Date(0) });
      await app.inject({ method: "POST", url: ROOT + "/microsoft/finish", headers: { cookie: sid }, payload: { _csrf: otherCsrf } });
      expect(fetcher.mock.calls.filter(c => String(c[0]).endsWith('/token'))).toHaveLength(0);
      sid = originalSession;
      await app.inject({ method: "POST", url: ROOT + "/microsoft/finish", headers: { cookie: sid }, payload: { _csrf } });
      const [connected] = await db.select().from(schema.calendarSyncAccounts);
      expect(connected!.accountId).toBe("microsoft-user"); expect(connected!.refreshToken).not.toContain("private-refresh-token"); expect(openToken(uid, connected!.refreshToken)).toBe("private-refresh-token");
      expect(await db.select().from(schema.calendarSyncLogins)).toHaveLength(0);
    } finally { env.MICROSOFT_CALENDAR_CLIENT_ID = old; vi.unstubAllGlobals(); }
  });
  it("runs a real database sync, rotates encrypted refresh tokens and stops on revoked calendar access", async () => {
    const { syncAccount } = await import("../../src/lib/calendar_sync/service.js");
    await account(); const [pair] = await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "remote", remoteName: "Remote", state: emptyState() }).returning();
    let revoked = false; const remote = graphEvent("outlook-event", "From Outlook");
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/token')) return Response.json({ access_token: "access", refresh_token: "rotated-refresh", expires_in: 3600 });
      if (revoked) return new Response(null, { status: 404 });
      if (url.includes('/calendarView')) return Response.json({ value: [remote] });
      return Response.json({ canEdit: true });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      await syncAccount(uid);
      const [event] = await db.select().from(schema.events); expect(event!.summary).toBe("From Outlook");
      const [synced] = await db.select().from(schema.calendarSyncPairs); expect(synced!.lastSyncedAt).not.toBeNull(); expect((synced!.state as { links: unknown[] }).links).toHaveLength(1);
      const [connected] = await db.select().from(schema.calendarSyncAccounts); expect(openToken(uid, connected!.refreshToken)).toBe("rotated-refresh");
      revoked = true; await db.update(schema.calendarSyncPairs).set({ nextRunAt: new Date(0) }).where(eq(schema.calendarSyncPairs.id, pair!.id));
      await syncAccount(uid);
      expect((await db.select().from(schema.events))[0]!.deletedAt).toBeNull(); expect((await db.select().from(schema.calendarSyncPairs))[0]!.error).not.toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
  it("queues committed deletions immediately while preserving pauses and Microsoft backoff", async () => {
    const { cancelEvent } = await import("../../src/lib/event_cancel.js");
    const { requestCalendarSync } = await import("../../src/lib/calendar_sync/queue.js");
    await account();
    const later = new Date(Date.now() + 300_000);
    const [pair] = await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "remote", remoteName: "Remote", state: emptyState(), nextRunAt: later }).returning();
    const event = await makeEvent(calendarId, "Delete now");
    await cancelEvent(event.id, { id: uid, email: "owner@example.com", displayName: null });
    let current = (await db.select().from(schema.calendarSyncPairs))[0]!;
    expect(current.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now()); expect(current.requestVersion).toBe(1);
    await cancelEvent(event.id, { id: uid, email: "owner@example.com", displayName: null });
    expect((await db.select().from(schema.calendarSyncPairs))[0]!.requestVersion).toBe(1);
    await db.update(schema.calendarSyncPairs).set({ enabled: false, nextRunAt: later }).where(eq(schema.calendarSyncPairs.id, pair!.id));
    await requestCalendarSync(calendarId); current = (await db.select().from(schema.calendarSyncPairs))[0]!;
    expect(current.nextRunAt).toEqual(later); expect(current.enabled).toBe(false);
    await db.update(schema.calendarSyncPairs).set({ enabled: true, error: "rate_limited" }).where(eq(schema.calendarSyncPairs.id, pair!.id));
    await requestCalendarSync(calendarId); current = (await db.select().from(schema.calendarSyncPairs))[0]!;
    expect(current.nextRunAt).toEqual(later); expect(current.requestVersion).toBe(1);
  });
  it("retries a concurrent deletion revision promptly while honoring Microsoft's throttle", async () => {
    const { syncAccount } = await import("../../src/lib/calendar_sync/service.js");
    const { SyncConflictError } = await import("../../src/lib/calendar_sync/model.js");
    await account(); const row = await makeEvent(calendarId, "race");
    const item = (await adapter().snapshot([row.id])).get(row.id)!;
    await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "remote", remoteName: "Remote",
      state: { ...emptyState(), links: [{ leftId: row.id, rightId: "gone", base: item.content }] } });
    let throttled = false;
    vi.spyOn(ByWaveCalendar.prototype, "remove").mockRejectedValue(new SyncConflictError());
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith("/token")) return Response.json({ access_token: "access", expires_in: 3600 });
      if (throttled) return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
      if (url.includes("/calendarView")) return Response.json({ value: [] });
      if (url.includes("/events/")) return new Response(null, { status: 404 });
      return Response.json({ canEdit: true });
    }));
    try {
      const before = Date.now(); await syncAccount(uid);
      let pair = (await db.select().from(schema.calendarSyncPairs))[0]!;
      expect(pair.error).toBe("calendar_changed_retry");
      expect(pair.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 2_000);
      expect(pair.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
      throttled = true; await db.update(schema.calendarSyncPairs).set({ nextRunAt: new Date(0) });
      const throttleAt = Date.now(); await syncAccount(uid);
      pair = (await db.select().from(schema.calendarSyncPairs))[0]!;
      expect(pair.nextRunAt.getTime()).toBeGreaterThanOrEqual(throttleAt + 120_000);
      expect((await db.select().from(schema.events).where(eq(schema.events.id, row.id)))[0]!.deletedAt).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
  it("selects due accounts without processing leased or disabled accounts", async () => {
    const { startCalendarSyncScheduler } = await import("../../src/lib/calendar_sync/service.js");
    await account();
    await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "ready", remoteName: "Ready", state: emptyState() });
    for (const kind of ["leased", "disabled"]) {
      const other = await makeUser(kind + "@example.com"), cal = await makeCalendar(other.id);
      if (kind === "disabled") await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, other.id));
      await db.insert(schema.calendarSyncAccounts).values({ userId: other.id, accountId: kind, label: kind,
        clientId: "00000000-0000-4000-a000-000000000000", refreshToken: sealToken(other.id, "refresh-secret"),
        ...(kind === "leased" ? { lease: "00000000-0000-4000-a000-000000000001", leaseUntil: new Date(Date.now() + 120_000) } : {}) });
      await db.insert(schema.calendarSyncPairs).values({ userId: other.id, calendarId: cal.id, remoteId: kind, remoteName: kind, state: emptyState() });
    }
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith("/token")) return Response.json({ access_token: "access", expires_in: 3600 });
      return Response.json(url.includes("/calendarView") ? { value: [] } : { canEdit: true });
    });
    vi.stubGlobal("fetch", fetcher);
    const warn = vi.fn(), stop = startCalendarSyncScheduler(warn);
    try {
      await vi.waitFor(async () => {
        const pair = (await db.select().from(schema.calendarSyncPairs).where(eq(schema.calendarSyncPairs.userId, uid)))[0]!;
        expect(pair.lastSyncedAt).not.toBeNull();
        expect((await db.select().from(schema.calendarSyncAccounts).where(eq(schema.calendarSyncAccounts.userId, uid)))[0]!.lease).toBeNull();
      });
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      expect((await db.select().from(schema.calendarSyncPairs)).filter(p => p.userId !== uid).every(p => p.lastSyncedAt === null)).toBe(true);
    } finally { stop(); vi.unstubAllGlobals(); }
  });
  it("does not let an expired token-refresh worker overwrite the new lease owner's status", async () => {
    const { syncAccount } = await import("../../src/lib/calendar_sync/service.js");
    await account();
    const [pair] = await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "remote", remoteName: "Remote", state: emptyState() }).returning();
    const winnerNextRun = new Date(Date.now() + 30_000);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      await db.update(schema.calendarSyncAccounts).set({ lease: "00000000-0000-4000-a000-000000000099" }).where(eq(schema.calendarSyncAccounts.userId, uid));
      await db.update(schema.calendarSyncPairs).set({ nextRunAt: winnerNextRun, error: null, lastSyncedAt: new Date() }).where(eq(schema.calendarSyncPairs.id, pair!.id));
      return Response.json({ access_token: "access", refresh_token: "rotated", expires_in: 3600 });
    }));
    try {
      await expect(syncAccount(uid)).rejects.toThrow("sync_lease_lost");
      const current = (await db.select().from(schema.calendarSyncPairs))[0]!;
      expect(current.nextRunAt).toEqual(winnerNextRun); expect(current.error).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not overwrite a deletion queued while an older snapshot is syncing", async () => {
    const { syncAccount } = await import("../../src/lib/calendar_sync/service.js");
    const { requestCalendarSync } = await import("../../src/lib/calendar_sync/queue.js");
    await account();
    await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "remote", remoteName: "Remote", state: emptyState() });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/token')) return Response.json({ access_token: "access", expires_in: 3600 });
      if (url.includes('/calendarView')) { await requestCalendarSync(calendarId); return Response.json({ value: [] }); }
      return Response.json({ canEdit: true });
    }));
    try {
      await syncAccount(uid);
      const current = (await db.select().from(schema.calendarSyncPairs))[0]!;
      expect(current.requestVersion).toBe(1); expect(current.error).toBeNull(); expect(current.lastSyncedAt).not.toBeNull();
      expect(current.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    } finally { vi.unstubAllGlobals(); }
  });
  it("restoring a backup retains sync mappings but pauses all external writes", async () => {
    const { exportData, importData } = await import("../../src/lib/backup.js");
    await account(); await db.insert(schema.calendarSyncPairs).values({ userId: uid, calendarId, remoteId: "remote", remoteName: "Remote", state: emptyState() });
    const bundle = await exportData(); await importData(JSON.parse(JSON.stringify(bundle)));
    const [pair] = await db.select().from(schema.calendarSyncPairs); expect(pair!.enabled).toBe(false); expect(pair!.remoteId).toBe("remote");
    const [connection] = await db.select().from(schema.calendarSyncAccounts); expect(connection!.lease).toBeNull(); expect(openToken(uid, connection!.refreshToken)).toBe("refresh-secret");
  });
});
