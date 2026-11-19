import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUserOrSend } from "../lib/session.js";
import { ok, okList, err } from "../lib/api_response.js";
import { refreshSubscription } from "../lib/ics_import.js";

// ICS 订阅的 API 入口（客户端专用；网页端的订阅管理在 web/index.ts 的
// /app/calendars/:id/subscriptions*，走 cookie + CSRF）。
//
// 以前订阅只有网页端能管：用户在手机上看到一个公开日历的订阅地址，
// 没法直接在 App 里订阅进来。这里把同一套核心（calendar_subscriptions
// 表 + ics_import.ts 的 refreshSubscription，内含 fetchIcsUrl 的 SSRF
// 防护与导入去重）接到 /api/v1 下，口径和网页端逐项对齐：
//
//   · 创建即首刷：订阅先落库，再立刻拉一次。和网页端一样，第一次拉取
//     失败不算创建失败 —— 订阅已经存下了、之后按周期重试，响应里用
//     refresh.ok=false + refresh.error 把原因带回去，客户端不要因为
//     首刷失败就让用户再建一条一模一样的订阅。
//   · 刷新/删除都同时校验「日历是本人的」和「订阅属于这个日历」。
//     网页端刷新曾经只校验前者，拿自己的日历 id 配别人的订阅 id 就能
//     触发对方订阅的导入；API 这边从第一天就两个条件一起查（归属对不
//     上统一 404，不泄露订阅是否存在）。
//   · 限流和网页端同档：创建 10/分钟、手动刷新 20/分钟 —— 两条路都会
//     立刻对外发一次抓取请求，是防放大/防滥用的闸门，不能比网页松。
//   · 权限：列表是读（read:events），建/刷/删是写（write:events）；
//     只读 API Token 在写路由上会被 session 层以 token_is_read_only 拒。

const idParam = z.object({ id: z.string().uuid() });
const subParams = z.object({ id: z.string().uuid(), subId: z.string().uuid() });

const createBody = z.object({
  url: z.string().min(1).max(2000),
  label: z.string().max(60).optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  refreshMinutes: z.number().int().min(15).max(10080).optional(),
});

async function ownsCalendar(calendarId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.calendars.id })
    .from(schema.calendars)
    .where(and(eq(schema.calendars.id, calendarId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return rows.length > 0;
}

type SubRow = typeof schema.calendarSubscriptions.$inferSelect;

function presentSub(s: SubRow) {
  return {
    id: s.id,
    calendarId: s.calendarId,
    url: s.url,
    label: s.label,
    refreshMinutes: s.refreshMinutes,
    lastFetchedAt: s.lastFetchedAt ? s.lastFetchedAt.toISOString() : null,
    lastStatus: s.lastStatus,
    lastError: s.lastError,
    lastEventCount: s.lastEventCount,
    createdAt: s.createdAt.toISOString(),
  };
}

async function findOwnedSub(calendarId: string, subId: string): Promise<SubRow | null> {
  const [row] = await db
    .select()
    .from(schema.calendarSubscriptions)
    .where(and(
      eq(schema.calendarSubscriptions.id, subId),
      eq(schema.calendarSubscriptions.calendarId, calendarId),
    ))
    .limit(1);
  return row ?? null;
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/calendars/:id/subscriptions",
    { config: { oauthScope: "read:events" } },
    async (req, reply) => {
      const user = await requireUserOrSend(req, reply);
      if (!user) return reply;
      const params = idParam.safeParse(req.params);
      if (!params.success) return err(req, reply, 404, "calendar_not_found", "日历不存在");
      if (!(await ownsCalendar(params.data.id, user.id))) {
        return err(req, reply, 404, "calendar_not_found", "日历不存在");
      }
      const rows = await db
        .select()
        .from(schema.calendarSubscriptions)
        .where(eq(schema.calendarSubscriptions.calendarId, params.data.id))
        .orderBy(desc(schema.calendarSubscriptions.createdAt));
      return okList(req, reply, rows.map(presentSub));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/calendars/:id/subscriptions",
    {
      config: {
        oauthScope: "write:events",
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const user = await requireUserOrSend(req, reply);
      if (!user) return reply;
      const params = idParam.safeParse(req.params);
      if (!params.success) return err(req, reply, 404, "calendar_not_found", "日历不存在");
      const body = createBody.safeParse(req.body);
      if (!body.success) return err(req, reply, 400, "invalid_body", "订阅地址不合法");
      if (!(await ownsCalendar(params.data.id, user.id))) {
        return err(req, reply, 404, "calendar_not_found", "日历不存在");
      }
      const [sub] = await db
        .insert(schema.calendarSubscriptions)
        .values({
          calendarId: params.data.id,
          url: body.data.url.trim(),
          label: body.data.label ?? null,
          refreshMinutes: body.data.refreshMinutes ?? 360,
        })
        .returning();
      if (!sub) return err(req, reply, 500, "insert_failed", "订阅保存失败");

      // 首刷：失败不回滚订阅（见文件头），把结果随响应带回。
      const refresh = await refreshSubscription(sub.id);
      const [fresh] = await db
        .select()
        .from(schema.calendarSubscriptions)
        .where(eq(schema.calendarSubscriptions.id, sub.id))
        .limit(1);
      reply.code(201);
      return ok(req, reply, {
        subscription: presentSub(fresh ?? sub),
        refresh: refresh.ok
          ? {
              ok: true as const,
              inserted: refresh.result.inserted,
              updated: refresh.result.updated,
              skipped: refresh.result.skipped,
              total: refresh.result.total,
            }
          : { ok: false as const, error: refresh.error },
      });
    },
  );

  app.post<{ Params: { id: string; subId: string } }>(
    "/calendars/:id/subscriptions/:subId/refresh",
    {
      config: {
        oauthScope: "write:events",
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const user = await requireUserOrSend(req, reply);
      if (!user) return reply;
      const params = subParams.safeParse(req.params);
      if (!params.success) return err(req, reply, 404, "subscription_not_found", "订阅不存在");
      if (!(await ownsCalendar(params.data.id, user.id))) {
        return err(req, reply, 404, "calendar_not_found", "日历不存在");
      }
      const owned = await findOwnedSub(params.data.id, params.data.subId);
      if (!owned) return err(req, reply, 404, "subscription_not_found", "订阅不存在");
      const refresh = await refreshSubscription(params.data.subId);
      if (!refresh.ok) {
        return err(req, reply, 502, "refresh_failed", refresh.error);
      }
      const [fresh] = await db
        .select()
        .from(schema.calendarSubscriptions)
        .where(eq(schema.calendarSubscriptions.id, params.data.subId))
        .limit(1);
      return ok(req, reply, {
        subscription: presentSub(fresh ?? owned),
        inserted: refresh.result.inserted,
        updated: refresh.result.updated,
        skipped: refresh.result.skipped,
        total: refresh.result.total,
      });
    },
  );

  app.delete<{ Params: { id: string; subId: string } }>(
    "/calendars/:id/subscriptions/:subId",
    { config: { oauthScope: "write:events" } },
    async (req, reply) => {
      const user = await requireUserOrSend(req, reply);
      if (!user) return reply;
      const params = subParams.safeParse(req.params);
      if (!params.success) return err(req, reply, 404, "subscription_not_found", "订阅不存在");
      if (!(await ownsCalendar(params.data.id, user.id))) {
        return err(req, reply, 404, "calendar_not_found", "日历不存在");
      }
      const deleted = await db
        .delete(schema.calendarSubscriptions)
        .where(and(
          eq(schema.calendarSubscriptions.id, params.data.subId),
          eq(schema.calendarSubscriptions.calendarId, params.data.id),
        ))
        .returning({ id: schema.calendarSubscriptions.id });
      if (deleted.length === 0) {
        return err(req, reply, 404, "subscription_not_found", "订阅不存在");
      }
      return ok(req, reply, { ok: true });
    },
  );
}
