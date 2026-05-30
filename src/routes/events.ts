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
  // v1.3.3 — `url` field for meeting/doc link (separate from `description`).
  // The web event-editor form has had this input forever, and the web JS
  // even includes it in the POST body, but Zod's default `strip` was
  // silently dropping it on the server because the schema didn't list
  // it. Result: link saved → forgotten → user thinks the field is broken.
  url: z.string().url().max(2000).optional(),
  // Web event-editor reminder block — array of { trigger, action,
  // description }. Same "silently stripped" story as `url` above. We
  // don't deeply validate the alarm shape here (CalDAV/.ics has a much
  // richer schema and the web only emits a narrow subset); just accept
  // an array of objects under the limit and round-trip through JSONB.
  alarms: z.array(z.object({
    trigger: z.string().max(50),
    action: z.string().max(20).optional(),
    description: z.string().max(500).optional(),
  })).max(8).optional(),
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
  // Optional client-generated idempotency key. When set, the server
  // stores it as the event's iCalendar uid (UNIQUE per calendar) so a
  // retried create — e.g. the offline outbox replaying a create whose
  // HTTP response was lost after the server already committed — collapses
  // onto the first row instead of inserting a duplicate. This is the fix
  // for "one event became three copies". Clients should generate it once
  // per new event and reuse it across retries.
  clientUid: z.string().min(1).max(255).optional(),
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
    // Optional ?eventId=<uuid> — return just that one event. The calendar
    // grid's clickEvent uses this to fetch the full (extra-bearing) event
    // when the user opens a detail, instead of pulling the WHOLE calendar's
    // event list (potentially thousands of rows) just to find one by id.
    // Absent → original behavior (all live events), so old clients are
    // unaffected.
    const q = z.object({ eventId: z.string().uuid().optional() }).safeParse(req.query);
    const conds = [eq(schema.events.calendarId, id), isNull(schema.events.deletedAt)];
    if (q.success && q.data.eventId) conds.push(eq(schema.events.id, q.data.eventId));
    const rows = await db
      .select()
      .from(schema.events)
      .where(and(...conds))
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

    // Idempotent create. A client may legitimately send the SAME create
    // more than once — classically when the server commits the INSERT but
    // the HTTP response is dropped on a flaky network, so the client (the
    // offline outbox, or a user re-tapping "save") retries. Without a
    // stable key every retry minted a fresh uid and inserted a duplicate
    // row: the root cause of "one event became three". When the client
    // supplies `clientUid`, we use it as the event's uid (UNIQUE per
    // calendar) so retries land on the first row.
    const stableUid = body.clientUid?.trim();
    if (stableUid) {
      const [existing] = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.calendarId, body.calendarId), eq(schema.events.uid, stableUid)))
        .limit(1);
      if (existing) {
        // Already created under this key → idempotent success. Crucially
        // we return BEFORE the invite-email / webhook / push side effects
        // so a retry never re-notifies attendees.
        return reply.code(200).send(existing);
      }
    }

    // Content-level dedup — "完全一样的只记录一次".
    //
    // clientUid above only catches a retry of the SAME create. The user's
    // duplicates came from DIFFERENT sources (multiple devices / an import)
    // each POSTing a byte-identical event with its own (or no) key, so the
    // uid check couldn't see them as the same. Here we treat a create whose
    // every user-visible field exactly matches an existing LIVE event in the
    // same calendar as a duplicate, and return that row instead of inserting
    // another copy. Tradeoff: a user genuinely wanting two identical events
    // at the same time gets one — acceptable per the explicit "identical →
    // record once" request, and astronomically rarer than the dup bug.
    {
      const startsAt = new Date(body.startsAt);
      const endsAt = new Date(body.endsAt);
      const candidates = await db
        .select()
        .from(schema.events)
        .where(and(
          eq(schema.events.calendarId, body.calendarId),
          isNull(schema.events.deletedAt),
          eq(schema.events.summary, body.summary),
          eq(schema.events.startsAt, startsAt),
          eq(schema.events.endsAt, endsAt),
        ));
      const norm = (s: string | null | undefined): string => (s ?? "");
      const matches = candidates.filter((c) =>
        c.allDay === (body.allDay ?? false) &&
        norm(c.rrule) === norm(body.rrule) &&
        norm(c.description) === norm(body.description) &&
        norm(c.location) === norm(body.location),
      );
      // Return the OLDEST match (candidates come back in no particular order;
      // pick the earliest createdAt so repeat calls converge on one row).
      if (matches.length > 0) {
        const oldest = matches.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
        return reply.code(200).send(oldest);
      }
    }

    let row: typeof schema.events.$inferSelect | undefined;
    try {
      [row] = await db
        .insert(schema.events)
        .values({
          calendarId: body.calendarId,
          uid: stableUid || newEventUid(),
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
    } catch (e) {
      // A concurrent retry won the race on UNIQUE(calendarId, uid). Return
      // the row it created instead of surfacing a 500 — still idempotent.
      const msg = e instanceof Error ? e.message : "";
      if (stableUid && (msg.includes("duplicate") || msg.includes("unique"))) {
        const [existing] = await db
          .select()
          .from(schema.events)
          .where(and(eq(schema.events.calendarId, body.calendarId), eq(schema.events.uid, stableUid)))
          .limit(1);
        if (existing) return reply.code(200).send(existing);
      }
      throw e;
    }

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

  // ---------- Event attendees (JSON endpoints mirroring web flow) ----------
  // The web has its own form-based attendees page under
  // /app/events/:id/attendees; these JSON endpoints expose the same
  // semantics for native APP clients. Mirror: extra.attendees array
  // on the event row + per-recipient tokens in event_invite_tokens.

  app.get<{ Params: { id: string } }>("/events/:id/attendees", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const event = await loadOwnedEvent(id, user.id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    const extra = (event.extra as { attendees?: string[] } | null) ?? {};
    const attendees = Array.isArray(extra.attendees) ? extra.attendees : [];
    const tokens = await db
      .select()
      .from(schema.eventInviteTokens)
      .where(eq(schema.eventInviteTokens.sourceEventId, event.id))
      .orderBy(asc(schema.eventInviteTokens.createdAt));
    return reply.send({
      attendees,
      tokens: tokens.map((t) => ({
        token: t.token,
        recipientEmail: t.recipientEmail,
        createdAt: t.createdAt.toISOString(),
        expiresAt: t.expiresAt.toISOString(),
        acceptedAt: t.acceptedAt?.toISOString() ?? null,
      })),
    });
  });

  // Invite one email. Same flow as the web POST /attendees/invite —
  // adds to extra.attendees, creates a token row, sends .ics email.
  app.post<{ Params: { id: string } }>("/events/:id/attendees", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const body = z.object({
      email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_email" });
    const event = await loadOwnedEvent(id, user.id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    const extra = (event.extra as Record<string, unknown> | null) ?? {};
    const current = Array.isArray(extra.attendees) ? (extra.attendees as string[]) : [];
    if (current.includes(body.data.email)) {
      return reply.code(409).send({ error: "already_invited", message: `${body.data.email} 已是参与者` });
    }
    const next = [...current, body.data.email];
    await db.update(schema.events)
      .set({ extra: { ...extra, attendees: next }, updatedAt: new Date() })
      .where(eq(schema.events.id, event.id));

    const inviteToken = newInvitationToken();
    try {
      await db.insert(schema.eventInviteTokens).values({
        token: inviteToken,
        sourceEventId: event.id,
        recipientEmail: body.data.email,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
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
        organizerEmail: user.email,
        organizerName: user.displayName || user.email,
        attendees: [{ email: body.data.email }],
        method: "REQUEST",
      });
      await sendMail(eventInviteMail(body.data.email, {
        organizerEmail: user.email,
        organizerName: user.displayName || user.email,
        summary: event.summary,
        description: event.description,
        location: event.location,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        uid: event.uid,
        timezone: (event.extra as { timezone?: string } | null)?.timezone ?? null,
        icsBody: ics,
        inviteToken,
      }));
    } catch (err) {
      req.log.warn({ err, to: body.data.email }, "event_invite_send_failed");
      return reply.code(207).send({
        ok: true,
        warning: "added_but_mail_failed",
        message: `${body.data.email} 已添加为参与者，但邀请邮件发送失败`,
      });
    }
    return reply.send({ ok: true, email: body.data.email });
  });

  // Revoke. iOS sends email in body (avoid URL-encoding @ in path).
  app.delete<{ Params: { id: string } }>("/events/:id/attendees", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const body = z.object({
      email: z.string().email().transform((s) => s.toLowerCase().trim()),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_email" });
    const event = await loadOwnedEvent(id, user.id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    const extra = (event.extra as Record<string, unknown> | null) ?? {};
    const current = Array.isArray(extra.attendees) ? (extra.attendees as string[]) : [];
    const next = current.filter((e) => e !== body.data.email);
    await db.update(schema.events)
      .set({ extra: { ...extra, attendees: next }, updatedAt: new Date() })
      .where(eq(schema.events.id, event.id));
    await db.delete(schema.eventInviteTokens).where(and(
      eq(schema.eventInviteTokens.sourceEventId, event.id),
      eq(schema.eventInviteTokens.recipientEmail, body.data.email),
      isNull(schema.eventInviteTokens.acceptedAt),
    ));
    return reply.send({ ok: true });
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
