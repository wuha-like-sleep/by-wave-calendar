import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/db/client.js", async () => { const h = await import("./harness.js"); return { db: h.db, schema: h.schema }; });
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, schema, ensureSchema, resetDb, makeUser, makeCalendar, buildRoutedApp, loginAs } from "./harness.js";
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
let app: FastifyInstance, cookie: string, id: string;
const at = (day: number) => `2026-06-${String(day).padStart(2, "0")}T09:00:00.000Z`;
beforeAll(ensureSchema);
beforeEach(async () => {
  await resetDb(); app = await buildRoutedApp(eventRoutes, { prefix: "/api" });
  const user = await makeUser("owner@example.com"), cal = await makeCalendar(user.id);
  cookie = await loginAs(app, user.id);
  const [event] = await db.insert(schema.events).values({ calendarId: cal.id, uid: "recurring-delete", summary: "Daily",
    startsAt: new Date(at(1)), endsAt: new Date("2026-06-01T10:00:00Z"), rrule: "FREQ=DAILY;COUNT=8", extra: { timezone: "UTC" } }).returning();
  id = event!.id;
});
afterEach(async () => { await app.close(); });
const stored = async () => (await db.select().from(schema.events).where(eq(schema.events.id, id)))[0]!;
const remove = (scope: string, recurrenceId?: string) => app.inject({ method: "DELETE", url: `/api/events/${id}?${new URLSearchParams({ scope, ...(recurrenceId ? { recurrenceId } : {}) })}`, headers: { cookie } });
describe("recurring event deletion", () => {
  it("keeps every deletion when different devices remove different occurrences concurrently", async () => {
    const responses = await Promise.all([2, 3, 4, 5].map(day => remove("instance", at(day))));
    expect(responses.map(r => r.statusCode)).toEqual([204, 204, 204, 204]);
    expect((await stored()).exdates).toEqual(expect.arrayContaining([2, 3, 4, 5].map(at)));
    expect((await stored()).exdates).toHaveLength(4);
  });
  it("does not duplicate equivalent occurrence timestamps on repeated deletion", async () => {
    expect((await remove("instance", at(2))).statusCode).toBe(204);
    expect((await remove("instance", "2026-06-02T17:00:00+08:00")).statusCode).toBe(204);
    expect((await stored()).exdates).toEqual([at(2)]);
  });
  it("never extends an earlier truncation when a stale future-delete is retried", async () => {
    expect((await remove("future", at(3))).statusCode).toBe(204);
    const trimmed = await stored();
    expect(trimmed.rrule).toBe("FREQ=DAILY;UNTIL=20260603T085959Z");
    expect((await remove("future", at(6))).statusCode).toBe(204);
    expect((await stored()).rrule).toBe(trimmed.rrule);
    expect((await remove("future", at(3))).statusCode).toBe(204);
    expect((await stored()).rrule).toBe(trimmed.rrule);
  });
  it("does not broaden invalid scope or missing occurrence into deleting the whole series", async () => {
    expect((await remove("typo", at(2))).statusCode).toBe(400);
    expect((await remove("instance")).statusCode).toBe(400);
    expect((await remove("future", "bad-date")).statusCode).toBe(400);
    expect((await stored()).deletedAt).toBeNull();
    expect((await stored()).rrule).toBe("FREQ=DAILY;COUNT=8");
  });
  it("rejects a stale scoped delete after the series was converted to a single event", async () => {
    await db.update(schema.events).set({ rrule: null }).where(eq(schema.events.id, id));
    expect((await remove("instance", at(2))).statusCode).toBe(409);
    expect((await stored()).deletedAt).toBeNull();
  });
  it("removes the master when deleting the first occurrence and all future ones", async () => {
    expect((await remove("future", at(1))).statusCode).toBe(204);
    expect((await stored()).deletedAt).not.toBeNull();
    expect((await remove("future", at(1))).statusCode).toBe(204);
    const response = await app.inject({ url: `/api/events/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });
  it("truncates a raw UTC CalDAV series without changing the remaining occurrence timezone", async () => {
    await db.update(schema.events).set({ extra: { timezone: "Australia/Melbourne", category: "Work" },
      rawIcs: "BEGIN:VEVENT\r\nUID:recurring-delete\r\nDTSTART:20260601T090000Z\r\nDTEND:20260601T100000Z\r\nRRULE:FREQ=DAILY;COUNT=8\r\nEND:VEVENT" }).where(eq(schema.events.id, id));
    expect((await remove("future", at(3))).statusCode).toBe(204);
    const current = await stored();
    expect(current.rawIcs).toBeNull();
    expect(current.extra).toEqual({ timezone: "UTC", category: "Work" });
    const result = await app.inject({ url: `/api/events?${new URLSearchParams({ from: "2026-06-01T00:00:00Z", to: "2026-06-09T00:00:00Z" })}`, headers: { cookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json().events.map((event: { startsAt: string }) => event.startsAt)).toEqual([at(1), at(2)]);
  });
});
