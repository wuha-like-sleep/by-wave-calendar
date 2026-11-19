import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUserOrSend } from "../lib/session.js";
import { newShareToken } from "../lib/ids.js";
import { env } from "../env.js";
import { ok, okList, err } from "../lib/api_response.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "../lib/event_zone.js";
import { remapSeriesForZoneChange } from "../lib/exdate_remap.js";
import { normalizeCalendarTimeZone } from "../lib/timezones.js";
import { resolveLocaleFromRequest, translatePlain } from "../lib/i18n.js";
import { getSettings } from "../lib/site_settings.js";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().max(100).optional(),
});

const updateSchema = createSchema.partial();

const idParam = z.object({ id: z.string().uuid() });

/**
 * 把 ZodError 压成一句话，带上出错的字段路径。只取前三条 —— 与
 * events.ts 的同名 helper 同口径。
 *
 * 本文件以前各处都用 schema.parse()：ZodError 身上没有 statusCode，
 * 一路冒到 server.ts 的 setErrorHandler 就变成 500「服务器内部错误」，
 * 客户端看不出是自己发错了（events.ts 的 POST 早先修过同一课）。
 * 所以这里一律 safeParse，校验失败回 400 invalid_body。
 */
function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * timezone 字段在场时的写入关口（POST / PATCH 共用）：合法则把 body 里
 * 的值换成归一化后的规范名并返回 true；非法（乱填、空串）回 400
 * invalid_timezone 并返回 false。字段不在场（undefined）不拦 —— 建日历
 * 走数据库默认、改日历表示不动这一项。
 *
 * 错误文案自己按请求语言解析，不用 tForRequest：那个读 server.ts 全局
 * 钩子写的 req.locale，能不能读到取决于钩子与路由的注册先后，读不到会
 * 安静回落中文（devices.ts 的 appleT 踩过同一课）。这里有现成的 user，
 * 口径与全站一致：?lang= → cookie → user.locale → 站点默认 → 请求头。
 * message 用 translatePlain：它落在 JSON 里给客户端直接显示，不能带
 * EJS 转义。
 */
async function applyCalendarTimeZone(
  req: FastifyRequest,
  reply: FastifyReply,
  user: { locale?: string | null },
  body: { timezone?: string },
): Promise<boolean> {
  if (body.timezone === undefined) return true;
  const tz = normalizeCalendarTimeZone(body.timezone);
  if (tz !== null) {
    body.timezone = tz;
    return true;
  }
  const settings = await getSettings().catch(() => null);
  const locale = resolveLocaleFromRequest(req, user.locale ?? null, settings?.defaultLocale);
  const message = translatePlain(locale, "api.error.invalidTimezone", { tz: body.timezone });
  err(req, reply, 400, "invalid_timezone", message);
  return false;
}

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
    ))
    // 锁住这批行：循环要逐条算，期间手机 PUT、「删掉这一次」改了同一条的话，
    // 会被这里读进来的旧 exdates / 旧规则盖掉。锁着就排在后面、改的是改过之后的那份。
    .for("update");
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
    const parsedBody = createSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return err(req, reply, 400, "invalid_body", zodMessage(parsedBody.error));
    }
    const body = parsedBody.data;
    if (!(await applyCalendarTimeZone(req, reply, user, body))) return reply;
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
    const parsedParams = idParam.safeParse(req.params);
    if (!parsedParams.success) {
      return err(req, reply, 400, "invalid_id", zodMessage(parsedParams.error));
    }
    const { id } = parsedParams.data;
    const parsedBody = updateSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return err(req, reply, 400, "invalid_body", zodMessage(parsedBody.error));
    }
    const body = parsedBody.data;
    if (!(await applyCalendarTimeZone(req, reply, user, body))) return reply;
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
    const parsedParams = idParam.safeParse(req.params);
    if (!parsedParams.success) {
      return err(req, reply, 400, "invalid_id", zodMessage(parsedParams.error));
    }
    const { id } = parsedParams.data;
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
    const parsedParams = idParam.safeParse(req.params);
    if (!parsedParams.success) {
      return err(req, reply, 400, "invalid_id", zodMessage(parsedParams.error));
    }
    const { id } = parsedParams.data;
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
    const parsedParams = idParam.safeParse(req.params);
    if (!parsedParams.success) {
      return err(req, reply, 400, "invalid_id", zodMessage(parsedParams.error));
    }
    const { id } = parsedParams.data;
    const parsedBody = z.object({ label: z.string().max(100).optional() }).safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return err(req, reply, 400, "invalid_body", zodMessage(parsedBody.error));
    }
    const body = parsedBody.data;
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
    const parsedParams = z.object({ id: z.string().uuid(), token: z.string() }).safeParse(req.params);
    if (!parsedParams.success) {
      return err(req, reply, 400, "invalid_id", zodMessage(parsedParams.error));
    }
    const { id, token } = parsedParams.data;
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
