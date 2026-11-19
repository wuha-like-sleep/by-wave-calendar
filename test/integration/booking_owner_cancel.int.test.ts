import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/event_cancel.js", () => ({ notifyEventCancellation: vi.fn(async () => ({ ok: true, cancelledNotices: 0 })) }));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { bookingRoutes } = await import("../../src/routes/booking.js");
const { availableSlots, bookSlot, cancelBooking } = await import("../../src/lib/booking.js");
const { notifyEventCancellation } = await import("../../src/lib/event_cancel.js");
const { env } = await import("../../src/env.js");

let app: FastifyInstance;
let owner: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;
let link: typeof schema.bookingLinks.$inferSelect;
let auth: string;
let otherAuth: string;
const now = new Date("2026-11-15T16:30:00Z"); // Shanghai Monday, 00:30.

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(bookingRoutes, { prefix: "/api/v1" });
  await app.ready();
});
afterAll(async () => { vi.useRealTimers(); await app.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await resetDb();
  owner = await makeUser("owner-cancel@example.com");
  other = await makeUser("other-cancel@example.com");
  const cal = await makeCalendar(owner.id);
  await db.update(schema.calendars).set({ timezone: "Asia/Shanghai" }).where(eq(schema.calendars.id, cal.id));
  [link] = await db.insert(schema.bookingLinks).values({
    userId: owner.id, calendarId: cal.id, slug: "chat", title: "Owner cancel",
    durationMinutes: 30, minNoticeHours: 0, maxDaysAhead: 14,
    weeklyAvailability: { "1": [["01:00", "02:00"]], "2": [["01:00", "02:00"]] },
  }).returning() as [typeof schema.bookingLinks.$inferSelect];
  auth = await loginAs(app, owner.id);
  otherAuth = await loginAs(app, other.id);
});

async function reserve() {
  const slot = (await availableSlots(link, new Date(), 14))[0]!;
  return bookSlot({ link, ...slot, guestName: "Guest", guestEmail: "guest@example.com" });
}

function cancelUrl(bookingId: string, linkId: string = link.id) {
  return `/api/v1/booking-links/${linkId}/bookings/${bookingId}/cancel`;
}

async function ownerInboxCancelNotes() {
  return db.select().from(schema.notifications)
    .where(eq(schema.notifications.userId, owner.id));
}

describe("owner-side booking cancellation endpoint", () => {
  it("cancels the booking + event through the guest chain, without the guest-attributed inbox note", async () => {
    const created = await reserve();
    const bookingId = created.booking.id;
    const eventId = created.booking.eventId!;
    // bookSlot itself wrote a booking_created note; clear the slate so the
    // assertions below only see what the cancel produces.
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, owner.id));
    vi.clearAllMocks();

    const res = await app.inject({ method: "POST", url: cancelUrl(bookingId), headers: { cookie: auth } });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { ok: true, alreadyCancelled: false } });

    const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
    expect(booking?.cancelledAt).not.toBeNull();
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
    expect(event?.deletedAt).not.toBeNull();
    // The guest-facing chain ran (METHOD:CANCEL mail fan-out lives behind it).
    expect(vi.mocked(notifyEventCancellation)).toHaveBeenCalledTimes(1);
    // …but the owner did NOT get a "guest cancelled your booking" inbox note.
    const notes = await ownerInboxCancelNotes();
    expect(notes.filter((n) => n.type === "booking_cancelled")).toEqual([]);
  });

  it("is idempotent: a second cancel reports alreadyCancelled and re-fires nothing", async () => {
    const created = await reserve();
    const first = await app.inject({ method: "POST", url: cancelUrl(created.booking.id), headers: { cookie: auth } });
    expect(first.statusCode).toBe(200);
    vi.clearAllMocks();
    const second = await app.inject({ method: "POST", url: cancelUrl(created.booking.id), headers: { cookie: auth } });
    expect(second.statusCode, second.body.slice(0, 300)).toBe(200);
    expect(second.json()).toEqual({ ok: true, data: { ok: true, alreadyCancelled: true } });
    expect(vi.mocked(notifyEventCancellation)).not.toHaveBeenCalled();
  });

  it("rejects non-owners and unknown bookings with 404, unauthenticated with 401", async () => {
    const created = await reserve();
    const asOther = await app.inject({ method: "POST", url: cancelUrl(created.booking.id), headers: { cookie: otherAuth } });
    expect(asOther.statusCode).toBe(404);
    const unknown = await app.inject({
      method: "POST",
      url: cancelUrl("00000000-0000-4000-8000-000000000000"),
      headers: { cookie: auth },
    });
    expect(unknown.statusCode).toBe(404);
    const anon = await app.inject({ method: "POST", url: cancelUrl(created.booking.id) });
    expect(anon.statusCode).toBe(401);
    const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, created.booking.id));
    expect(booking?.cancelledAt).toBeNull();
  });

  it("guest cancellation still writes the owner inbox note (contrast: byOwner is the only difference)", async () => {
    const created = await reserve();
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, owner.id));
    const result = await cancelBooking(created.booking.cancelToken);
    expect(result).toEqual({ found: true, alreadyCancelled: false });
    const notes = await ownerInboxCancelNotes();
    expect(notes.filter((n) => n.type === "booking_cancelled")).toHaveLength(1);
  });
});
