import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/db/client.js", async () => { const h = await import("./harness.js"); return { db: h.db, schema: h.schema }; });
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { eq } from "drizzle-orm";
import { db, schema, ensureSchema, resetDb, makeUser, loginAs } from "./harness.js";
// CalDAV credential provisioning requires HTTPS, regardless of the outer test runner environment.
process.env.PUBLIC_BASE_URL = "https://calendar.test";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { nativeCalendarSyncRoutes } = await import("../../src/routes/calendar_sync.js");
const { caldavRoutes } = await import("../../src/web/caldav.js");
const { invalidateCalDavAuthCache } = await import("../../src/lib/caldav_auth.js");
const { signAccessToken } = await import("../../src/lib/device_tokens.js");
const { reloadSettings } = await import("../../src/lib/site_settings.js");
const { sealToken } = await import("../../src/lib/calendar_sync/secrets.js");
const { emptyState } = await import("../../src/lib/calendar_sync/model.js");
const ROOT = "/api/v1/calendar-sync", CLIENT = "12345678-1234-4123-a123-123456789abc";
let app: FastifyInstance, userId: string, deviceId: string, token: string, otherToken: string, secondToken: string, calendarId: string;
beforeAll(async () => { await ensureSchema(); app = Fastify(); app.addHttpMethod("PROPFIND", { hasBody: true }); app.addHttpMethod("REPORT", { hasBody: true }); app.addContentTypeParser("text/calendar", { parseAs: "string" }, (_req, body, done) => done(null, body)); await app.register(caldavRoutes); await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" }); await app.register(nativeCalendarSyncRoutes, { prefix: "/api/v1" }); await app.register(eventRoutes, { prefix: "/api/v1" }); await app.ready(); });
afterAll(async () => { await app?.close(); });
afterEach(() => vi.unstubAllGlobals());
async function device(uid: string) {
  const [d] = await db.insert(schema.devices).values({ userId: uid, label: "Native test", kind: "desktop", refreshTokenHash: "unused", refreshTokenPrefix: "unused" }).returning();
  return { id: d!.id, token: signAccessToken(uid, d!.id).token };
}
beforeEach(async () => {
  await resetDb(); invalidateCalDavAuthCache(); await db.insert(schema.siteSettings).values({ id: 1, appsEnabled: true, microsoftCalendarClientId: CLIENT }); reloadSettings();
  userId = (await makeUser("owner@example.com")).id;
  const d = await device(userId); token = d.token; deviceId = d.id;
  secondToken = (await device(userId)).token; otherToken = (await device((await makeUser("other@example.com")).id)).token;
  const [calendar] = await db.insert(schema.calendars).values({ ownerId: userId, name: "Private plans" }).returning(); calendarId = calendar!.id;
});
function get(auth = token, suffix = "?remote=0") { return app.inject({ url: ROOT + suffix, headers: { authorization: "Bearer " + auth } }); }
function post(body: object, auth = token) { return app.inject({ method: "POST", url: ROOT + "/action", headers: { authorization: "Bearer " + auth }, payload: body }); }
async function connected() {
  await db.insert(schema.calendarSyncAccounts).values({ userId, clientId: CLIENT, accountId: "microsoft-id", label: "Outlook account", refreshToken: sealToken(userId, "private-refresh") });
  const [pair] = await db.insert(schema.calendarSyncPairs).values({ userId, calendarId, remoteId: "remote-calendar", remoteName: "Outlook plans", state: emptyState() }).returning(); return pair!;
}
function graph() {
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.includes("/devicecode")) return Response.json({ device_code: "private-device-code", user_code: "VISIBLE-CODE", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 });
    if (url.includes("/token")) return Response.json({ access_token: "private-access", refresh_token: "new-private-refresh", expires_in: 3600 });
    if (url.includes("/me/calendars")) return Response.json({ value: [{ id: "remote-calendar", name: "Outlook plans", canEdit: true }, { id: "read-only", name: "Read only", canEdit: false }] });
    return Response.json({ id: "microsoft-id", mail: "outlook@example.com" });
  }); vi.stubGlobal("fetch", fetcher); return fetcher;
}
describe("native calendar controls", () => {
  it("rejects stale conflict decisions instead of applying a newly changed deletion", async () => {
    const pair = await connected();
    const content = { summary: "Changed elsewhere", description: "", location: "", startsAt: "2026-11-15T10:00:00.000Z", endsAt: "2026-11-15T11:00:00.000Z", allDay: false };
    const conflict = { key: "event", left: null, right: { id: "remote", revision: "new-revision", content } };
    await db.update(schema.calendarSyncPairs).set({ conflicts: [conflict] }).where(eq(schema.calendarSyncPairs.id, pair.id));
    for (const rightRevision of [undefined, "old-revision"]) {
      const response = await post({ action: "resolve", id: pair.id, key: "event", side: "left", leftRevision: "", rightRevision });
      expect(response.statusCode).toBe(409);
    }
    expect((await post({ action: "resolve", id: pair.id, key: "event", side: "left", leftRevision: "", rightRevision: "new-revision" })).statusCode).toBe(200);
    const current = (await db.select().from(schema.calendarSyncPairs))[0]!;
    expect(current.state).toMatchObject({ resolutions: { event: { side: "left", leftRevision: null, rightRevision: "new-revision" } } });
  });
  it.each(["series", "instance", "future"])("queues %s deletions from an authenticated app immediately", async scope => {
    const pair = await connected();
    await db.update(schema.calendarSyncPairs).set({ nextRunAt: new Date(Date.now() + 60_000) }).where(eq(schema.calendarSyncPairs.id, pair.id));
    const [event] = await db.insert(schema.events).values({ calendarId, uid: "delete-from-app", summary: "Daily", startsAt: new Date("2026-11-15T10:00:00Z"), endsAt: new Date("2026-11-15T11:00:00Z"), rrule: "FREQ=DAILY;COUNT=5" }).returning();
    const response = await app.inject({ method: "DELETE", url: "/api/v1/events/" + event!.id + "?scope=" + scope + "&recurrenceId=2026-11-16T10%3A00%3A00Z", headers: { authorization: "Bearer " + token } });
    expect(response.statusCode, response.body).toBe(204);
    const current = (await db.select().from(schema.calendarSyncPairs))[0]!;
    expect(current.requestVersion).toBe(1); expect(current.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    const stored = (await db.select().from(schema.events))[0]!;
    expect(stored.deletedAt !== null).toBe(scope === "series");
    if (scope === "instance") expect(stored.exdates).toEqual(["2026-11-16T10:00:00.000Z"]);
    if (scope === "future") expect(stored.rrule).toContain("UNTIL=20261116T095959Z");
  });

  it("requires an active paired device, rejects ambient cookies, revoked devices and disabled apps", async () => {
    expect((await app.inject({ url: ROOT })).statusCode).toBe(401);
    const session = await loginAs(app, userId);
    expect((await app.inject({ url: ROOT, headers: { cookie: session } })).statusCode).toBe(403);
    await db.update(schema.devices).set({ revokedAt: new Date() }).where(eq(schema.devices.id, deviceId)); expect((await get()).statusCode).toBe(401);
    await db.update(schema.siteSettings).set({ appsEnabled: false }); reloadSettings(); expect((await get(secondToken)).statusCode).toBe(403);
  });
  it("lists only owned data and excludes synchronization snapshots and credentials", async () => {
    await connected(); const res = await get(); expect(res.statusCode, res.body).toBe(200); expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().data.calendars).toHaveLength(1); expect(res.json().data.pairs[0]).not.toHaveProperty("state");
    for (const secret of ["refreshToken", "private-refresh", "leaseUntil", "sessionHash", "deviceCode"]) expect(res.body).not.toContain(secret);
    const foreign = (await get(otherToken)).json().data; expect(foreign.account).toBeNull(); expect(foreign.calendars).toEqual([]); expect(foreign.pairs).toEqual([]);
  });
  it("binds Microsoft login to the initiating device and observes platform config changes", async () => {
    const fetcher = graph(); expect((await post({ action: "connect" })).statusCode).toBe(200);
    expect((await get()).json().data.login.userCode).toBe("VISIBLE-CODE"); expect((await get(secondToken)).json().data.login).toBeNull();
    await db.update(schema.calendarSyncLogins).set({ nextPollAt: new Date(0) });
    expect((await post({ action: "finish" }, secondToken)).statusCode).toBe(409); expect(fetcher).toHaveBeenCalledTimes(1);
    await post({ action: "cancel" }, secondToken); expect((await get()).json().data.login).not.toBeNull();
    expect((await post({ action: "finish" })).statusCode).toBe(200); expect((await get()).json().data.account.label).toBe("outlook@example.com");
    await db.update(schema.siteSettings).set({ microsoftCalendarClientId: "" });
    expect((await get()).json().data.configured).toBe(false); expect((await post({ action: "connect" })).statusCode).toBe(409);
    expect((await db.select().from(schema.calendarSyncAccounts))[0]!.clientId).toBe(CLIENT);
  });
  it("validates calendar ownership and edit access before establishing a pair", async () => {
    graph(); await connected(); await db.delete(schema.calendarSyncPairs);
    const [foreign] = await db.insert(schema.calendars).values({ ownerId: (await makeUser("foreign@example.com")).id, name: "Foreign" }).returning();
    expect((await post({ action: "pair", calendarId: foreign!.id, remoteId: "remote-calendar" })).statusCode).toBe(409);
    expect((await post({ action: "pair", calendarId, remoteId: "read-only" })).statusCode).toBe(409);
    expect((await post({ action: "pair", calendarId, remoteId: "remote-calendar" })).statusCode).toBe(200);
    expect((await post({ action: "pair", calendarId, remoteId: "remote-calendar" })).statusCode).toBe(409);
    expect((await db.select().from(schema.calendarSyncPairs))).toHaveLength(1);
  });
  it("pauses, resumes, queues and disconnects without deleting existing events", async () => {
    const pair = await connected();
    const [event] = await db.insert(schema.events).values({ calendarId, uid: "native-test", summary: "Keep me", startsAt: new Date(), endsAt: new Date(Date.now() + 3600000) }).returning();
    expect((await post({ action: "pause", id: pair.id }, otherToken)).statusCode).toBe(409);
    expect((await post({ action: "pause", id: pair.id })).statusCode).toBe(200); expect((await get()).json().data.pairs[0].enabled).toBe(false);
    await post({ action: "resume", id: pair.id }); expect((await get()).json().data.pairs[0].enabled).toBe(true);
    await post({ action: "sync", id: pair.id }); expect((await db.select().from(schema.calendarSyncPairs))[0]!.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await post({ action: "disconnect" })).statusCode).toBe(400);
    expect((await post({ action: "disconnect", confirm: "disconnect" })).statusCode).toBe(200);
    expect((await db.select().from(schema.events).where(eq(schema.events.id, event!.id)))).toHaveLength(1); expect((await get()).json().data.pairs).toEqual([]);
  });
  it("issues passwords once, scopes revocation to their owner and keeps profiles secret-free", async () => {
    const res = await post({ action: "apple-password", label: "Mac", calendarIds: [calendarId] }); expect(res.statusCode).toBe(200); const issued = res.json().data.password;
    const state = await get(); expect(state.body).not.toContain(issued.plain); expect(state.json().data.apple.passwords).toHaveLength(1);
    const profile = await get(token, "/apple-profile"); expect(profile.statusCode).toBe(200); expect(profile.body).not.toContain(issued.plain); expect(profile.json().data.profile).toContain("com.apple.caldav.account");
    await post({ action: "revoke-password", id: issued.id }, otherToken); expect((await get()).json().data.apple.passwords).toHaveLength(1);
    await post({ action: "revoke-password", id: issued.id }); expect((await get()).json().data.apple.passwords).toEqual([]);
  });
  it("applies native Apple calendar selection, pause and revocation to real CalDAV including cached credentials", async () => {
    const [hidden] = await db.insert(schema.calendars).values({ ownerId: userId, name: "Not selected" }).returning();
    const issued = (await post({ action: "apple-password", label: "Mac", calendarIds: [calendarId] })).json().data.password;
    const headers = { authorization: "Basic " + Buffer.from("owner@example.com:" + issued.plain).toString("base64"), depth: "1" };
    const home = "/caldav/" + userId + "/";
    const listing = await app.inject({ method: "PROPFIND", url: home, headers });
    expect(listing.statusCode, listing.body).toBe(207); expect(listing.body).toContain(calendarId); expect(listing.body).not.toContain(hidden!.id);
    for (const method of ["GET", "PROPFIND", "REPORT", "PUT", "DELETE"] as const) {
      const url = home + hidden!.id + (method === "PUT" || method === "DELETE" ? "/blocked.ics" : "/");
      const result = await app.inject({ method, url, headers }); expect(result.statusCode, method + result.body).toBe(404);
    }
    await post({ action: "apple-settings", id: issued.id, paused: true });
    const paused = await app.inject({ method: "PROPFIND", url: home, headers }); expect(paused.statusCode).toBe(503); expect(paused.headers["retry-after"]).toBe("300");
    await post({ action: "apple-settings", id: issued.id, paused: false, calendarIds: [hidden!.id] });
    const changed = await app.inject({ method: "PROPFIND", url: home, headers }); expect(changed.statusCode).toBe(207); expect(changed.body).toContain(hidden!.id); expect(changed.body).not.toContain(calendarId);
    await post({ action: "revoke-password", id: issued.id });
    expect((await app.inject({ method: "PROPFIND", url: home, headers })).statusCode).toBe(401);
  });

});
