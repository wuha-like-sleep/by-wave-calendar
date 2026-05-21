import type { FastifyRequest } from "fastify";
import { db, schema } from "../db/client.js";

export async function audit(
  req: FastifyRequest,
  actorUserId: string,
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
