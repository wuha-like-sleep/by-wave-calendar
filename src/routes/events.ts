import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";
import { newEventUid, newInvitationToken } from "../lib/ids.js";
import { invitationIcs } from "../lib/ical.js";
import { sendMail } from "../lib/mailer.js";
import { eventInviteMail } from "../lib/email_templates.js";
import { cancelEvent } from "../lib/event_cancel.js";
import { expandEvent } from "../lib/rrule_expand.js";
import { dispatchWebhook, eventToWebhookPayload } from "../lib/webhooks.js";
import { pushEventChanged } from "../lib/apns.js";
import { ok, okList, err } from "../lib/api_response.js";

const isoDate = z.string().datetime({ offset: true });

const extraSchema = z.object({
  category: z.string().max(50).optional(),
  timezone: z.string().max(100).optional(),
  attendees: z.array(z.string().email().max(254)).max(50).optional(),
}).optional();

const createSchema = z.object({
  calendarId: z.string().uuid(),
  summary: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  startsAt: isoDate,
  endsAt: isoDate,
  allDay: z.boolean().optional(),
  rrule: z.string().max(500).optional(),
  extra: extraSchema,
});

// Update accepts calendarId too so apps can move an event between
// calendars the user owns. Ownership is verified at apply time
// (loadOwnedEvent + ownsCalendar check) so a malicious request can't
// drop an event into someone else's calendar.
const updateSchema = createSchema.partial();

const idParam = z.object({ id: z.string().uuid() });

export async function eventRoutes(app: FastifyInstance) {
  // Fetch events across all (or a subset of) user's calendars in a date range.
  // Used by the calendar app view to populate the grid.
  app.get("/events", async (req, reply) => {
    const user = await requireUser(req, reply);
    const q = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        calendarIds: z.string().optional(),
      })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "bad_query" });

    const fromDate = new Date(q.data.from);
    const toDate = new Date(q.data.to);

    const owned = await db
      .select({
        id: schema.calendars.id,
        name: schema.calendars.name,
        color: schema.calendars.color,
        timezone: schema.calendars.timezone,
      })
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id));
    const shared = await db
      .select({
        id: schema.calendars.id,
        name: schema.calendars.name,
        color: schema.calendars.color,
        timezone: schema.calendars.timezone,
      })
      .from(schema.calendars)
      .innerJoin(schema.calendarMembers, eq(schema.calendarMembers.calendarId, schema.calendars.id))
      .where(eq(schema.calendarMembers.userId, user.id));

    const ownedIds = new Set(owned.map((c) => c.id));
    const visibleIds = new Set([...ownedIds, ...shared.map((c) => c.id)]);
    const visible = [...owned, ...shared.filter((c) => !ownedIds.has(c.id))];
    let allowed = Array.from(visibleIds);
    if (q.data.calendarIds) {
      const requested = q.data.calendarIds.split(",").filter(Boolean);
      allowed = requested.filter((id) => visibleIds.has(id));
    }
    if (allowed.length === 0) return reply.send({ calendars: visible, events: [] });

    // Pull master rows. For non-recurring events the existing
    // window filter `startsAt <= toDate AND endsAt >= fromDate` is correct.
    // For recurring events (rrule IS NOT NULL), we have to also accept any
    // master whose startsAt is BEFORE the window — its later occurrences
    // could still fall inside [fromDate, toDate]. So we union two queries:
    //   non-recurring overlapping the window, OR recurring with startsAt < toDate.
    const rows = await db
      .select()
      .from(schema.events)
      .where(
        and(
          inArray(schema.events.calendarId, allowed),
          lte(schema.events.startsAt, toDate),
          // Master row that STARTS before window is fine — only filter out
          // non-recurring masters that ALSO ended before the window.
          // SQL: (endsAt >= fromDate OR rrule IS NOT NULL)
          // Drizzle doesn't have a clean `or` import here, so we widen
          // to all events ending after fromDate-1y, then JS-filter below.
          // This stays cheap because allowed[] already scopes to user.
          gte(schema.events.endsAt, new Date(fromDate.getTime() - 365 * 24 * 60 * 60 * 1000)),
          isNull(schema.events.deletedAt),
        ),
      )
      .orderBy(asc(schema.events.startsAt));

    // Expand RRULE master rows into per-occurrence entries. Non-recurring
    // events come through unchanged. Each occurrence carries the same id
    // as its master so the client can route edits/deletes consistently.
    const expanded: Array<typeof rows[number] & { startsAt: Date; endsAt: Date; isOccurrence: boolean }> = [];
    for (const row of rows) {
      const occurrences = expandEvent(
        {
          id: row.id,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          rrule: row.rrule ?? null,
          exdates: (row.exdates as string[] | null) ?? null,
        },
        fromDate,
        toDate,
      );
      for (const occ of occurrences) {
        expanded.push({ ...row, startsAt: occ.startsAt, endsAt: occ.endsAt, isOccurrence: occ.isOccurrence });
      }
    }

    return reply.send({ calendars: visible, events: expanded });
  });

  app.get("/calendars/:id/events", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    if (!(await ownsCalendar(id, user.id))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const rows = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, id), isNull(schema.events.deletedAt)))
      .orderBy(asc(schema.events.startsAt));
    return reply.send(rows);
  });

  // Cheap overlap check for the client — POST so we can keep tomorrow's
  // "exclude editing self" form clean without putting an event UUID in the URL.
  app.post("/events/conflicts", async (req, reply) => {
    const user = await requireUser(req, reply);
    const body = z.object({
      calendarId: z.string().uuid(),
      startsAt: isoDate,
      endsAt: isoDate,
      excludeId: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.send({ conflicts: [] });
    const starts = new Date(body.data.startsAt);
    const ends = new Date(body.data.endsAt);
    // Find overlapping events across all calendars the user can see.
    const visible = await db
      .select({ id: schema.calendars.id })
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id));
    const ids = visible.map((v) => v.id);
    if (ids.length === 0) return reply.send({ conflicts: [] });
    const rows = await db
      .select({ id: schema.events.id, summary: schema.events.summary, startsAt: schema.events.startsAt, endsAt: schema.events.endsAt })
      .from(schema.events)
      .where(and(
        inArray(schema.events.calendarId, ids),
        lte(schema.events.startsAt, ends),
        gte(schema.events.endsAt, starts),
        isNull(schema.events.deletedAt),
      ))
      .limit(20);
    const conflicts = rows.filter((r) => !body.data.excludeId || r.id !== body.data.excludeId);
    return reply.send({ conflicts });
  });

  app.post("/events", async (req, reply) => {
    const user = await requireUser(req, reply);
    const body = createSchema.parse(req.body);
    if (!(await ownsCalendar(body.calendarId, user.id))) {
      return reply.code(404).send({ error: "calendar_not_found" });
    }
    if (new Date(body.endsAt) < new Date(body.startsAt)) {
      return reply.code(400).send({ error: "ends_before_starts" });
    }
    const [row] = await db
      .insert(schema.events)
      .values({
        calendarId: body.calendarId,
        uid: newEventUid(),
        summary: body.summary,
        description: body.description,
        location: body.location,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        allDay: body.allDay ?? false,
        rrule: body.rrule,
        extra: body.extra as unknown as object | null,
      })
      .returning();

    // Fire-and-forget RSVP emails to attendees listed in extra.attendees.
    // The email carries a METHOD:REQUEST .ics so Gmail / Outlook / Apple Mail
    // render the "Add to calendar" / "Yes / Maybe / No" buttons natively.
    const extra = (body.extra as { attendees?: string[]; timezone?: string } | null) ?? null;
    if (row && extra && Array.isArray(extra.attendees) && extra.attendees.length > 0) {
      const organizerName = user.displayName || user.email;
      const ics = invitationIcs({
        event: {
          uid: row.uid,
          summary: row.summary,
          description: row.description,
          location: row.location,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          allDay: row.allDay,
          updatedAt: row.updatedAt,
        },
        organizerEmail: user.email,
        organizerName,
        attendees: extra.attendees.map((email) => ({ email })),
        method: "REQUEST",
      });
      const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
      for (const to of extra.attendees) {
        const trimmed = to.trim();
        if (!trimmed || !trimmed.includes("@")) continue;
        // Generate a per-recipient token so the "添加到我的日历" button in the
        // email can jump back to the app and add the event with one click.
        const inviteToken = newInvitationToken();
        try {
          await db.insert(schema.eventInviteTokens).values({
            token: inviteToken,
            sourceEventId: row.id,
            recipientEmail: trimmed.toLowerCase(),
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          });
        } catch (err) {
          req.log.warn({ err, to: trimmed }, "event_invite_token_failed");
        }
        sendMail(eventInviteMail(trimmed, {
          organizerEmail: user.email,
          organizerName,
          summary: row.summary,
          description: row.description,
          location: row.location,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          allDay: row.allDay,
          uid: row.uid,
          // Pass the event's stored timezone so the email shows
          // "上海下午6点" rather than the server's UTC equivalent.
          timezone: extra.timezone ?? null,
          icsBody: ics,
          inviteToken,
        })).catch((err) => req.log.warn({ err, to: trimmed }, "event_invite_mail_failed"));
      }
    }
    // Fire-and-forget webhook dispatch. Failures are logged in the
    // webhook_deliveries table; never blocks the API response.
    if (row) {
      void dispatchWebhook("event.created", eventToWebhookPayload(row)).catch(() => undefined);
      // Silent push to the calendar owner's iOS devices so the APP
      // refreshes within seconds. No-op when APNs isn't configured.
      void pushEventChanged(user.id, row.id, "event.created").catch(() => undefined);
    }
    return reply.code(201).send(row);
  });

  // Validation: scope (this/future/series) + recurrenceId (the original
  // instance start). When scope=this or scope=future we MUST have a
  // recurrenceId to know which occurrence the user means.
  const recurringScopeSchema = z.object({
    scope: z.enum(["instance", "future", "series"]).optional(),
    recurrenceId: z.string().datetime({ offset: true }).optional(),
  }).optional();

  app.patch("/events/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    // PATCH body may carry our recurring-scope fields alongside the
    // event fields. updateSchema is .partial() so unknown keys are
    // tolerated; we just pull scope/recurrenceId out before passing.
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const scopeParsed = recurringScopeSchema.safeParse({
      scope: rawBody.scope, recurrenceId: rawBody.recurrenceId,
    });
    const scope = scopeParsed.success ? scopeParsed.data?.scope ?? "series" : "series";
    const recurrenceIso = scopeParsed.success ? scopeParsed.data?.recurrenceId : undefined;
    const body = updateSchema.parse({ ...rawBody, scope: undefined, recurrenceId: undefined });

    const target = await loadOwnedEvent(id, user.id);
    if (!target) return reply.code(404).send({ error: "not_found" });

    const isRecurring = !!target.rrule;

    // --- scope=instance: detach this occurrence from the series ---
    // Implementation: add the original instance start to master.exdates
    // (so rrule_expand skips it), then create a NEW standalone (non-
    // recurring) event with the user's edits + the new start/end.
    if (isRecurring && scope === "instance" && recurrenceIso) {
      const recurrenceDate = new Date(recurrenceIso);
      const existingExdates: string[] = Array.isArray(target.exdates) ? target.exdates as string[] : [];
      const newExdates = [...existingExdates, recurrenceDate.toISOString()];

      // The instance the user is editing — if they didn't change start/end,
      // default to the original recurrence time + master's duration.
      const masterDuration = target.endsAt.getTime() - target.startsAt.getTime();
      const newStart = body.startsAt ? new Date(body.startsAt) : recurrenceDate;
      const newEnd = body.endsAt ? new Date(body.endsAt) : new Date(recurrenceDate.getTime() + masterDuration);

      const [detached] = await db.insert(schema.events).values({
        calendarId: target.calendarId,
        uid: newEventUid(),
        summary: body.summary ?? target.summary,
        description: body.description ?? target.description,
        location: body.location ?? target.location,
        startsAt: newStart,
        endsAt: newEnd,
        allDay: body.allDay ?? target.allDay,
        rrule: null,  // detached instance is not recurring
        extra: body.extra !== undefined ? (body.extra as unknown as object | null) : (target.extra as object | null),
      }).returning();

      await db.update(schema.events).set({ exdates: newExdates, updatedAt: new Date() }).where(eq(schema.events.id, id));
      if (detached) {
        void dispatchWebhook("event.updated", eventToWebhookPayload(detached)).catch(() => undefined);
        void pushEventChanged(user.id, detached.id, "event.updated").catch(() => undefined);
      }
      return reply.send(detached);
    }

    // --- scope=future: split the series at this occurrence ---
    // Master gets UNTIL=instance-1s appended to its RRULE (so existing
    // earlier occurrences survive). A new standalone master starts at the
    // chosen instance with the user's edits and same/edited RRULE.
    if (isRecurring && scope === "future" && recurrenceIso) {
      const recurrenceDate = new Date(recurrenceIso);
      // RRULE UNTIL: ISO basic format YYYYMMDDTHHMMSSZ
      const untilUtc = new Date(recurrenceDate.getTime() - 1000)
        .toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const oldRrule = target.rrule || "";
      // Strip any existing UNTIL= before adding ours, otherwise PG winds
      // up with conflicting clauses (rrule lib just takes the first).
      const cleanedRrule = oldRrule.split(";").filter((p) => !/^UNTIL=/i.test(p)).join(";");
      const newMasterRrule = cleanedRrule + ";UNTIL=" + untilUtc;
      await db.update(schema.events).set({ rrule: newMasterRrule, updatedAt: new Date() }).where(eq(schema.events.id, id));

      const masterDuration = target.endsAt.getTime() - target.startsAt.getTime();
      const newStart = body.startsAt ? new Date(body.startsAt) : recurrenceDate;
      const newEnd = body.endsAt ? new Date(body.endsAt) : new Date(recurrenceDate.getTime() + masterDuration);

      const [newMaster] = await db.insert(schema.events).values({
        calendarId: target.calendarId,
        uid: newEventUid(),
        summary: body.summary ?? target.summary,
        description: body.description ?? target.description,
        location: body.location ?? target.location,
        startsAt: newStart,
        endsAt: newEnd,
        allDay: body.allDay ?? target.allDay,
        rrule: body.rrule ?? cleanedRrule,
        extra: body.extra !== undefined ? (body.extra as unknown as object | null) : (target.extra as object | null),
      }).returning();
      if (newMaster) {
        void dispatchWebhook("event.updated", eventToWebhookPayload(newMaster)).catch(() => undefined);
        void pushEventChanged(user.id, newMaster.id, "event.updated").catch(() => undefined);
      }
      return reply.send(newMaster);
    }

    // --- scope=series (default) OR non-recurring: regular patch ---
    // If the user wants to move the event to a different calendar, confirm
    // they actually own that calendar — otherwise they could drop an event
    // into someone else's calendar via a crafted PATCH.
    if (body.calendarId && body.calendarId !== target.calendarId) {
      if (!(await ownsCalendar(body.calendarId, user.id))) {
        return reply.code(403).send({ error: "target_calendar_not_owned" });
      }
    }
    const [row] = await db
      .update(schema.events)
      .set({
        calendarId: body.calendarId ?? undefined,
        summary: body.summary ?? undefined,
        description: body.description ?? undefined,
        location: body.location ?? undefined,
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
        allDay: body.allDay ?? undefined,
        rrule: body.rrule ?? undefined,
        extra: body.extra !== undefined ? (body.extra as unknown as object | null) : undefined,
        // The web UI doesn't (yet) edit ATTENDEE / VALARM / TRANSP, so discard the
        // raw VEVENT after a manual edit — CalDAV clients will pick up the synthesized
        // version on next REPORT instead of seeing stale ATTENDEE/VALARM that no
        // longer match the new summary/time.
        rawIcs: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.events.id, id))
      .returning();
    if (row) {
      void dispatchWebhook("event.updated", eventToWebhookPayload(row)).catch(() => undefined);
      void pushEventChanged(user.id, row.id, "event.updated").catch(() => undefined);
    }
    return reply.send(row);
  });

  app.delete("/events/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    const parsed = idParam.safeParse(req.params);
    // Fully idempotent: a malformed ID (e.g. iOS sometimes hands us its
    // internal token rather than our UUID, or the modal lost state during
    // a sync) just resolves as "already gone" so the user-facing UI doesn't
    // surface 400/404 noise when re-clicking a stale row.
    if (!parsed.success) {
      req.log.info({ raw: (req.params as { id?: string }).id, userId: user.id }, "event_delete_bad_id");
      return reply.code(204).send();
    }
    const target = await loadOwnedEvent(parsed.data.id, user.id);
    if (!target) {
      return reply.code(204).send();
    }
    // Parse scope from the query string (DELETE has no body).
    const q = (req.query ?? {}) as { scope?: string; recurrenceId?: string };
    const scope = q.scope === "instance" || q.scope === "future" ? q.scope : "series";
    const recurrenceIso = q.recurrenceId;
    const isRecurring = !!target.rrule;

    if (isRecurring && scope === "instance" && recurrenceIso) {
      // Add to exdates and keep master alive.
      const recurrenceDate = new Date(recurrenceIso);
      const existingExdates: string[] = Array.isArray(target.exdates) ? target.exdates as string[] : [];
      const newExdates = [...existingExdates, recurrenceDate.toISOString()];
      await db.update(schema.events).set({ exdates: newExdates, updatedAt: new Date() }).where(eq(schema.events.id, parsed.data.id));
      return reply.code(204).send();
    }
    if (isRecurring && scope === "future" && recurrenceIso) {
      const recurrenceDate = new Date(recurrenceIso);
      const untilUtc = new Date(recurrenceDate.getTime() - 1000)
        .toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const cleanedRrule = (target.rrule || "").split(";").filter((p) => !/^UNTIL=/i.test(p)).join(";");
      await db.update(schema.events).set({
        rrule: cleanedRrule + ";UNTIL=" + untilUtc, updatedAt: new Date(),
      }).where(eq(schema.events.id, parsed.data.id));
      return reply.code(204).send();
    }

    // Default / non-recurring: soft-delete the entire event and fire
    // CANCEL emails to anyone we ever invited. The row stays so
    // /event-invite/:token can render a "已取消" notice.
    await cancelEvent(parsed.data.id, { id: user.id, email: user.email, displayName: user.displayName });
    void dispatchWebhook("event.deleted", eventToWebhookPayload(target)).catch(() => undefined);
    void pushEventChanged(user.id, target.id, "event.deleted").catch(() => undefined);
    return reply.code(204).send();
  });

  // Restore a soft-deleted event. Powers the toast 撤销 button — the
  // user just deleted something and immediately wants it back. Idempotent.
  // Only the owner of the calendar can restore. CANCEL emails already
  // sent stay sent — we don't try to "un-cancel" iMIP, that's a no-go.
  app.post("/events/:id/restore", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    // Load the soft-deleted row (loadOwnedEvent filters out deletedAt,
    // so we query directly with the ownership join).
    const [row] = await db
      .select({ event: schema.events })
      .from(schema.events)
      .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
      .where(and(eq(schema.events.id, id), eq(schema.calendars.ownerId, user.id)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (!row.event.deletedAt) {
      // Already alive — idempotent ok.
      return reply.send(row.event);
    }
    const [restored] = await db
      .update(schema.events)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(schema.events.id, id))
      .returning();
    if (restored) {
      void dispatchWebhook("event.updated", eventToWebhookPayload(restored)).catch(() => undefined);
      void pushEventChanged(user.id, restored.id, "event.restored").catch(() => undefined);
    }
    return reply.send(restored);
  });
}

async function ownsCalendar(calendarId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.calendars.id })
    .from(schema.calendars)
    .where(and(eq(schema.calendars.id, calendarId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return rows.length > 0;
}

async function loadOwnedEvent(eventId: string, userId: string) {
  const rows = await db
    .select({ event: schema.events })
    .from(schema.events)
    .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
    .where(and(eq(schema.events.id, eventId), eq(schema.calendars.ownerId, userId), isNull(schema.events.deletedAt)))
    .limit(1);
  return rows[0]?.event ?? null;
}
