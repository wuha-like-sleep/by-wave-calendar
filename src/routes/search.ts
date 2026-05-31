// Cmd+K command palette + /app/search backend. Searches, ISOLATED to the
// calling user, across three resource types:
//   - events       — on calendars the user owns OR is a member of
//   - calendars    — the same owned + member set, matched by name
//   - bookingLinks — the user's OWN booking links (by title / slug)
//
// Two callers share this endpoint:
//   - palette.js (Cmd+K): top ~30 fast
//   - /app/search page: up to 100
//
// SECURITY / ISOLATION (the whole point of this file):
//   - requireUser() authenticates (session cookie or, like every other read
//     endpoint, a Bearer/OAuth token); there is no anonymous path.
//   - `allowedIds` is the user's owned + member calendars. EVERY event/calendar
//     result is constrained to it. A public share token does NOT create a
//     membership row, so token holders cannot reach this data.
//   - Booking links are scoped to `bookingLinks.userId = user.id` — only the
//     caller's own links, never anyone else's.
//   - Multi-term input is split + length/count-capped and each term's LIKE
//     metacharacters are escaped, so a query can't widen its own match or blow
//     up cost. The ORM parameterizes all values (no SQL injection).
//   - We return summary + location for events but NOT description text, to
//     avoid spilling long private notes into a results list.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, ilike, or } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";
import { parseSearchTerms, likeNeedle, textMatchesAllTerms, eventRelevance } from "../lib/search_query.js";

const MAX_CALENDAR_RESULTS = 8;
const MAX_BOOKING_RESULTS = 8;
const EMPTY = { events: [], calendars: [], bookingLinks: [] } as const;

export async function searchRoutes(app: FastifyInstance) {
  app.get("/search", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await requireUser(req, reply);
    const parsed = z.object({
      q: z.string().min(1).max(100),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).safeParse(req.query);
    if (!parsed.success) return reply.send(EMPTY);

    const terms = parseSearchTerms(parsed.data.q);
    if (terms.length === 0) return reply.send(EMPTY);
    const limit = parsed.data.limit;

    // ---- ISOLATION BOUNDARY: the calendars this user may see ----
    const owned = await db
      .select({ id: schema.calendars.id, name: schema.calendars.name, color: schema.calendars.color })
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id));
    const shared = await db
      .select({ id: schema.calendars.id, name: schema.calendars.name, color: schema.calendars.color })
      .from(schema.calendars)
      .innerJoin(schema.calendarMembers, eq(schema.calendarMembers.calendarId, schema.calendars.id))
      .where(eq(schema.calendarMembers.userId, user.id));

    const calById = new Map<string, { name: string; color: string }>();
    for (const c of [...owned, ...shared]) calById.set(c.id, { name: c.name, color: c.color });
    const allowedIds = Array.from(calById.keys());

    // ---- Events (constrained to allowedIds) ----
    // Each term must appear in summary OR description OR location (AND across
    // terms = "all words present somewhere"). Then re-rank: title relevance
    // first, recency as tie-breaker.
    type EventRow = {
      id: string; calendarId: string; summary: string; location: string | null;
      startsAt: Date; endsAt: Date;
    };
    let eventRows: EventRow[] = [];
    if (allowedIds.length > 0) {
      const termConds = terms.map((t) => {
        const n = likeNeedle(t);
        return or(ilike(schema.events.summary, n), ilike(schema.events.description, n), ilike(schema.events.location, n));
      });
      eventRows = await db
        .select({
          id: schema.events.id,
          calendarId: schema.events.calendarId,
          summary: schema.events.summary,
          location: schema.events.location,
          startsAt: schema.events.startsAt,
          endsAt: schema.events.endsAt,
        })
        .from(schema.events)
        .where(and(inArray(schema.events.calendarId, allowedIds), isNull(schema.events.deletedAt), ...termConds))
        // Fetch a bounded surplus so the in-memory re-rank has material to work
        // with, then slice to `limit`.
        .orderBy(desc(schema.events.startsAt))
        .limit(Math.min(limit * 2, 200));
      eventRows.sort((a, b) => {
        const r = eventRelevance(b.summary, terms) - eventRelevance(a.summary, terms);
        if (r !== 0) return r;
        return b.startsAt.getTime() - a.startsAt.getTime();
      });
      eventRows = eventRows.slice(0, limit);
    }
    const events = eventRows.map((e) => ({
      id: e.id,
      calendarId: e.calendarId,
      calendarName: calById.get(e.calendarId)?.name ?? "",
      calendarColor: calById.get(e.calendarId)?.color ?? "#6366f1",
      summary: e.summary,
      location: e.location,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
    }));

    // ---- Calendars (filter the already-scoped owned+shared list in memory) ----
    const seenCal = new Set<string>();
    const calendars = [...owned, ...shared]
      .filter((c) => (seenCal.has(c.id) ? false : (seenCal.add(c.id), true)))
      .filter((c) => textMatchesAllTerms(c.name, terms))
      .slice(0, MAX_CALENDAR_RESULTS)
      .map((c) => ({ id: c.id, name: c.name, color: c.color, url: `/app?cal=${encodeURIComponent(c.id)}` }));

    // ---- Booking links (scoped to the caller's own) ----
    const blConds = terms.map((t) => {
      const n = likeNeedle(t);
      return or(ilike(schema.bookingLinks.title, n), ilike(schema.bookingLinks.slug, n));
    });
    const blRows = await db
      .select({
        id: schema.bookingLinks.id,
        title: schema.bookingLinks.title,
        slug: schema.bookingLinks.slug,
        enabled: schema.bookingLinks.enabled,
      })
      .from(schema.bookingLinks)
      .where(and(eq(schema.bookingLinks.userId, user.id), ...blConds))
      .limit(MAX_BOOKING_RESULTS);
    const bookingLinks = blRows.map((b) => ({
      id: b.id, title: b.title, slug: b.slug, enabled: b.enabled, url: "/app/booking-links",
    }));

    return reply.send({ events, calendars, bookingLinks });
  });
}
