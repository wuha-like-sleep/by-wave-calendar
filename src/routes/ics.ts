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

    const events = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.calendarId, calendar.id))
      .orderBy(asc(schema.events.startsAt));

    const body = buildIcsFeed(calendar, events);
    reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .header("Content-Disposition", `inline; filename="${calendar.id}.ics"`);
    return reply.send(body);
  });
}
