// 站内通知的 API 面。目前只有一个端点：铃铛的未读数。
//
// 为什么单独给一个计数端点，而不是让前端去拉通知列表数长度：
// 铃铛挂在每个登录页的导航栏上，每 60 秒轮询一次。列表接口要序列化
// 标题正文，计数接口只要一个 count + max(created_at)。ETag 由这两者
// 拼成（见 lib/notifications.ts unreadNotificationsEtag），没新通知时
// 304 空响应，和 /events 窗口的 ETag 口径保持一致。

import type { FastifyInstance } from "fastify";
import { requireUserOrSend } from "../lib/session.js";
import { countUnreadNotifications, unreadNotificationsEtag } from "../lib/notifications.js";
import { etagMatches } from "../lib/calendar_ctag.js";

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/notifications/unread-count", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const tag = await unreadNotificationsEtag(user.id);
    // private, no-cache：可以存，但用前必须回服务器核对（核对便宜）。
    reply.header("ETag", tag).header("Cache-Control", "private, no-cache");
    if (etagMatches(req.headers["if-none-match"], tag)) return reply.code(304).send();
    const count = await countUnreadNotifications(user.id);
    return reply.send({ count });
  });
}
