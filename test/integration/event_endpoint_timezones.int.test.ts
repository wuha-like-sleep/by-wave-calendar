import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js"); return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/webhooks.js", () => ({ dispatchWebhook: vi.fn(async () => undefined), eventToWebhookPayload: (e: unknown) => e }));
import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, buildRoutedApp, loginAs } from "./harness.js";
import { buildIcsFeed } from "../../src/services/ics.js";
import { parseEvent, serializeEvent } from "../../src/lib/ical.js";
import { hashPassword } from "../../src/lib/password.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";
process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://local-tests/unused";
process.env.SESSION_SECRET ||= "local-test-secret-at-least-32-characters";
const { eventRoutes } = await import("../../src/routes/events.js");
const { caldavRoutes } = await import("../../src/web/caldav.js");
let app: FastifyInstance;
let dav: FastifyInstance;
let cookie: string;
let cal: Awaited<ReturnType<typeof makeCalendar>>;
beforeAll(async () => {
  await ensureSchema(); app = await buildRoutedApp(eventRoutes, { prefix: "/api/v1" });
  dav = Fastify({ logger: false });
  dav.addHttpMethod("PROPFIND", { hasBody: true }); dav.addHttpMethod("REPORT", { hasBody: true });
  dav.addContentTypeParser("text/calendar", { parseAs: "string" }, (_req, body, done) => done(null, body as string));
  await dav.register(caldavRoutes); await dav.ready();
});
afterAll(async () => { await app.close(); await dav.close(); });
beforeEach(async () => { await resetDb(); const user = await makeUser("traveller@example.test"); cal = await makeCalendar(user.id); cookie = await loginAs(app, user.id); });
const payload = () => ({ calendarId: cal.id, summary: "Melbourne to Shanghai", startsAt: "2026-11-28T12:00:00Z", endsAt: "2026-11-28T21:00:00Z", extra: { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" } });
const data = (body: string): any => { const decoded = JSON.parse(body); return decoded.data ?? decoded; };
async function create() {
  const res = await app.inject({ method: "POST", url: "/api/v1/events", headers: { cookie }, payload: payload() });
  expect(res.statusCode, res.body).toBe(201); return data(res.body);
}
async function stored(id: string) { return (await db.select().from(schema.events).where(eq(schema.events.id, id)))[0]!; }

describe("journey endpoint zones through real event routes and storage", () => {
  it("single-event CalDAV and ICS retain calendar source and UTC writebacks never replace stored origin", async () => {
    const password = "local-system-zone-test";
    await db.update(schema.users).set({ passwordHash: await hashPassword(password), passwordSet: true }).where(eq(schema.users.id, cal.ownerId));
    await db.update(schema.calendars).set({ timezone: "Australia/Melbourne" }).where(eq(schema.calendars.id, cal.id));
    cal = (await db.select().from(schema.calendars).where(eq(schema.calendars.id, cal.id)))[0]!;
    invalidateCalDavAuthCache();
    const [row] = await db.insert(schema.events).values({ calendarId: cal.id, uid: "system-zone-single", summary: "Meeting", startsAt: new Date("2026-11-28T13:30:00Z"), endsAt: new Date("2026-11-28T14:30:00Z") }).returning();
    const url = `/caldav/${cal.ownerId}/${cal.id}/${row!.uid}.ics`;
    const authorization = "Basic " + Buffer.from(`traveller@example.test:${password}`).toString("base64");
    for (const text of [buildIcsFeed(cal, [row!]), (await dav.inject({ method: "GET", url, headers: { authorization } })).body]) {
      const parsed = parseEvent(text)!;
      expect(parsed.timezone).toBe("Australia/Melbourne");
      expect(parsed.startsAt.toISOString()).toBe("2026-11-28T13:30:00.000Z");
      expect(text).toContain("DTSTART;TZID=Australia/Melbourne:20261129T003000");
    }
    await db.update(schema.events).set({ extra: { timezone: "Australia/Melbourne", url: "https://example.test/keep" } }).where(eq(schema.events.id, row!.id));
    const utcBody = ["BEGIN:VCALENDAR", "VERSION:2.0", serializeEvent({ uid: row!.uid, summary: "Native title", startsAt: row!.startsAt, endsAt: row!.endsAt, allDay: false }), "END:VCALENDAR"].join("\r\n");
    const updated = await dav.inject({ method: "PUT", url, headers: { authorization, "content-type": "text/calendar" }, payload: utcBody });
    expect(updated.statusCode, updated.body).toBe(204);
    const saved = await stored(row!.id);
    expect(saved.extra).toMatchObject({ timezone: "Australia/Melbourne", url: "https://example.test/keep" });
    expect(saved.startsAt).toEqual(row!.startsAt); expect(saved.endsAt).toEqual(row!.endsAt);
    const reread = await dav.inject({ method: "GET", url, headers: { authorization } });
    expect(reread.body).toContain("DTSTART:20261128T133000Z");
  });
  it("creates, reads, synchronizes and exports both zones while retaining exact UTC instants", async () => {
    const made = await create();
    expect((await stored(made.id)).extra).toEqual(payload().extra);
    const read = await app.inject({ method: "GET", url: `/api/v1/events/${made.id}`, headers: { cookie } });
    expect(read.statusCode).toBe(200); expect(data(read.body).extra).toEqual(payload().extra);
    const sync = await app.inject({ method: "GET", url: "/api/v1/events/sync?from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z", headers: { cookie } });
    expect(sync.statusCode, sync.body).toBe(200);
    expect(data(sync.body).events.find((e: any) => e.id === made.id).extra).toEqual(payload().extra);
    const row = await stored(made.id);
    const decoded = parseEvent(buildIcsFeed(cal, [row], { full: true }))!;
    expect(decoded.timezone).toBe("Australia/Melbourne"); expect(decoded.endTimezone).toBe("Asia/Shanghai");
    expect(decoded.startsAt).toEqual(row.startsAt); expect(decoded.endsAt).toEqual(row.endsAt);
  });
  it("preserves an itinerary when an old client edits other fields, and clears only the explicit endpoint override", async () => {
    const made = await create();
    const patch = await app.inject({ method: "PATCH", url: `/api/v1/events/${made.id}`, headers: { cookie }, payload: { summary: "Flight updated", extra: { category: "travel" } } });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((await stored(made.id)).extra).toMatchObject(payload().extra);
    const cleared = await app.inject({ method: "PATCH", url: `/api/v1/events/${made.id}`, headers: { cookie }, payload: { extra: { endTimezone: null } } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const row = await stored(made.id);
    expect(row.extra).toEqual({ timezone: "Australia/Melbourne", category: "travel" });
    expect(buildIcsFeed(cal, [row])).toContain("DTEND;TZID=Australia/Melbourne:20261129T080000");
  });
  it("rejects an invalid arrival zone before storing an event", async () => {
    const body = payload(); body.extra.endTimezone = "Not/AZone";
    const res = await app.inject({ method: "POST", url: "/api/v1/events", headers: { cookie }, payload: body });
    expect(res.statusCode).toBe(400); expect(await db.select().from(schema.events)).toHaveLength(0);
  });
  it("CalDAV preserves a journey and removes its old override when PUT becomes same-zone or all-day", async () => {
    const password = "local-trip-test-password";
    await db.update(schema.users).set({ passwordHash: await hashPassword(password), passwordSet: true }).where(eq(schema.users.id, cal.ownerId));
    invalidateCalDavAuthCache();
    const made = await create(); const row = await stored(made.id);
    const url = `/caldav/${cal.ownerId}/${cal.id}/${encodeURIComponent(row.uid)}.ics`;
    const authorization = "Basic " + Buffer.from(`traveller@example.test:${password}`).toString("base64");
    const read = await dav.inject({ method: "GET", url, headers: { authorization } });
    expect(read.statusCode, read.body).toBe(200);
    expect(parseEvent(read.body)).toMatchObject({ timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai" });
    for (const allDay of [false, true]) {
      // Restore a cross-zone row before each authoritative replacement.
      await db.update(schema.events).set({ extra: payload().extra, rawIcs: null }).where(eq(schema.events.id, row.id));
      const block = serializeEvent({ uid: row.uid, summary: "Updated in system calendar", startsAt: row.startsAt, endsAt: row.endsAt, allDay, timezone: "Australia/Melbourne" });
      const body = ["BEGIN:VCALENDAR", "VERSION:2.0", block, "END:VCALENDAR"].join("\r\n");
      const put = await dav.inject({ method: "PUT", url, headers: { authorization, "content-type": "text/calendar" }, payload: body });
      expect(put.statusCode, put.body).toBe(204);
      expect((await stored(row.id)).extra).not.toHaveProperty("endTimezone");
    }
  });
});
