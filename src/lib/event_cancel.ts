import { and, isNull, eq } from "drizzle-orm";
import { db, schema, type DB } from "../db/client.js";
import { invitationIcs } from "./ical.js";
import { sendMail } from "./mailer.js";
import { eventCancelMail } from "./email_templates.js";
import { requestCalendarSync } from "./calendar_sync/queue.js";
import { pushEventChanged } from "./apns.js";
import { canonicalTimeZone } from "./zoned_time.js";

/** Use within the event-deletion transaction, after locking the event row. */
export async function markEventBookingsCancelled(tx: Pick<DB, "update">, eventId: string, cancelledAt: Date): Promise<void> {
  await tx.update(schema.bookings).set({ cancelledAt })
    .where(and(eq(schema.bookings.eventId, eventId), isNull(schema.bookings.cancelledAt)));
}

// Soft-delete the event and its booking together, then email a METHOD:CANCEL
// .ics to invitees. Repeated deletion heals legacy booking state without
// re-firing emails.
export async function cancelEvent(eventId: string, deletedBy: { id: string; email: string; displayName: string | null }): Promise<{ ok: boolean; cancelledNotices: number }> {
  const result = await db.transaction(async (tx) => {
    const [event] = await tx.select().from(schema.events).where(eq(schema.events.id, eventId)).for("update");
    if (!event) return { found: false, event: null };
    const cancelledAt = event.deletedAt ?? new Date();
    if (!event.deletedAt) await tx.update(schema.events)
      .set({ deletedAt: cancelledAt, updatedAt: cancelledAt }).where(eq(schema.events.id, eventId));
    await markEventBookingsCancelled(tx, eventId, cancelledAt);
    return { found: true, event: event.deletedAt ? null : event };
  });
  if (!result.event) return { ok: result.found, cancelledNotices: 0 };
  await requestCalendarSync(result.event.calendarId).catch(() => undefined);

  return notifyEventCancellation(result.event, deletedBy);
}

/** Called after a conditional deletion has committed. */
export async function notifyEventCancellation(event: schema.Event, deletedBy: { id: string; email: string; displayName: string | null }): Promise<{ ok: boolean; cancelledNotices: number }> {
  const eventId = event.id;
  void pushEventChanged(deletedBy.id, eventId, "event.deleted").catch(() => undefined);
  // Public bookings send confirmation directly and have no invite-token row.
  // Include their guests so deleting the event actually notifies them too.
  const [tokens, bookings] = await Promise.all([
    db.select().from(schema.eventInviteTokens).where(eq(schema.eventInviteTokens.sourceEventId, eventId)),
    db.select({ guestEmail: schema.bookings.guestEmail }).from(schema.bookings).where(eq(schema.bookings.eventId, eventId)),
  ]);
  const recipients = Array.from(new Set([...tokens.map((t) => t.recipientEmail), ...bookings.map((b) => b.guestEmail)]
    .map((email) => email.trim().toLowerCase())));
  if (recipients.length === 0) return { ok: true, cancelledNotices: 0 };
  const bookingRecipients = new Set(bookings.map(booking => booking.guestEmail.trim().toLowerCase()));
  const extra = event.extra as { timezone?: unknown; bookingGuestTimeZone?: unknown } | null;
  const eventTimeZone = canonicalTimeZone(extra?.timezone);
  const guestTimeZone = canonicalTimeZone(extra?.bookingGuestTimeZone);

  const organizerName = deletedBy.displayName || deletedBy.email;
  const ics = invitationIcs({
    event: {
      uid: event.uid,
      summary: event.summary,
      description: event.description,
      location: event.location,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: event.allDay,
      updatedAt: new Date(),
    },
    organizerEmail: deletedBy.email,
    organizerName,
    attendees: recipients.map((email) => ({ email })),
    method: "CANCEL",
    // SEQUENCE must increment for clients to honor CANCEL; bump by 1 each cancel.
    sequence: 1,
  });

  let sent = 0;
  for (const to of recipients) {
    try {
      await sendMail(eventCancelMail(to, {
        organizerEmail: deletedBy.email,
        organizerName,
        summary: event.summary,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        // Only the linked booking guest gets their own display preference.
        // Invitations keep the event zone; the ICS always keeps UTC instants.
        timezone: bookingRecipients.has(to) ? guestTimeZone ?? eventTimeZone : eventTimeZone,
        icsBody: ics,
      }));
      sent++;
    } catch (_e) {
      // log only — don't fail the cancel because of mailer issues
    }
  }
  return { ok: true, cancelledNotices: sent };
}
