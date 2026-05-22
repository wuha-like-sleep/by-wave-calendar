// API response helpers. Two formats coexist:
//
// - /api/*       (legacy)  → returns the bare payload (or { error: "..." })
//                          Used by the in-app JS client; backwards-compat.
//
// - /api/v1/*    (current) → wraps in a uniform envelope:
//                            success: { ok: true, data: <payload>, meta?: {...} }
//                            error:   { ok: false, error: { code, message, details? } }
//                          New integrations and the OpenAPI spec target this.
//
// Both URL surfaces share the same route handler — the helper checks the
// inbound request URL and picks the right format.

import type { FastifyReply, FastifyRequest } from "fastify";

function isV1(req: FastifyRequest): boolean {
  // Fastify normalizes URL but keeps the leading slash; check both forms.
  const u = req.url || "";
  return u.startsWith("/api/v1/") || u === "/api/v1" || u.startsWith("/api/v1?");
}

// Send a success response. `meta` is optional and only attached in v1.
export function ok<T>(req: FastifyRequest, reply: FastifyReply, data: T, meta?: Record<string, unknown>): FastifyReply {
  if (isV1(req)) {
    return reply.send({ ok: true, data, ...(meta ? { meta } : {}) });
  }
  return reply.send(data);
}

// Send a paginated list. `count` lives in meta; v1 also surfaces it as a header.
export function okList<T>(req: FastifyRequest, reply: FastifyReply, items: T[], meta?: Record<string, unknown>): FastifyReply {
  if (isV1(req)) {
    reply.header("X-Total-Count", String(items.length));
    return reply.send({ ok: true, data: items, meta: { count: items.length, ...(meta ?? {}) } });
  }
  return reply.send(items);
}

// Send an error. `code` is the machine-readable identifier (snake_case);
// `message` is human-readable (often Chinese for end-user UIs).
export function err(
  req: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message?: string,
  details?: Record<string, unknown>,
): FastifyReply {
  if (isV1(req)) {
    return reply.code(statusCode).send({
      ok: false,
      error: {
        code,
        message: message || code,
        ...(details ? { details } : {}),
      },
    });
  }
  // Legacy /api/* shape: just { error: <code>, message?: <text> }.
  // We include message for callers that already read it; older callers
  // ignoring it stay compatible.
  return reply.code(statusCode).send({ error: code, ...(message ? { message } : {}) });
}
