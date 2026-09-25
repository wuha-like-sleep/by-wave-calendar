// 登录之后回到「原本要去的那一页」。
//
// ── 为什么单独成一个模块 ────────────────────────────────────────────────
//
// 这段判据原来有**四份手抄**：web/index.ts（密码 + 邮箱验证码）、web/mfa.ts、
// web/webauthn.ts、web/sso.ts。三处的注释都写着「duplicated here to avoid a
// circular import … keep both in sync」——然后就没同步上：
//
//   index.ts / mfa.ts  允许 /app /admin /web-pair /desktop-pair /oauth
//   webauthn.ts / sso.ts 允许 /app /admin /web-pair /desktop-pair    ← 少了 /oauth
//
// 后果很具体：第三方应用发起授权 → 未登录被送去 /login（此时 /oauth/... 已经
// 存进了 cookie）→ 用 Passkey 或 SSO 登录 → 那两份抄件把 /oauth/... 判成不合法，
// 于是落到日历首页，授权流程断在半路，第三方那边一直等。用密码登录则一切正常。
// 「有时候登录完不去我要去的那一页」就是这么来的。
//
// 循环引用其实并不存在：这个模块只依赖 fastify 的类型和 env，谁都能引。
//
// ── 白名单为什么只有这几个前缀 ──────────────────────────────────────────
//
// 这里放行的是**本站自己的路径**，用来决定登录后往哪跳。它不是 OAuth 的
// redirect_uri —— 那个是 query 参数，由客户端注册的白名单严格全等校验，不走这里。
// 只收 "/" 开头、且挡掉 "//" 和 "/\" 开头（那两种会被浏览器当成跨站地址）。

import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";

export const RETURN_TO_COOKIE = "bwc_return_to";
export const RETURN_TO_TTL_S = 15 * 60;

/** 登录后允许跳回去的路径前缀。**改这里就是四条登录路一起改** ——
 *  这正是当初抄成四份要付的代价。 */
const ALLOWED_PREFIXES = /^\/(app|admin|web-pair|desktop-pair|oauth)(\/|$|\?|#)/;

export function sanitizeReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > 200) return null;
  if (!raw.startsWith("/")) return null;
  // "//host" 和 "/\host" 浏览器会当成跨站地址 —— 那就成了开放重定向。
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (!ALLOWED_PREFIXES.test(raw)) return null;
  // 片段（#...）服务端跳转本来也带不过去，去掉，免得混进判据。
  return raw.split("#")[0] ?? null;
}

/** 把「他本来要去哪」写进签名 cookie。在把人送去 /login 之前调。 */
export function rememberReturnTo(reply: FastifyReply, path: string | null): void {
  if (!path) return;
  reply.setCookie(RETURN_TO_COOKIE, path, {
    httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production",
    path: "/", maxAge: RETURN_TO_TTL_S, signed: true,
  });
}

/** 读 + 清。**任何一条登录路走通之后都要调这个** —— 少调一处，
 *  那条路上的用户就会落到 /app，而他本来要去别处。 */
export function consumeReturnTo(req: FastifyRequest, reply: FastifyReply): string | null {
  const raw = req.cookies[RETURN_TO_COOKIE];
  reply.clearCookie(RETURN_TO_COOKIE, { path: "/" });
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return sanitizeReturnTo(unsigned.value);
}

/** 读 + 清，没有就回 /app。登录成功那一行直接 `reply.redirect(returnToOrApp(...))`。 */
export function returnToOrApp(req: FastifyRequest, reply: FastifyReply): string {
  return consumeReturnTo(req, reply) ?? "/app";
}
