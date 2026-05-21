import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";

const COOKIE_NAME = "bwc_sid";
const TOKEN_HEADER = "x-csrf-token";
const TOKEN_FIELD = "_csrf";

function sessionTokenFromCookie(req: FastifyRequest): string | null {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

export function csrfTokenFor(req: FastifyRequest): string {
  const sid = sessionTokenFromCookie(req) ?? "anonymous";
  return createHmac("sha256", env.SESSION_SECRET).update(sid).digest("hex");
}

export function verifyCsrf(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = csrfTokenFor(req);
  const headerToken = req.headers[TOKEN_HEADER];
  const body = (req.body ?? {}) as Record<string, unknown>;
  const formToken = typeof body[TOKEN_FIELD] === "string" ? (body[TOKEN_FIELD] as string) : null;
  const provided = (typeof headerToken === "string" ? headerToken : null) ?? formToken;
  if (!provided || provided.length !== expected.length) {
    reply.code(403).send({ error: "csrf_invalid" });
    return false;
  }
  const ok = timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    reply.code(403).send({ error: "csrf_invalid" });
    return false;
  }
  return true;
}

export const CSRF_FIELD_NAME = TOKEN_FIELD;
export const CSRF_HEADER_NAME = TOKEN_HEADER;
