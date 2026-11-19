import type { FastifyRequest } from "fastify";
import { db, schema } from "../db/client.js";

export async function audit(
  req: FastifyRequest,
  // null = 没有可归属的账号（未认证请求、系统事件）。这一列本来就是
  // SET NULL 语义，聚合视图靠 details 里的邮箱/前缀兜底归属。
  actorUserId: string | null,
  action: string,
  opts: { targetType?: string; targetId?: string; details?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await db.insert(schema.adminAuditLog).values({
      actorUserId,
      action,
      targetType: opts.targetType ?? null,
      targetId: opts.targetId ?? null,
      details: opts.details ?? null,
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 500),
    });
  } catch (err) {
    req.log.warn({ err, action }, "audit_log_failed");
  }
}
