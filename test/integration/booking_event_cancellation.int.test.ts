import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/webhooks.js", () => ({ dispatchWebhook: vi.fn(async () => undefined), eventToWebhookPayload: (event: unknown) => event }));

import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, buildRoutedApp, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { eventRoutes } = await import("../../src/routes/events.js");
const { cancelEvent } = await import("../../src/lib/event_cancel.js");
const { cancelBooking, deleteBookingLink } = await import("../../src/lib/booking.js");
const { ByWaveCalendar } = await import("../../src/lib/calendar_sync/bywave.js");
const { sendMail } = await import("../../src/lib/mailer.js");
const { requestCalendarSync } = await import("../../src/lib/calendar_sync/queue.js");

let app: FastifyInstance;
let owner: Awaited<ReturnType<typeof makeUser>>;
let event: typeof schema.events.$inferSelect;
let booking: typeof schema.bookings.$inferSelect;
let auth: string;

beforeAll(async () => { await ensureSchema(); app = await buildRoutedApp(eventRoutes, { prefix: "/api" }); });
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sendMail).mockImplementation(async () => ({ ok: true }));
  await resetDb();
  owner = await makeUser("booking-owner@example.com");
  const cal = await makeCalendar(owner.id);
  const [link] = await db.insert(schema.bookingLinks).values({ userId: owner.id, calendarId: cal.id,
    slug: "chat", title: "Meeting", weeklyAvailability: {} }).returning();
  const startsAt = new Date(Date.now() + 24 * 60 * 60_000), endsAt = new Date(+startsAt + 30 * 60_000);
  [event] = await db.insert(schema.events).values({ calendarId: cal.id, uid: "booking-event", summary: "Meeting — Guest",
    startsAt, endsAt, extra: { bookingLinkId: link!.id, guestName: "Guest", attendees: ["guest@example.com"] },
  }).returning() as [typeof schema.events.$inferSelect];
  [booking] = await db.insert(schema.bookings).values({ linkId: link!.id, eventId: event.id, guestEmail: "guest@example.com",
    guestName: "Guest", startsAt, endsAt, cancelToken: "booking-cancel-token" }).returning() as [typeof schema.bookings.$inferSelect];
  auth = await loginAs(app, owner.id);
});

async function state() {
  const [currentEvent] = await db.select().from(schema.events).where(eq(schema.events.id, event.id));
  const [currentBooking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, booking.id));
  return { event: currentEvent!, booking: currentBooking! };
}
function adapter() {
  return new ByWaveCalendar(owner.id, event.calendarId, "pair", new Date(+event.startsAt - 60_000), new Date(+event.endsAt + 60_000));
}
async function failBookingCancellation() {
  await db.execute(sql`CREATE FUNCTION fail_booking_cancel_consistency() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test booking failure'; END; $$ LANGUAGE plpgsql`);
  await db.execute(sql`CREATE TRIGGER fail_booking_cancel_consistency BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION fail_booking_cancel_consistency()`);
}
async function allowBookingCancellation() {
  await db.execute(sql`DROP TRIGGER fail_booking_cancel_consistency ON bookings`);
  await db.execute(sql`DROP FUNCTION fail_booking_cancel_consistency()`);
}

describe("event and booking cancellation are one operation", () => {
  it("direct API deletion cancels the booking and notifies a guest who has no invite token", async () => {
    expect(await db.select().from(schema.eventInviteTokens)).toHaveLength(0);
    const response = await app.inject({ method: "DELETE", url: `/api/events/${event.id}`, headers: { cookie: auth } });
    expect(response.statusCode, response.body).toBe(204);
    const current = await state();
    expect(current.event.deletedAt).not.toBeNull();
    expect(current.booking.cancelledAt).toEqual(current.event.deletedAt);
    expect(vi.mocked(sendMail).mock.calls).toHaveLength(1);
    expect(vi.mocked(sendMail).mock.calls[0]![0].to).toBe("guest@example.com");
    expect(await deleteBookingLink(booking.linkId, owner.id)).toBe("deleted");
  });

  it("Outlook-origin deletion updates the booking in the same transaction", async () => {
    const side = adapter(), item = (await side.snapshot([])).get(event.id)!;
    await side.remove(item);
    const current = await state();
    expect(current.event.deletedAt).not.toBeNull();
    expect(current.booking.cancelledAt).toEqual(current.event.deletedAt);
    expect(vi.mocked(sendMail).mock.calls).toHaveLength(1);
    await side.remove(item);
    expect(vi.mocked(sendMail).mock.calls).toHaveLength(1);
  });

  it.each(["direct", "outlook"])("%s deletion rolls back if marking the booking cancelled fails", async (origin) => {
    const side = adapter(), item = (await side.snapshot([])).get(event.id)!;
    await failBookingCancellation();
    try {
      await expect(origin === "direct" ? cancelEvent(event.id, owner) : side.remove(item)).rejects.toThrow();
      const current = await state();
      expect(current.event.deletedAt).toBeNull();
      expect(current.booking.cancelledAt).toBeNull();
      expect(sendMail).not.toHaveBeenCalled();
      expect(requestCalendarSync).not.toHaveBeenCalled();
    } finally { await allowBookingCancellation(); }
  });

  it("repeat deletion repairs legacy booking state without sending another cancellation", async () => {
    const deletedAt = new Date(Date.now() - 1000);
    await db.update(schema.events).set({ deletedAt }).where(eq(schema.events.id, event.id));
    expect(await cancelEvent(event.id, owner)).toEqual({ ok: true, cancelledNotices: 0 });
    expect((await state()).booking.cancelledAt).toEqual(deletedAt);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("uses the linked booking guest's display zone only for that guest's cancellation notice", async () => {
    const startsAt = new Date("2026-11-16T01:00:00Z"), endsAt = new Date("2026-11-16T01:30:00Z");
    [event] = await db.update(schema.events).set({ startsAt, endsAt,
      extra: { timezone: "Australia/Melbourne", bookingGuestTimeZone: "Asia/Shanghai" } }).where(eq(schema.events.id, event.id)).returning() as [typeof event];
    await db.insert(schema.eventInviteTokens).values({ token: "other-invite", sourceEventId: event.id,
      recipientEmail: "invitee@example.com", expiresAt: new Date(Date.now() + 86400000) });
    const item = (await adapter().snapshot([])).get(event.id)!;
    expect(item.content.startsAt).toBe(startsAt.toISOString());
    expect(JSON.stringify(item.content)).not.toContain("bookingGuestTimeZone");
    expect(JSON.stringify(item.content)).not.toContain("Asia/Shanghai");
    await cancelEvent(event.id, owner);
    const mails = vi.mocked(sendMail).mock.calls.map(([mail]) => mail);
    const guest = mails.find(mail => mail.to === "guest@example.com")!, invited = mails.find(mail => mail.to === "invitee@example.com")!;
    expect(guest.text).toContain("09:00"); expect(guest.text).toContain("上海时间");
    expect(invited.text).toContain("12:00"); expect(invited.text).toContain("墨尔本时间");
    expect(mails).toHaveLength(2);
    for (const mail of mails) {
      expect(mail.icalEvent!.content).toContain("DTSTART:20261116T010000Z");
      expect(mail.icalEvent!.content).not.toContain("bookingGuestTimeZone");
      expect(mail.icalEvent!.content).not.toContain("Asia/Shanghai");
    }
  });

  it.each(["unlinked", "invalid"])("ignores guest display metadata when %s", async (state) => {
    await db.update(schema.events).set({ startsAt: new Date("2026-11-16T01:00:00Z"), endsAt: new Date("2026-11-16T01:30:00Z"),
      extra: { timezone: "Australia/Melbourne", bookingGuestTimeZone: state === "invalid" ? "invalid-zone" : "Asia/Shanghai" },
    }).where(eq(schema.events.id, event.id));
    if (state === "unlinked") {
      await db.update(schema.bookings).set({ eventId: null }).where(eq(schema.bookings.id, booking.id));
      await db.insert(schema.eventInviteTokens).values({ token: "old-guest-invite", sourceEventId: event.id,
        recipientEmail: "guest@example.com", expiresAt: new Date(Date.now() + 86400000) });
    }
    await cancelEvent(event.id, owner);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = vi.mocked(sendMail).mock.calls[0]![0];
    expect(mail.text).toContain("12:00"); expect(mail.text).toContain("墨尔本时间");
  });

  it("deduplicates the guest against existing invitations and retains awaited delivery", async () => {
    await db.insert(schema.eventInviteTokens).values({ token: "guest-invite", sourceEventId: event.id,
      recipientEmail: "GUEST@EXAMPLE.COM", expiresAt: new Date(Date.now() + 24 * 60 * 60_000) });
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(sendMail).mockImplementation(async () => { started(); await waiting; return { ok: true }; });
    let finished = false;
    const cancellation = cancelEvent(event.id, owner).then(result => { finished = true; return result; });
    await entered;
    const current = await state();
    expect(current.event.deletedAt).not.toBeNull();
    expect(current.booking.cancelledAt).not.toBeNull();
    expect(finished).toBe(false);
    release();
    expect(await cancellation).toEqual({ ok: true, cancelledNotices: 1 });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe("restoring a calendar copy does not reactivate the booking", () => {
  it("keeps booking cancelled and prevents its old cancel token deleting the restored event", async () => {
    await cancelEvent(event.id, owner);
    const cancelledAt = (await state()).booking.cancelledAt;
    const response = await app.inject({ method: "POST", url: `/api/events/${event.id}/restore`, headers: { cookie: auth } });
    expect(response.statusCode, response.body).toBe(200);
    let current = await state();
    expect(current.event.deletedAt).toBeNull();
    expect(current.booking.cancelledAt).toEqual(cancelledAt);
    expect(current.booking.eventId).toBeNull();
    expect(await cancelBooking(booking.cancelToken)).toEqual({ found: true, alreadyCancelled: true });
    current = await state();
    expect(current.event.deletedAt).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
    await cancelEvent(event.id, owner);
    expect(sendMail).toHaveBeenCalledTimes(1); // Detached booking guest is no longer a recipient.
  });

  it("restoring a legacy deleted event first closes its still-active booking", async () => {
    const deletedAt = new Date(Date.now() - 1000);
    await db.update(schema.events).set({ deletedAt }).where(eq(schema.events.id, event.id));
    const response = await app.inject({ method: "POST", url: `/api/events/${event.id}/restore`, headers: { cookie: auth } });
    expect(response.statusCode).toBe(200);
    const current = await state();
    expect(current.event.deletedAt).toBeNull();
    expect(current.booking.cancelledAt).toEqual(deletedAt);
    expect(current.booking.eventId).toBeNull();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("idempotent restore of a live event leaves its active booking unchanged", async () => {
    const response = await app.inject({ method: "POST", url: `/api/events/${event.id}/restore`, headers: { cookie: auth } });
    expect(response.statusCode).toBe(200);
    const current = await state();
    expect(current.booking.cancelledAt).toBeNull();
    expect(current.booking.eventId).toBe(event.id);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
