import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword, passwordPolicyError, verifyPassword, verifyPasswordTimingSafe } from "../lib/password.js";
import { createSession, destroySession, requireUserOrSend } from "../lib/session.js";
import { userIsActive } from "../lib/user_state.js";
import { ok, err } from "../lib/api_response.js";
import { env } from "../env.js";
import { isLocked, recordFailedLogin, resetFailedLogin } from "../lib/login_lockout.js";
import { provisionAccount, type ProvisionDenial } from "../lib/account_provisioning.js";

// Tightened schema — same length range as the web flow; the web routes
// additionally enforce passwordPolicyError on the way in. Without this
// the JSON API was the cheat code for creating "12345678" accounts.
// Email is normalized (lowercase + trim) here so register and login
// agree with every other login path. Otherwise a user could register
// "ADMIN@x.com" via the JSON API and create a shadow row that bypassed
// the lowercase-keyed disabled-account check.
const credsSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(100).optional(),
  // 邀请码。站点切到「邀请制」之后,不给这条路一个传码的地方,它就变成了
  // 「邀请制下谁都注册不了」而不是「邀请制」—— 而网页那边是能注册的。
  // 可选:公开注册模式下没人需要填它(P7:不给普通用户加要填的东西)。
  invite: z.string().max(128).optional(),
});

/**
 * 建号被拒 → JSON 这一层的错误形态。**导出是为了能单独钉住这张表**:
 * 它是「哪个拒绝理由回什么状态码」的唯一一份,漏一条会在编译期就报出来
 * (switch 是穷尽的)。
 *
 * 两条硬约束:
 *  - **一条都不能是 401。** 401 在 App 的 api.dart 里的意思是「会话没了」,
 *    收到就把人登出。「这次没让你注册」跟「你是谁我不认」是两回事。
 *  - **不把配额数字回给终端用户。** 那是管理员设的闸门,注册的人既管不着
 *    也不该知道站点今天开了几个号。
 */
export function registerDenialResponse(d: ProvisionDenial): { status: number; code: string; message: string } {
  switch (d.code) {
    case "invalid_email": return { status: 400, code: "invalid_email", message: "邮箱格式不正确" };
    case "registration_closed": return { status: 403, code: "registration_closed", message: "本站当前不开放注册" };
    case "invite_required": return { status: 403, code: "invite_required", message: "本站仅限邀请注册" };
    case "invite_invalid": return { status: 403, code: "invite_invalid", message: "邀请码无效或已失效" };
    case "domain_not_allowed": return { status: 403, code: "domain_not_allowed", message: "该邮箱域名不在允许范围内" };
    case "daily_quota_reached": return { status: 429, code: "signup_quota_reached", message: "今日注册名额已满，请明天再试" };
    // 沿用原来的 code 和 409 —— 这是既有调用方已经在判的串,别顺手改名。
    case "email_taken": return { status: 409, code: "email_already_registered", message: "邮箱已注册" };
    case "create_failed": return { status: 500, code: "insert_failed", message: "创建账号失败" };
  }
}

// Routes are written with paths relative to a prefix; the plugin is
// mounted twice at /api and /api/v1 in server.ts. Response shape
// switches based on which URL the client hit (via the ok()/err()
// helpers): legacy /api returns bare payloads, /api/v1 returns the
// envelope { ok, data | error, meta? }.
export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", {
    // 独立限流。在这之前这条路唯一的刹车是全局 120/分钟 —— 而它是**建号**接口,
    // 网页 /register 早就有 RATE_LIMIT_AUTH_PER_MINUTE 这道闸了。两个面上的
    // 同一件事必须踩同一个刹车,否则「绕开网页那道闸」就只是换个 URL 的事。
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const body = credsSchema.parse(req.body);
    const policyErr = passwordPolicyError(body.password);
    if (policyErr) return err(req, reply, 400, "weak_password", policyErr);
    const passwordHash = await hashPassword(body.password);
    // 建号收口:注册策略 / 邀请码 / 域名白名单 / 每日配额 全在里面判,跟网页
    // 注册走的是同一份。重复邮箱和并发撞唯一索引也由它收(refuse → email_taken),
    // 所以这里不再自己 SELECT 一次、也不再 catch 「duplicate key」的字符串。
    const r = await provisionAccount({
      email: body.email,
      origin: { kind: "self" },
      // 这条路不发验证邮件,邮箱就是没验过,照实写 false。
      // (写 true 的话,库里那句「已验证」是编的,后面没人还能分辨。)
      emailVerified: false,
      displayName: body.displayName ?? null,
      passwordHash,
      inviteToken: body.invite ?? null,
      // 注册类路径:邮箱已经有账号就是「被占用」,不能把那个号交出去。
      onExistingEmail: "refuse",
      ctx: { ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 500) || null },
    });
    if (!r.ok) {
      const m = registerDenialResponse(r.reason);
      return err(req, reply, m.status, m.code, m.message);
    }
    const user = r.user;
    // **邮箱没验过就不发会话。**
    //
    // 这条路不发验证邮件,所以它开出来的号一律是「没验过」的。原来它当场就把
    // 人登进去,于是「注册」和「证明这个邮箱是我的」被合成了一件事 —— 而这
    // 正是抢注链的第一环:拿别人的邮箱在这里开一个号,当场就有一个能用的会话,
    // 之后这个号还会被受害者的外部登录认领回来。
    //
    // 发会话这件事从此只归 /auth/login:注册完自己再登一次,行为对真实用户
    // 只差一次请求,对抢注的人少了一个「立刻就能用」的号。
    // (响应里补一条 emailVerified,调用方不用靠「有没有 set-cookie」去猜。)
    if (user.emailVerified) await createSession(reply, user.id, { kind: "password" });
    return ok(req, reply, {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      emailVerified: user.emailVerified,
    });
  });

  app.post("/auth/login", {
    // Per-route auth limiter — the global 120/min was the only brake on this
    // path, letting it be used to brute-force around the account lockout.
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    // Login loosens the password length floor — passwordPolicyError is
    // for NEW passwords only; legacy ones may pre-date the policy bump.
    const loginBody = z.object({
      email: z.string().email().transform((s) => s.toLowerCase().trim()),
      password: z.string().min(1).max(200),
    }).parse(req.body);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, loginBody.email)).limit(1);
    if (!user) {
      // Timing-safe: burn the same CPU as a real verify so the
      // does-this-email-exist channel is closed.
      await verifyPasswordTimingSafe(loginBody.password);
      return err(req, reply, 401, "invalid_credentials", "邮箱或密码错误");
    }
    // Account lockout — mirror the web /login path so the JSON API can't be
    // used to brute-force around the lockout (or keep hitting a web-locked
    // account). Same brake on both surfaces.
    if (isLocked(user)) {
      return err(req, reply, 401, "account_locked", "账号已临时锁定，请稍后再试或重置密码");
    }
    const passOk = await verifyPassword(loginBody.password, user.passwordHash);
    if (!passOk) {
      await recordFailedLogin(user);
      return err(req, reply, 401, "invalid_credentials", "邮箱或密码错误");
    }
    // Disabled-account gate: return the same 401 so we don't leak the
    // disabled-vs-doesn't-exist distinction.
    if (!userIsActive(user)) return err(req, reply, 401, "invalid_credentials", "邮箱或密码错误");
    await resetFailedLogin(user.id);
    // **开了二次验证的账号,这条路不发会话。**
    //
    // 以前这里直接 createSession(reply, user.id) —— 而当时 createSession 的
    // mfaSatisfied 默认是 true。结果是:只要有账号密码(撞库、泄露库、钓鱼),
    // 打这个接口就能拿到一个**已过二次验证**的完整会话,网页、后台、API 全放行。
    // 网页表单那条路一直是对的(见 src/web/index.ts:551 → /login/mfa),
    // 同一件事两条路口径不同,而没防住的那条正好是不需要浏览器的那条。
    //
    // 这条路本身没有补验证码的下一步(/login/mfa 是网页表单,要 CSRF;
    // /auth/login-mfa-verify 建的是设备不是会话),所以不发半登录会话、
    // 直接如实拒绝,并指向两条真的能走完的路。
    //
    // 403 不是 401:401 在原生端的含义是「会话没了,去重新登录」,
    // 而这里根本还没有会话。三端 App 用的都是 /auth/login-password,
    // 没有一个调这条,所以这次改动不影响任何已发布的版本。
    if (user.mfaEnabled) {
      return err(
        req, reply, 403, "mfa_required",
        "这个账号开启了两步验证。请在网页上登录，或改用 /auth/login-password（App 用的那条，支持在应用内输入验证码）。",
      );
    }
    await createSession(reply, user.id, { kind: "password" });
    return ok(req, reply, { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.post("/auth/logout", async (req, reply) => {
    await destroySession(req, reply);
    return ok(req, reply, { ok: true });
  });

  // "any":token 有效就能问「我是谁」,但**邮箱和显示名要 read:profile**。
  // 不这么做的话,存量集成(默认只授了 read:events)换完 token 的第一步就 403,
  // 而且没有迁移路径 —— 已签发 token 里的 scope 是写死在库里的那份。
  app.get("/auth/me", { config: { oauthScope: "any" } }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const via = (req as unknown as { authVia?: string }).authVia;
    const scopes = (req as unknown as { oauthScopes?: string[] }).oauthScopes ?? [];
    // 只有 OAuth 这条路要裁。会话 cookie、设备 token、bwc_ API token
    // 走各自的判定,行为一点不变。
    const hideProfile = via === "oauth" && !scopes.includes("read:profile");
    return ok(req, reply, {
      id: user.id,
      email: hideProfile ? null : user.email,
      displayName: hideProfile ? null : user.displayName,
      isAdmin: hideProfile ? false : user.isAdmin,
    });
  });
}
