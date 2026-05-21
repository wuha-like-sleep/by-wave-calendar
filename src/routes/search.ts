// Cmd+K command palette backend. Searches across the calling user's
// events (visible across owned + shared calendars). Returns a
// flat list capped at 30 — the palette itself never needs more than
// what's visible above the fold.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray, isNull, ilike, or } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";

export async function searchRoutes(app: FastifyInstance) {
  app.get("/api/search", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await requireUser(req, reply);
    const q = z.object({
      q: z.string().min(1).max(100),
    }).safeParse(req.query);
    if (!q.success) return reply.send({ events: [] });
    // Wildcard wrap for ILIKE; escape % and _ so users can't accidentally
    // match every event by typing "a%". (Postgres ILIKE doesn't interpret
    // user input unless we splice it into the LIKE pattern — which we do
    // via the parameterized .replace, not string concat.)
    const needle = `%${q.data.q.replace(/[%_]/g, (c) => "\\" + c)}%`;

    // What calendars can this user see?
    const owned = await db
      .select({ id: schema.calendars.id, name: schema.calendars.name, color: schema.calendars.color })
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id));
    const shared = await db
      .select({ id: schema.calendars.id, name: schema.calendars.name, color: schema.calendars.color })
      .from(schema.calendars)
      .innerJoin(schema.calendarMembers, eq(schema.calendarMembers.calendarId, schema.calendars.id))
      .where(eq(schema.calendarMembers.userId, user.id));
    const allowedIds = Array.from(new Set([...owned.map((c) => c.id), ...shared.map((c) => c.id)]));
    if (allowedIds.length === 0) return reply.send({ events: [] });

    const calLookup = new Map<string, { name: string; color: string }>();
    for (const c of [...owned, ...shared]) calLookup.set(c.id, { name: c.name, color: c.color });

    // Match in summary, description, or location.
    const rows = await db
      .select({
        id: schema.events.id,
        calendarId: schema.events.calendarId,
        summary: schema.events.summary,
        description: schema.events.description,
        location: schema.events.location,
        startsAt: schema.events.startsAt,
        endsAt: schema.events.endsAt,
      })
      .from(schema.events)
      .where(and(
        inArray(schema.events.calendarId, allowedIds),
        isNull(schema.events.deletedAt),
        or(
          ilike(schema.events.summary, needle),
          ilike(schema.events.description, needle),
          ilike(schema.events.location, needle),
        ),
      ))
      .limit(30);

    return reply.send({
      events: rows.map((e) => ({
        id: e.id,
        calendarId: e.calendarId,
        calendarName: calLookup.get(e.calendarId)?.name ?? "",
        calendarColor: calLookup.get(e.calendarId)?.color ?? "#6366f1",
        summary: e.summary,
        location: e.location,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
      })),
    });
  });
}
