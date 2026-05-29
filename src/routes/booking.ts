import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";
import { env } from "../env.js";
import { ok, okList, err } from "../lib/api_response.js";
import { DEFAULT_AVAILABILITY, type WeeklyAvailability } from "../lib/booking.js";

// JSON API for booking-link management — the owner-facing side of the
// 预约链接 feature. Until now booking was 100% server-rendered HTML forms
// under /app/booking-links*; native clients (iOS / Android / desktop) had
// no way in. This plugin exposes the same capabilities the web owner UI
// has today (create / list / toggle / delete + the bookings made on a
// link) as a proper Bearer-authed JSON API under /api/v1.
//
// The PUBLIC visitor booking page (/book/:userId/:slug) stays web-only —
// it's a shareable public URL that works in any browser, so there's no
// value duplicating its date/slot picker natively.
//
// Routes are written relative to the API prefix; server.ts double-mounts
// this at /api (legacy bare payloads) and /api/v1 (envelope via onSend).

// HH:MM 24h, e.g. "09:00" / "18:30".
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式应为 HH:MM");
// WeeklyAvailability = Record<dayOfWeek, [start,end][] | null>. Keys are
// "0".."6" (0=Sunday). null/absent means "not available that day".
const weeklyAvailabilitySchema = z.record(
  z.union([z.array(z.tuple([hhmm, hhmm])), z.null()]),
);

const createSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "URL 标识只能 a-z 0-9 和 -"),
  title: z.string().min(1).max(120),
  description: z.string().max(2000).optional().transform((v) => v?.trim() || undefined),
  calendarId: z.string().uuid(),
  durationMinutes: z.coerce.number().int().min(5).max(480),
  minNoticeHours: z.coerce.number().int().min(0).max(720),
  maxDaysAhead: z.coerce.number().int().min(1).max(90),
  bufferBeforeMin: z.coerce.number().int().min(0).max(240).default(0),
  bufferAfterMin: z.coerce.number().int().min(0).max(240).default(0),
  notifyEmail: z.boolean().default(true),
  weeklyAvailability: weeklyAvailabilitySchema.optional(),
});

// PATCH: every field optional; slug + calendarId included so native UIs
// can rename/re-target a link. weeklyAvailability lets a native editor
// configure per-day windows (the web UI doesn't expose this yet).
const updateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
  title: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  calendarId: z.string().uuid(),
  durationMinutes: z.coerce.number().int().min(5).max(480),
  minNoticeHours: z.coerce.number().int().min(0).max(720),
  maxDaysAhead: z.coerce.number().int().min(1).max(90),
  bufferBeforeMin: z.coerce.number().int().min(0).max(240),
  bufferAfterMin: z.coerce.number().int().min(0).max(240),
  enabled: z.boolean(),
  notifyEmail: z.boolean(),
  weeklyAvailability: weeklyAvailabilitySchema,
}).partial();

const idParam = z.object({ id: z.string().uuid() });

function publicUrlFor(userId: string, slug: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/book/${userId}/${slug}`;
}

function withPublicUrl(userId: string, link: schema.BookingLink) {
  return { ...link, publicUrl: publicUrlFor(userId, link.slug) };
}

export async function bookingRoutes(app: FastifyInstance) {
  // List the authenticated user's booking links.
  app.get("/booking-links", async (req, reply) => {
    const user = await requireUser(req, reply);
    const rows = await db
      .select()
      .from(schema.bookingLinks)
      .where(eq(schema.bookingLinks.userId, user.id))
      .orderBy(asc(schema.bookingLinks.title));
    return okList(req, reply, rows.map((l) => withPublicUrl(user.id, l)));
  });

  // Create a booking link. Mirrors POST /app/booking-links but takes JSON
  // (so notifyEmail is a real boolean, not the HTML "on"/absent dance).
  app.post("/booking-links", async (req, reply) => {
    const user = await requireUser(req, reply);
    const body = createSchema.parse(req.body);
    if (!(await ownsCalendar(body.calendarId, user.id))) {
      return err(req, reply, 404, "calendar_not_found", "目标日历不存在或不属于你");
    }
    try {
      const [row] = await db
        .insert(schema.bookingLinks)
        .values({
          userId: user.id,
          slug: body.slug,
          calendarId: body.calendarId,
          title: body.title,
          description: body.description ?? null,
          durationMinutes: body.durationMinutes,
          weeklyAvailability: (body.weeklyAvailability as WeeklyAvailability) ?? DEFAULT_AVAILABILITY,
          minNoticeHours: body.minNoticeHours,
          maxDaysAhead: body.maxDaysAhead,
          bufferBeforeMin: body.bufferBeforeMin,
          bufferAfterMin: body.bufferAfterMin,
          notifyEmail: body.notifyEmail,
        })
        .returning();
      if (!row) return err(req, reply, 500, "insert_failed", "创建预约链接失败");
      reply.code(201);
      return ok(req, reply, withPublicUrl(user.id, row));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return err(req, reply, 409, "slug_taken", "slug 已存在");
      }
      throw e;
    }
  });

  // Partial update — covers rename, re-target calendar, duration/notice/
  // buffer tweaks, enable/disable, notify toggle, and per-day availability.
  app.patch("/booking-links/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      return err(req, reply, 400, "empty_update", "没有要更新的字段");
    }
    if (body.calendarId && !(await ownsCalendar(body.calendarId, user.id))) {
      return err(req, reply, 404, "calendar_not_found", "目标日历不存在或不属于你");
    }
    try {
      const [row] = await db
        .update(schema.bookingLinks)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(schema.bookingLinks.id, id), eq(schema.bookingLinks.userId, user.id)))
        .returning();
      if (!row) return err(req, reply, 404, "not_found", "预约链接不存在");
      return ok(req, reply, withPublicUrl(user.id, row));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return err(req, reply, 409, "slug_taken", "slug 已存在");
      }
      throw e;
    }
  });

  app.delete("/booking-links/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const result = await db
      .delete(schema.bookingLinks)
      .where(and(eq(schema.bookingLinks.id, id), eq(schema.bookingLinks.userId, user.id)))
      .returning({ id: schema.bookingLinks.id });
    if (result.length === 0) return err(req, reply, 404, "not_found", "预约链接不存在");
    return ok(req, reply, { ok: true });
  });

  // Bookings that visitors have made on a given link. Defaults to active
  // (not-cancelled) upcoming bookings; pass ?all=1 to include past +
  // cancelled. Lets the native owner UI show "who booked me".
  app.get("/booking-links/:id/bookings", async (req, reply) => {
    const user = await requireUser(req, reply);
    const { id } = idParam.parse(req.params);
    const q = z.object({ all: z.coerce.boolean().default(false) }).parse(req.query ?? {});
    // Ownership check — the link must belong to the caller.
    const [link] = await db
      .select({ id: schema.bookingLinks.id })
      .from(schema.bookingLinks)
      .where(and(eq(schema.bookingLinks.id, id), eq(schema.bookingLinks.userId, user.id)))
      .limit(1);
    if (!link) return err(req, reply, 404, "not_found", "预约链接不存在");
    const conds = [eq(schema.bookings.linkId, id)];
    if (!q.all) {
      conds.push(isNull(schema.bookings.cancelledAt));
      conds.push(gte(schema.bookings.startsAt, new Date()));
    }
    const rows = await db
      .select()
      .from(schema.bookings)
      .where(and(...conds))
      .orderBy(q.all ? desc(schema.bookings.startsAt) : asc(schema.bookings.startsAt));
    return okList(req, reply, rows);
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
