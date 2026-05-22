import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { invitationIcs } from "./ical.js";
import { sendMail } from "./mailer.js";
import { eventCancelMail } from "./email_templates.js";

// Soft-delete the event and email a METHOD:CANCEL .ics to anyone who was
// invited. Idempotent — if the event is already in the deleted state we
// just return without re-firing emails.
export async function cancelEvent(eventId: string, deletedBy: { id: string; email: string; displayName: string | null }): Promise<{ ok: boolean; cancelledNotices: number }> {
  const [event] = await db.select().from(schema.events).where(eq(schema.events.id, eventId)).limit(1);
  if (!event) return { ok: false, cancelledNotices: 0 };
  if (event.deletedAt) return { ok: true, cancelledNotices: 0 };

  // Mark soft-deleted first so concurrent reads see "已取消" immediately.
  await db
    .update(schema.events)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.events.id, eventId));

  // Collect every distinct attendee email we ever invited to this event.
  const tokens = await db
    .select()
    .from(schema.eventInviteTokens)
    .where(eq(schema.eventInviteTokens.sourceEventId, eventId));
  const recipients = Array.from(new Set(tokens.map((t) => t.recipientEmail.toLowerCase())));
  if (recipients.length === 0) return { ok: true, cancelledNotices: 0 };

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
        // Carry the event's IANA zone so the CANCEL email shows the same
        // wall-clock the user originally saw, not the server's UTC view.
        timezone: (event.extra as { timezone?: string } | null)?.timezone ?? null,
        icsBody: ics,
      }));
      sent++;
    } catch (_e) {
      // log only — don't fail the cancel because of mailer issues
    }
  }
  return { ok: true, cancelledNotices: sent };
}
