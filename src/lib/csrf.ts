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

/**
 * 上传表单（multipart）的 CSRF 校验。
 *
 * ── 为什么上传表单不能省 ──────────────────────────────────────────────
 *
 * multipart 请求的 req.body 是空的（解析器不往 body 里塞字段），所以上面那个
 * verifyCsrf 读不到 _csrf —— 以前几条上传路由就干脆不校验了，注释写着
 * 「靠 cookie 的 SameSite=Lax 兜底」。
 *
 * 这个兜底在这里不成立：本站和同一个上级域名下的几十个站点在浏览器眼里算
 * 「同站」，SameSite=Lax 的 cookie 会跟着带过来。其中任何一个站被攻破，
 * 就能在管理员浏览它的时候，用 fetch 替他往「导入备份」POST 一份伪造的备份 ——
 * 整个库被换掉，比如多出一个攻击者的管理员账号。
 *
 * 字段其实读得到：表单里 _csrf 排在文件框**前面**时，它出现在上传那一段的
 * fields 里（@fastify/multipart 会把文件之前的字段都解析好）。所以模板里
 * _csrf 必须放在 type="file" 之前 —— 有一条断言盯着。
 */
export function verifyMultipartCsrf(
  req: FastifyRequest,
  reply: FastifyReply,
  fields: Record<string, unknown> | undefined,
): boolean {
  const expected = csrfTokenFor(req);
  const headerToken = req.headers[TOKEN_HEADER];
  const field = fields?.[TOKEN_FIELD] as { value?: unknown } | { value?: unknown }[] | undefined;
  const fieldValue = Array.isArray(field) ? field[0]?.value : field?.value;
  const provided = (typeof headerToken === "string" ? headerToken : null)
    ?? (typeof fieldValue === "string" ? fieldValue : null);
  if (!provided || provided.length !== expected.length
      || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    reply.code(403).send({ error: "csrf_invalid" });
    return false;
  }
  return true;
}

export const CSRF_FIELD_NAME = TOKEN_FIELD;
export const CSRF_HEADER_NAME = TOKEN_HEADER;
