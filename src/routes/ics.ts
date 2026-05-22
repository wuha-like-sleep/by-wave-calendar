import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { buildIcsFeed } from "../services/ics.js";
import { env } from "../env.js";
import { getSettings } from "../lib/site_settings.js";

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

  // ---------- Embeddable widget (iframe-friendly read-only calendar) ----------
  // Uses the same share-token surface as the ICS feed: anyone with the URL
  // sees the contents. Renders a stripped-down Toast UI Calendar in an
  // iframe-safe HTML page (no nav, no toolbar chrome from layout.ejs).
  app.get<{ Params: { token: string } }>("/embed/:token", async (req, reply) => {
    // Site-wide kill switch from /admin/security. When off, /embed/* is
    // indistinguishable from "token doesn't exist" — 404 with no extra
    // info so we don't accidentally leak that the feature ever existed.
    const settings = await getSettings();
    if (!settings.embedEnabled) return reply.code(404).type("text/plain").send("Not Found");

    const token = req.params.token.replace(/\.html$/i, "");
    if (!token || token.length < 8) return reply.code(404).type("text/plain").send("Not Found");

    const [tokRow] = await db
      .select()
      .from(schema.shareTokens)
      .where(and(eq(schema.shareTokens.token, token), isNull(schema.shareTokens.revokedAt)))
      .limit(1);
    if (!tokRow) return reply.code(404).type("text/plain").send("Not Found");

    const [calendar] = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.id, tokRow.calendarId))
      .limit(1);
    if (!calendar) return reply.code(404).type("text/plain").send("Not Found");

    // Disabled-account gate: hide the widget if the owner is disabled
    // (mirrors what we already do for the ICS feed). Indistinguishable
    // 404 so we don't leak account status.
    const [owner] = await db
      .select({ disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, calendar.ownerId))
      .limit(1);
    if (!owner || owner.disabledAt) return reply.code(404).type("text/plain").send("Not Found");

    const rows = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, calendar.id), isNull(schema.events.deletedAt)))
      .orderBy(asc(schema.events.startsAt));

    // Iframe-friendliness: drop the global X-Frame-Options / CSP
    // frame-ancestors so the host page can actually embed us. We do
    // this ONLY on /embed/* — the rest of the app stays SAMEORIGIN /
    // frame-ancestors 'none'.
    reply
      .header("X-Frame-Options", "ALLOWALL")
      .header("Content-Security-Policy",
        "default-src 'self'; " +
        "script-src 'self' 'nonce-" + ((req.raw as unknown as { cspNonce?: string }).cspNonce ?? "") + "'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "font-src 'self' data:; " +
        "frame-ancestors *");
    return reply.view("embed", {
      calendar,
      events: rows.map((e) => ({
        id: e.id,
        summary: e.summary,
        description: e.description,
        location: e.location,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        allDay: e.allDay,
      })),
      publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
      // Layout is bypassed (we use our own minimal <html>), so the
      // standard view-locals injector still adds csrfToken/etc but
      // nothing in embed.ejs reads them.
    });
  });
}
