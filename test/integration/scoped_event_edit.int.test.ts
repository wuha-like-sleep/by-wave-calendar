import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, pg, schema, buildRoutedApp, loginAs, makeUser } from "./harness.js";
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { reloadSettings } = await import("../../src/lib/site_settings.js");
let api: FastifyInstance, cookie: string, calendarId: string, ownerId: string;
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9));
beforeAll(ensureSchema);
beforeEach(async () => {
  await resetDb(); reloadSettings();
  api = await buildRoutedApp(eventRoutes, { prefix: "/api" });
  const user = await makeUser("scoped@example.com"); ownerId = user.id;
  cookie = await loginAs(api, user.id);
  const [calendar] = await db.insert(schema.calendars).values({ ownerId, name: "Calendar", timezone: "UTC" }).returning();
  calendarId = calendar!.id;
});
afterEach(async () => { await api.close(); });
async function seed(extra: Partial<typeof schema.events.$inferInsert> = {}) {
  const [event] = await db.insert(schema.events).values({ calendarId, uid: "series-source", summary: "Meeting", startsAt: at(1), endsAt: new Date(+at(1) + 3600000), rrule: "FREQ=DAILY;COUNT=5", extra: { timezone: "UTC" }, ...extra }).returning();
  return event!;
}
const patch = (id: string, body: Record<string, unknown>) => api.inject({ method: "PATCH", url: `/api/events/${id}`, headers: { cookie }, payload: body });
const row = async (id: string) => (await db.select().from(schema.events).where(eq(schema.events.id, id)))[0]!;

describe("atomic scoped event editing", () => {
  it("invalid scopes and missing occurrence never fall back to editing all events", async () => {
    const event = await seed();
    for (const body of [{ scope: "instnce" }, { scope: "instance" }, { scope: "future", recurrenceId: "wrong" }]) {
      const result = await patch(event.id, { ...body, summary: "Must not save" });
      expect(result.statusCode).toBe(400);
    }
    expect((await row(event.id)).summary).toBe("Meeting");
    expect(await db.select().from(schema.events)).toHaveLength(1);
  });

  it("detaches only an existing active occurrence and rejects its stale retry", async () => {
    const event = await seed({ exdates: [at(2).toISOString()] });
    expect((await patch(event.id, { scope: "instance", recurrenceId: at(2).toISOString() })).statusCode).toBe(409);
    expect((await patch(event.id, { scope: "instance", recurrenceId: at(8).toISOString() })).statusCode).toBe(409);
    const response = await patch(event.id, { scope: "instance", recurrenceId: at(3).toISOString(), summary: "Changed" });
    expect(response.statusCode).toBe(200);
    expect((await row(event.id)).exdates).toEqual([at(2).toISOString(), at(3).toISOString()]);
    expect(response.json().rrule).toBeNull();
    expect(response.json().startsAt).toBe(at(3).toISOString());
    expect((await patch(event.id, { scope: "instance", recurrenceId: at(3).toISOString() })).statusCode).toBe(409);
    expect(await db.select().from(schema.events)).toHaveLength(2);
  });

  it("editing future from the first occurrence updates in place without leaving a ghost prefix", async () => {
    const event = await seed();
    const response = await patch(event.id, { scope: "future", recurrenceId: at(1).toISOString(), summary: "Whole suffix" });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(event.id);
    const current = await row(event.id);
    expect(current.uid).toBe(event.uid);
    expect(current.rrule).toBe("FREQ=DAILY;COUNT=5");
    expect(current.summary).toBe("Whole suffix");
    expect(await db.select().from(schema.events)).toHaveLength(1);
  });

  it("keeps remaining COUNT and excluded future dates after a split", async () => {
    const event = await seed({ exdates: [at(4).toISOString()] });
    const response = await patch(event.id, { scope: "future", recurrenceId: at(3).toISOString(), summary: "New suffix" });
    expect(response.statusCode).toBe(200);
    const suffix = await row(response.json().id);
    expect(suffix.rrule).toBe("FREQ=DAILY;COUNT=3");
    expect(suffix.exdates).toEqual([at(4).toISOString()]);
    expect((await row(event.id)).rrule).toBe("FREQ=DAILY;UNTIL=20261103T085959Z");
    expect((await patch(event.id, { scope: "future", recurrenceId: at(3).toISOString() })).statusCode).toBe(409);
  });

  it("preserves an existing UNTIL instead of creating an endless suffix", async () => {
    const event = await seed({ rrule: "FREQ=DAILY;UNTIL=20261105T090000Z" });
    const response = await patch(event.id, { scope: "future", recurrenceId: at(3).toISOString(), summary: "Renamed" });
    expect(response.statusCode).toBe(200);
    expect((await row(response.json().id)).rrule).toBe("FREQ=DAILY;UNTIL=20261105T090000Z");
  });

  it("preserves UTC CalDAV recurrence semantics when cached VEVENT is invalidated", async () => {
    const event = await seed({ extra: { timezone: "Australia/Melbourne" }, rawIcs: "BEGIN:VEVENT\nDTSTART:20261101T090000Z\nEND:VEVENT" });
    const response = await patch(event.id, { scope: "future", recurrenceId: at(3).toISOString(), summary: "Renamed", extra: { timezone: "Australia/Melbourne" } });
    expect(response.statusCode).toBe(200);
    const prefix = await row(event.id);
    const suffix = await row(response.json().id);
    expect(prefix.rawIcs).toBeNull();
    expect(prefix.extra).toMatchObject({ timezone: "UTC" });
    expect(suffix.extra).toMatchObject({ timezone: "UTC" });
    expect(suffix.startsAt.toISOString()).toBe(at(3).toISOString());
  });

  it("supports moving a scoped event only into another calendar owned by the user", async () => {
    const event = await seed();
    const other = await makeUser("other@example.com");
    const [forbidden] = await db.insert(schema.calendars).values({ ownerId: other.id, name: "Other", timezone: "UTC" }).returning();
    expect((await patch(event.id, { scope: "instance", recurrenceId: at(3).toISOString(), calendarId: forbidden!.id })).statusCode).toBe(403);
    const [destination] = await db.insert(schema.calendars).values({ ownerId, name: "Destination", timezone: "UTC" }).returning();
    const response = await patch(event.id, { scope: "instance", recurrenceId: at(3).toISOString(), calendarId: destination!.id });
    expect(response.statusCode).toBe(200);
    expect(response.json().calendarId).toBe(destination!.id);
  });

  it("rejects an inverted range without changing the series", async () => {
    const event = await seed();
    const response = await patch(event.id, { scope: "future", recurrenceId: at(3).toISOString(), startsAt: at(4).toISOString(), endsAt: at(3).toISOString() });
    expect(response.statusCode).toBe(400);
    expect((await row(event.id)).rrule).toBe(event.rrule);
    expect(await db.select().from(schema.events)).toHaveLength(1);
  });

  it("does not overwrite a concurrent deletion made after a full-series edit was planned", async () => {
    const event = await seed();
    const originalTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(async (...args) => {
      // Leave updatedAt exactly unchanged to exercise the data guard, not just
      // a timestamp comparison. This is the interval between plan and lock.
      await db.update(schema.events).set({ exdates: [at(3).toISOString()] }).where(eq(schema.events.id, event.id));
      return originalTransaction(...args);
    });
    try {
      const response = await patch(event.id, { scope: "series", recurrenceId: at(2).toISOString(), startsAt: new Date(+at(2) + 1800000).toISOString(), summary: "Stale edit" });
      expect(response.statusCode).toBe(409);
      const current = await row(event.id);
      expect(current.exdates).toEqual([at(3).toISOString()]);
      expect(current.summary).toBe("Meeting");
      expect(current.startsAt.toISOString()).toBe(at(1).toISOString());
    } finally { transaction.mockRestore(); }
  });

  it("rolls back the inserted detached event if excluding it from the master fails", async () => {
    const event = await seed();
    await pg.exec(`CREATE FUNCTION reject_scoped_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.uid = 'series-source' THEN RAISE EXCEPTION 'forced master update failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_scoped_update BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION reject_scoped_update();`);
    try {
      const response = await patch(event.id, { scope: "instance", recurrenceId: at(3).toISOString(), summary: "Detached" });
      expect(response.statusCode).toBe(500);
      expect(await db.select().from(schema.events)).toHaveLength(1);
      expect((await row(event.id)).exdates).toBeNull();
    } finally { await pg.exec("DROP TRIGGER reject_scoped_update ON events; DROP FUNCTION reject_scoped_update();"); }
  });
});
