import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";
import { newEventUid } from "../lib/ids.js";

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

const updateSchema = createSchema.omit({ calendarId: true }).partial();

const idParam = z.object({ id: z.string().uuid() });

export async function eventRoutes(app: FastifyInstance) {
  // Fetch events across all (or a subset of) user's calendars in a date range.
  // Used by the calendar app view to populate the grid.
  app.get("/api/events", async (req, reply) => {
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

    const ownedIds = new Set(owned.map((c) => c.id));
    let allowed = Array.from(ownedIds);
    if (q.data.calendarIds) {
      const requested = q.data.calendarIds.split(",").filter(Boolean);
      allowed = requested.filter((id) => ownedIds.has(id));
    }
    if (allowed.length === 0) return reply.send({ calendars: owned, events: [] });

    const rows = await db
      .select()
      .from(schema.events)
      .where(
        and(
          inArray(schema.events.calendarId, allowed),
          lte(schema.events.startsAt, toDate),
          gte(schema.events.endsAt, fromDate),
        ),
      )
      .orderBy(asc(schema.events.startsAt));

    return reply.send({ calendars: owned, events: rows });
  });

  app.get("/api/calendars/:id/events", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    if (!(await ownsCalendar(id, user.id))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const rows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.calendarId, id))
      .orderBy(asc(schema.events.startsAt));
    return reply.send(rows);
  });

  app.post("/api/events", async (req, reply) => {
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
    return reply.code(201).send(row);
  });

  app.patch("/api/events/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const target = await loadOwnedEvent(id, user.id);
    if (!target) return reply.code(404).send({ error: "not_found" });
    const [row] = await db
      .update(schema.events)
      .set({
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
    return reply.send(row);
  });

  app.delete("/api/events/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const target = await loadOwnedEvent(id, user.id);
    if (!target) return reply.code(404).send({ error: "not_found" });
    await db.delete(schema.events).where(eq(schema.events.id, id));
    return reply.send({ ok: true });
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
    .where(and(eq(schema.events.id, eventId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return rows[0]?.event ?? null;
}
