import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUserOrSend } from "../lib/session.js";
import { err } from "../lib/api_response.js";
import { buildIcsFeed } from "../services/ics.js";

// 单个日历的 ICS 导出（API 入口，客户端专用）。
//
// 和两个既有出口的区别：
//   · /ics/<token> 是公开订阅源：谁有链接谁能拉，而且要先建一个长期有效
//     的 share-token —— 为了在 App 里「导出一次」而铸造一个持久公开链接
//     是安全倒退，所以这里绝不复用它。
//   · /app/calendars/:id/export.ics 是网页端的一次性下载，走 cookie 会话。
// 这里补的是同一件事的 bearer 版：属主鉴权、归属校验、一次性快照、
// attachment 下载，口径与网页导出逐项一致（软删事件不进导出、按开始
// 时间排序、文件名清洗规则同网页）。响应是 text/calendar，不走 JSON
// 信封（server.ts 的 onSend 只包装 JSON 响应）。

const idParam = z.object({ id: z.string().uuid() });

export async function exportRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/calendars/:id/export.ics",
    { config: { oauthScope: "read:events" } },
    async (req, reply) => {
      const user = await requireUserOrSend(req, reply);
      if (!user) return reply;
      const params = idParam.safeParse(req.params);
      if (!params.success) return err(req, reply, 404, "calendar_not_found", "日历不存在");
      const [cal] = await db
        .select()
        .from(schema.calendars)
        .where(and(eq(schema.calendars.id, params.data.id), eq(schema.calendars.ownerId, user.id)))
        .limit(1);
      if (!cal) return err(req, reply, 404, "calendar_not_found", "日历不存在");
      const events = await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.calendarId, cal.id), isNull(schema.events.deletedAt)))
        .orderBy(asc(schema.events.startsAt));
      // 属主本人导出 = 备份口径：参与者/提醒/分类等全带（见 services/ics.ts）。
      const body = buildIcsFeed(cal, events, { full: true });
      // 文件名清洗与网页导出同规则：非字母数字/中文/连字符一律换下划线。
      // 但清洗后的名字仍可能含中文，直接塞进 filename= 会让 Node 以
      // ERR_INVALID_CHAR 拒绝整个响应头（导出 500）——所以 filename= 只放
      // ASCII 回退名，完整名字走 RFC 5987 的 filename*。
      const cleaned = cal.name.replace(/[^a-zA-Z0-9一-鿿-]+/g, "_").slice(0, 50) || "calendar";
      const asciiName = cleaned.replace(/[^\x20-\x7e]/g, "_");
      const encoded = encodeURIComponent(`${cleaned}.ics`).replace(/'/g, "%27");
      reply
        .header("Content-Type", "text/calendar; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", `attachment; filename="${asciiName}.ics"; filename*=UTF-8''${encoded}`);
      return reply.send(body);
    },
  );
}
