import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/event_cancel.js", () => ({ notifyEventCancellation: vi.fn(async () => ({ ok: true, cancelledNotices: 0 })) }));

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, buildRoutedApp, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { availableSlots, bookingTimeZone, bookingTimeZoneFromCalendar, bookSlot, BookingError } = await import("../../src/lib/booking.js");
const { bookingRoutes } = await import("../../src/routes/booking.js");

let user: Awaited<ReturnType<typeof makeUser>>;
let calendar: Awaited<ReturnType<typeof makeCalendar>>;
let link: typeof schema.bookingLinks.$inferSelect;
let app: FastifyInstance;
beforeAll(async () => { await ensureSchema(); app = await buildRoutedApp(bookingRoutes, { prefix: "/api" }); });
afterAll(async () => { vi.useRealTimers(); await app.close(); });
beforeEach(async () => {
  vi.useRealTimers();
  await resetDb();
  user = await makeUser("host@example.com");
  calendar = await makeCalendar(user.id);
  [link] = await db.insert(schema.bookingLinks).values({ userId: user.id, calendarId: calendar.id,
    slug: "meeting", title: "Meeting", durationMinutes: 30, minNoticeHours: 0, maxDaysAhead: 14,
    weeklyAvailability: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), [["09:00", "10:00"]]])),
  }).returning() as [typeof schema.bookingLinks.$inferSelect];
});
async function zone(timezone: string) {
  await db.update(schema.calendars).set({ timezone }).where(eq(schema.calendars.id, calendar.id));
}
async function slots(timezone: string, from: string, availability: Record<string, [string, string][]>, days = 1) {
  await zone(timezone);
  return availableSlots({ ...link, weeklyAvailability: availability }, new Date(from), days);
}
const starts = (rows: Awaited<ReturnType<typeof availableSlots>>) => rows.map(row => row.startsAt.toISOString());

describe("booking availability follows the initiating calendar timezone", () => {
  it("uses the host's Monday even while UTC is still Sunday", async () => {
    const rows = await slots("Australia/Melbourne", "2026-11-15T13:30:00Z", { "1": [["01:00", "02:00"]] });
    expect(starts(rows)).toEqual(["2026-11-15T14:00:00.000Z", "2026-11-15T14:30:00.000Z"]);
  });
  it("uses the host's Sunday even after UTC has reached Monday", async () => {
    const rows = await slots("America/Los_Angeles", "2026-11-16T01:00:00Z", { "0": [["18:00", "19:00"]] });
    expect(starts(rows)).toEqual(["2026-11-16T02:00:00.000Z", "2026-11-16T02:30:00.000Z"]);
  });
  it("supports fractional-hour IANA offsets", async () => {
    const rows = await slots("Asia/Kolkata", "2026-11-15T00:00:00Z", { "0": [["09:00", "10:00"]] });
    expect(starts(rows)).toEqual(["2026-11-15T03:30:00.000Z", "2026-11-15T04:00:00.000Z"]);
  });
  it("keeps 09:00 host time across the Melbourne daylight-saving transition", async () => {
    const rows = await slots("Australia/Melbourne", "2026-09-26T14:00:00Z", { "0": [["09:00", "10:00"]] }, 9);
    expect(starts(rows)).toEqual(["2026-09-26T23:00:00.000Z", "2026-09-26T23:30:00.000Z",
      "2026-10-03T22:00:00.000Z", "2026-10-03T22:30:00.000Z"]);
  });
  it("never offers nonexistent starts or shifts them into duplicate later slots", async () => {
    const rows = await slots("America/New_York", "2026-03-08T05:00:00Z", { "0": [["01:00", "04:00"]] });
    expect(starts(rows)).toEqual(["2026-03-08T06:00:00.000Z", "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:00:00.000Z", "2026-03-08T07:30:00.000Z"]);
    expect(rows.every(row => +row.endsAt - +row.startsAt === 30 * 60_000)).toBe(true);
  });
  it("does not extend a closing time that falls inside the DST gap", async () => {
    const rows = await slots("America/New_York", "2026-03-08T05:00:00Z", { "0": [["01:00", "02:30"]] });
    expect(starts(rows)).toEqual(["2026-03-08T06:00:00.000Z"]);
  });
  it("keeps both real repeated-hour instants separately bookable", async () => {
    const rows = await slots("America/New_York", "2026-11-01T04:00:00Z", { "0": [["01:00", "02:00"]] });
    expect(starts(rows)).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z", "2026-11-01T06:30:00.000Z"]);
    await db.insert(schema.events).values({ calendarId: calendar.id, uid: "first-fold-busy", summary: "Busy",
      startsAt: new Date("2026-11-01T05:30:00Z"), endsAt: new Date("2026-11-01T06:00:00Z") });
    const free = await availableSlots({ ...link, weeklyAvailability: { "0": [["01:00", "02:00"]] } }, new Date("2026-11-01T04:00:00Z"), 1);
    expect(starts(free)).not.toContain("2026-11-01T05:30:00.000Z");
    expect(starts(free)).toContain("2026-11-01T06:30:00.000Z");
  });
  it("does not drop the second fold when availability closes inside the repeated hour", async () => {
    await zone("America/New_York");
    const rows = await availableSlots({ ...link, durationMinutes: 15, weeklyAvailability: { "0": [["01:00", "01:45"]] } },
      new Date("2026-11-01T04:00:00Z"), 1);
    expect(starts(rows)).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T05:15:00.000Z", "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z", "2026-11-01T06:15:00.000Z", "2026-11-01T06:30:00.000Z"]);
    expect(rows.map(row => row.endsAt.toISOString())).toContain("2026-11-01T06:45:00.000Z");
  });
  it("does not bridge the unavailable interval between two short repeated-hour ranges", async () => {
    await zone("America/New_York");
    const rows = await availableSlots({ ...link, durationMinutes: 90, weeklyAvailability: { "0": [["01:15", "01:45"]] } },
      new Date("2026-11-01T04:00:00Z"), 1);
    // 01:15 EDT -> 01:45 EST has matching endpoints, but spends time after
    // the first 01:45 close and before the second 01:15 opening.
    expect(rows).toEqual([]);
    const halfHour = await availableSlots({ ...link, durationMinutes: 30, weeklyAvailability: { "0": [["01:30", "01:45"]] } },
      new Date("2026-11-01T04:00:00Z"), 1);
    // 01:30 EDT -> 01:00 EST crosses the closing boundary as well.
    expect(halfHour).toEqual([]);
  });
  it("canonicalizes aliases and retains legacy Shanghai for invalid old calendar zones", async () => {
    expect(bookingTimeZoneFromCalendar("US/Eastern")).toBe("America/New_York");
    await zone("not-a-timezone");
    expect(await bookingTimeZone(link)).toBe("Asia/Shanghai");
    const rows = await availableSlots(link, new Date("2026-11-15T00:00:00Z"), 1);
    expect(starts(rows)).toEqual(["2026-11-15T01:00:00.000Z", "2026-11-15T01:30:00.000Z"]);
  });
  it("uses the locked current calendar zone at submission and pins it on the created event", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
    const oldSlot = (await availableSlots(link, new Date(), 1))[0]!;
    expect(oldSlot.startsAt.toISOString()).toBe("2026-11-15T09:00:00.000Z");
    await zone("America/New_York");
    await expect(bookSlot({ link, ...oldSlot, guestEmail: "guest@example.com", guestName: "Guest" })).rejects.toBeInstanceOf(BookingError);
    const currentSlot = (await availableSlots(link, new Date(), 2))[0]!;
    const created = await bookSlot({ link, ...currentSlot, guestEmail: "guest@example.com", guestName: "Guest" });
    expect(created.timeZone).toBe("America/New_York");
    expect(created.event.extra).toMatchObject({ timezone: "America/New_York" });
    expect(created.booking.startsAt.toISOString()).toBe("2026-11-15T14:00:00.000Z");
    await zone("Australia/Melbourne");
    await availableSlots(link, new Date(), 14);
    const [stored] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, created.booking.id));
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, created.event.id));
    expect(stored!.startsAt).toEqual(created.booking.startsAt);
    expect(stored!.endsAt).toEqual(created.booking.endsAt);
    expect(event!.startsAt).toEqual(created.event.startsAt);
    expect(event!.extra).toMatchObject({ timezone: "America/New_York" });
  });
  it("returns the derived calendar timezone to native booking management clients", async () => {
    await zone("Australia/Melbourne");
    const cookie = await loginAs(app, user.id);
    const listed = await app.inject({ url: "/api/booking-links", headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()[0].timezone).toBe("Australia/Melbourne");
    const created = await app.inject({ method: "POST", url: "/api/booking-links", headers: { cookie }, payload: {
      slug: "new", title: "New", calendarId: calendar.id, durationMinutes: 30, minNoticeHours: 0, maxDaysAhead: 14,
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json().timezone).toBe("Australia/Melbourne");
    const other = await makeCalendar(user.id, "UTC calendar");
    const updated = await app.inject({ method: "PATCH", url: `/api/booking-links/${link.id}`, headers: { cookie }, payload: { calendarId: other.id } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().timezone).toBe("UTC");
  });
});

describe("all-day booking conflicts use the host's civil dates", () => {
  const availability = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), [["00:00", "23:30"]]]));

  it.each([
    { timezone: "Asia/Shanghai", from: "2026-11-15T04:00:00Z", date: "2026-11-16", endDate: "2026-11-17", start: "2026-11-15T16:00:00Z", end: "2026-11-16T16:00:00Z" },
    { timezone: "America/Los_Angeles", from: "2026-11-15T20:00:00Z", date: "2026-11-16", endDate: "2026-11-17", start: "2026-11-16T08:00:00Z", end: "2026-11-17T08:00:00Z" },
  ])("blocks exactly the all-day date in $timezone, including local midnight", async (test) => {
    await zone(test.timezone);
    const configured = { ...link, weeklyAvailability: availability };
    const before = await availableSlots(configured, new Date(test.from), 4);
    await db.insert(schema.events).values({ calendarId: calendar.id, uid: "all-day", summary: "Away", allDay: true,
      startsAt: new Date(`${test.date}T00:00:00Z`), endsAt: new Date(`${test.endDate}T00:00:00Z`) });
    const free = await availableSlots(configured, new Date(test.from), 4);
    expect(starts(free)).toEqual(starts(before.filter(slot => slot.endsAt <= new Date(test.start) || slot.startsAt >= new Date(test.end))));
    expect(starts(before)).toContain(new Date(test.start).toISOString());
    expect(starts(free)).toContain(new Date(test.end).toISOString());
  });

  it.each([
    { name: "spring gap", date: "2026-03-08", previous: "2026-03-01", endDate: "2026-03-09", previousEnd: "2026-03-02", from: "2026-03-07T17:00:00Z", start: "2026-03-08T05:00:00Z", end: "2026-03-09T04:00:00Z", hours: 23 },
    { name: "autumn fold", date: "2026-11-01", previous: "2026-10-25", endDate: "2026-11-02", previousEnd: "2026-10-26", from: "2026-10-31T16:00:00Z", start: "2026-11-01T04:00:00Z", end: "2026-11-02T05:00:00Z", hours: 25 },
  ].flatMap(test => [false, true].map(recurring => ({ ...test, recurring }))))("handles the $hours-hour $name all-day conflict, recurring=$recurring", async (test) => {
    await zone("America/New_York");
    const configured = { ...link, weeklyAvailability: availability };
    const before = await availableSlots(configured, new Date(test.from), 4);
    const [busy] = await db.insert(schema.events).values({ calendarId: calendar.id, uid: "all-day-dst", summary: "Away", allDay: true,
      startsAt: new Date(`${test.recurring ? test.previous : test.date}T00:00:00Z`), endsAt: new Date(`${test.recurring ? test.previousEnd : test.endDate}T00:00:00Z`),
      rrule: test.recurring ? "FREQ=WEEKLY;COUNT=2" : null }).returning();
    const free = await availableSlots(configured, new Date(test.from), 4);
    expect(+new Date(test.end) - +new Date(test.start)).toBe(test.hours * 3_600_000);
    expect(starts(free)).toEqual(starts(before.filter(slot => slot.endsAt <= new Date(test.start) || slot.startsAt >= new Date(test.end))));
    expect(starts(before)).toContain(new Date(test.start).toISOString());
    expect(starts(free)).toContain(new Date(test.end).toISOString());
    if (test.recurring) {
      await db.update(schema.events).set({ exdates: [`${test.date}T00:00:00.000Z`] }).where(eq(schema.events.id, busy!.id));
      expect(starts(await availableSlots(configured, new Date(test.from), 4))).toEqual(starts(before));
    }
  });

  it.each([false, true])("blocks a multi-day civil range across DST without shifting stored dates, recurring=%s", async (recurring) => {
    await zone("America/New_York");
    const configured = { ...link, weeklyAvailability: availability };
    const from = new Date("2026-03-06T17:00:00Z"), start = new Date("2026-03-07T05:00:00Z"), end = new Date("2026-03-10T04:00:00Z");
    const before = await availableSlots(configured, from, 5);
    const [busy] = await db.insert(schema.events).values({ calendarId: calendar.id, uid: "multi-day-dst", summary: "Away", allDay: true,
      startsAt: new Date(recurring ? "2026-02-28T00:00:00Z" : "2026-03-07T00:00:00Z"),
      endsAt: new Date(recurring ? "2026-03-03T00:00:00Z" : "2026-03-10T00:00:00Z"),
      rrule: recurring ? "FREQ=WEEKLY;COUNT=2" : null }).returning();
    const free = await availableSlots(configured, from, 5);
    expect(starts(free)).toEqual(starts(before.filter(slot => slot.endsAt <= start || slot.startsAt >= end)));
    expect(starts(free)).toContain(end.toISOString());
    const [stored] = await db.select().from(schema.events).where(eq(schema.events.id, busy!.id));
    expect(stored!.startsAt).toEqual(busy!.startsAt);
    expect(stored!.endsAt).toEqual(busy!.endsAt);
  });
});
