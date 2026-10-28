import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUserOrSend } from "../lib/session.js";
import { newShareToken } from "../lib/ids.js";
import { env } from "../env.js";
import { ok, okList, err } from "../lib/api_response.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "../lib/event_zone.js";
import { remapSeriesForZoneChange } from "../lib/exdate_remap.js";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().max(100).optional(),
});

const updateSchema = createSchema.partial();

const idParam = z.object({ id: z.string().uuid() });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 日历换了时区：没有自己时区的定时重复事件（老数据、API 建的）展开跟着换。
 *   · 以前删掉的那几次、「这次及以后」留下的 UNTIL 对到新的日子上（exdate_remap.ts），
 *     不然删过的那次会重新冒出来；
 *   · updated_at 刷新：导出给手机的 TZID 变了，单条 etag 和日历 ctag 都喂它，
 *     不刷新的话手机一直留着旧时区的那份，和服务端排的日子对不上。
 * 有自己时区的、手机写的 UTC 原文、全天的：展开不受日历时区影响，不动。
 */
async function resyncRecurringForZoneChange(tx: Tx, calendarId: string, oldTz: string, newTz: string) {
  const rows = await tx.select({
    id: schema.events.id, startsAt: schema.events.startsAt, rrule: schema.events.rrule,
    exdates: schema.events.exdates, extra: schema.events.extra, rawIcs: schema.events.rawIcs,
  })
    .from(schema.events)
    .where(and(
      eq(schema.events.calendarId, calendarId), isNull(schema.events.deletedAt),
      eq(schema.events.allDay, false), isNotNull(schema.events.rrule), ne(schema.events.rrule, ""),
    ));
  for (const ev of rows) {
    const zoneWith = (calendarTimezone: string) => expansionTimeZone({
      allDay: false, extra: ev.extra, calendarTimezone, rawStartIsUtc: rawIcsStartIsUtc(ev.rawIcs),
    });
    const fromZone = zoneWith(oldTz);
    const toZone = zoneWith(newTz);
    if (fromZone === toZone) continue;
    const plan = remapSeriesForZoneChange({
      startsAt: ev.startsAt, rrule: ev.rrule, allDay: false, exdates: ev.exdates, fromZone, toZone,
    });
    await tx.update(schema.events)
      .set({
        ...(plan.exdates ? { exdates: plan.exdates } : {}),
        ...(plan.rrule ? { rrule: plan.rrule } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.events.id, ev.id));
  }
}

// Routes are written as paths relative to the API prefix. server.ts
// double-registers this plugin at /api (legacy) and /api/v1 (current);
// the ok()/err() helpers branch based on the inbound URL.
export async function calendarRoutes(app: FastifyInstance) {
  app.get("/calendars", { config: { oauthScope: "read:events" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const rows = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id))
      .orderBy(desc(schema.calendars.createdAt));
    return okList(req, reply, rows);
  });

  app.post("/calendars", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const body = createSchema.parse(req.body);
    const [row] = await db
      .insert(schema.calendars)
      .values({ ownerId: user.id, ...body })
      .returning();
    reply.code(201);
    return ok(req, reply, row);
  });

  app.patch("/calendars/:id", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const row = await db.transaction(async (tx) => {
      const [before] = await tx.select({ timezone: schema.calendars.timezone })
        .from(schema.calendars)
        .where(and(eq(schema.calendars.id, id), eq(schema.calendars.ownerId, user.id)))
        .for("update")
        .limit(1);
      if (!before) return null;
      const [updated] = await tx
        .update(schema.calendars)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(schema.calendars.id, id), eq(schema.calendars.ownerId, user.id)))
        .returning();
      if (updated && updated.timezone !== before.timezone) {
        await resyncRecurringForZoneChange(tx, id, before.timezone, updated.timezone);
      }
      return updated ?? null;
    });
    if (!row) return err(req, reply, 404, "not_found", "日历不存在");
    return ok(req, reply, row);
  });

  app.delete("/calendars/:id", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    const result = await db
      .delete(schema.calendars)
      .where(and(eq(schema.calendars.id, id), eq(schema.calendars.ownerId, user.id)))
      .returning({ id: schema.calendars.id });
    if (result.length === 0) return err(req, reply, 404, "not_found", "日历不存在");
    return ok(req, reply, { ok: true });
  });

  app.get("/calendars/:id/share-tokens", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    const owned = await ownsCalendar(id, user.id);
    if (!owned) return err(req, reply, 404, "not_found", "日历不存在");
    const tokens = await db
      .select()
      .from(schema.shareTokens)
      .where(and(eq(schema.shareTokens.calendarId, id), isNull(schema.shareTokens.revokedAt)));
    return okList(req, reply, tokens.map((t) => ({ ...t, url: subscribeUrl(t.token) })));
  });

  app.post("/calendars/:id/share-tokens", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id } = idParam.parse(req.params);
    const body = z.object({ label: z.string().max(100).optional() }).parse(req.body ?? {});
    const owned = await ownsCalendar(id, user.id);
    if (!owned) return err(req, reply, 404, "not_found", "日历不存在");
    const token = newShareToken();
    const [row] = await db
      .insert(schema.shareTokens)
      .values({ token, calendarId: id, label: body.label })
      .returning();
    if (!row) return err(req, reply, 500, "insert_failed", "创建分享链接失败");
    reply.code(201);
    return ok(req, reply, { ...row, url: subscribeUrl(row.token) });
  });

  app.delete("/calendars/:id/share-tokens/:token", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const { id, token } = z.object({ id: z.string().uuid(), token: z.string() }).parse(req.params);
    const owned = await ownsCalendar(id, user.id);
    if (!owned) return err(req, reply, 404, "not_found", "日历不存在");
    const result = await db
      .update(schema.shareTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.shareTokens.token, token), eq(schema.shareTokens.calendarId, id)))
      .returning({ token: schema.shareTokens.token });
    if (result.length === 0) return err(req, reply, 404, "not_found", "分享链接不存在");
    return ok(req, reply, { ok: true });
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

function subscribeUrl(token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/ics/${token}.ics`;
}
