import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { buildIcsFeed } from "../services/ics.js";

export async function icsRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>("/ics/:token", async (req, reply) => {
    const token = req.params.token.replace(/\.ics$/i, "");
    if (!token || token.length < 8) return reply.code(404).send({ error: "not_found" });

    const tokenRow = await db
      .select()
      .from(schema.shareTokens)
      .where(and(eq(schema.shareTokens.token, token), isNull(schema.shareTokens.revokedAt)))
      .limit(1);
    if (tokenRow.length === 0) return reply.code(404).send({ error: "not_found" });

    const calendarId = tokenRow[0]!.calendarId;
    const [calendar] = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.id, calendarId))
      .limit(1);
    if (!calendar) return reply.code(404).send({ error: "not_found" });

    // Disabled-account gate: ICS share tokens outlive the user's session.
    // If the calendar owner has been disabled, stop publishing their events
    // through the public feed.
    const [owner] = await db
      .select({ disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, calendar.ownerId))
      .limit(1);
    if (!owner || owner.disabledAt) return reply.code(404).send({ error: "not_found" });

    // Soft-deleted events must NOT leak into the public feed — without this
    // filter, anyone with the share URL would still see events that the
    // owner thought they'd deleted.
    const events = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, calendar.id), isNull(schema.events.deletedAt)))
      .orderBy(asc(schema.events.startsAt));

    const body = buildIcsFeed(calendar, events);
    reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .header("Content-Disposition", `inline; filename="${calendar.id}.ics"`);
    return reply.send(body);
  });
}
