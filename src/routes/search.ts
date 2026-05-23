// Cmd+K command palette + /app/search backend. Searches the calling
// user's events (owned + shared calendars). Two callers:
//   - palette.js (Cmd+K): wants the top ~10 most-relevant results fast
//   - /app/search page: wants up to 100 with ordering by recency
// Both use the same endpoint; the `limit` param tunes which.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, ilike, or } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";

export async function searchRoutes(app: FastifyInstance) {
  app.get("/search", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await requireUser(req, reply);
    const q = z.object({
      q: z.string().min(1).max(100),
      // Cap at 100; default 30 keeps the Cmd+K palette fast (it overrides
      // upward only on the dedicated /app/search page).
      limit: z.coerce.number().int().min(1).max(100).default(30),
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
      // Recency-first — "the meeting from three months ago" gets surfaced
      // before "the meeting from three years ago" by default.
      .orderBy(desc(schema.events.startsAt))
      .limit(q.data.limit);

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
