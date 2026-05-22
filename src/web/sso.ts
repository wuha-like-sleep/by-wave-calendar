import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { createSession } from "../lib/session.js";
import { getProviderBySlug, listEnabledProvidersPublic } from "../lib/sso_providers.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  generatePkce,
  randomState,
} from "../lib/sso.js";
import { recordLoginEvent } from "../lib/login_history.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";
import { setThemeCookies } from "../lib/user_theme.js";
import { userIsActive } from "../lib/user_state.js";
import { hashPassword } from "../lib/password.js";

const STATE_COOKIE = "bwc_sso_state";

// Redirect URI used in the OIDC dance. We deliberately use /auth/idp/...
// instead of /auth/sso/... because 宝塔 / 阿里云 / 等 WAF 默认规则把
// "sso" 当成敏感关键字直接 444 拦截 (拦掉 IdP 回调 = SSO 流程整个废掉).
// Keeps the old /auth/sso/* paths registered too so previously-configured
// IdPs that already point to /auth/sso/callback keep working IF the
// user whitelists /auth/sso in their WAF; new providers should use the
// /auth/idp variant.
function redirectUri(): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/idp/callback`;
}

export async function ssoRoutes(app: FastifyInstance) {
  // Legacy entry point (only one Keycloak): pick the first enabled provider,
  // or 404 if SSO isn't enabled. Keeps old "use SSO login" buttons working.
  // Dual-registered on /auth/sso and /auth/idp so the in-app button works
  // even when the WAF blocks the "sso" variant.
  const handleLegacyLogin = async (_req: FastifyRequest, reply: FastifyReply) => {
    const list = await listEnabledProvidersPublic();
    if (list.length === 0) return reply.code(404).type("text/plain").send("SSO not enabled");
    return reply.redirect(`/auth/idp/${encodeURIComponent(list[0]!.slug)}/login`);
  };
  app.get("/auth/sso/login", handleLegacyLogin);
  app.get("/auth/idp/login", handleLegacyLogin);

  const handleProviderLogin = async (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const slug = req.params.slug;
    const prov = await getProviderBySlug(slug);
    if (!prov || !prov.enabled) return reply.code(404).type("text/plain").send("Provider not found");
    try {
      const state = randomState();
      const nonce = randomState();
      const { verifier, challenge } = generatePkce();
      const cookieValue = Buffer.from(JSON.stringify({ slug, state, nonce, verifier })).toString("base64url");
      reply.setCookie(STATE_COOKIE, cookieValue, {
        httpOnly: true,
        sameSite: "lax",
        secure: env.NODE_ENV === "production",
        path: "/",
        maxAge: 10 * 60,
      });
      const url = await buildAuthorizeUrl({
        providerSlug: slug,
        redirectUri: redirectUri(),
        state,
        nonce,
        codeChallenge: challenge,
      });
      return reply.redirect(url);
    } catch (err) {
      req.log.warn({ err, slug }, "sso_login_start_failed");
      return reply.redirect("/login?error=" + encodeURIComponent("SSO 配置异常：" + (err instanceof Error ? err.message : "未知错误")));
    }
  };
  app.get<{ Params: { slug: string } }>("/auth/sso/:slug/login", handleProviderLogin);
  app.get<{ Params: { slug: string } }>("/auth/idp/:slug/login", handleProviderLogin);

  const handleCallback = async (
    req: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>,
    reply: FastifyReply,
  ) => {
      if (req.query.error) {
        return reply.redirect("/login?error=" + encodeURIComponent(`SSO 返回错误：${req.query.error_description || req.query.error}`));
      }

      const cookie = req.cookies[STATE_COOKIE];
      if (!cookie) return reply.redirect("/login?error=" + encodeURIComponent("SSO 会话已过期，请重试"));
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      let parsed: { slug: string; state: string; nonce: string; verifier: string };
      try {
        parsed = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
      } catch {
        return reply.redirect("/login?error=" + encodeURIComponent("SSO 状态损坏"));
      }

      const prov = await getProviderBySlug(parsed.slug);
      if (!prov || !prov.enabled) {
        return reply.redirect("/login?error=" + encodeURIComponent("SSO 提供方已被关闭"));
      }
      if (!req.query.state || req.query.state !== parsed.state) {
        return reply.redirect("/login?error=" + encodeURIComponent("SSO state 不匹配（可能 CSRF 攻击）"));
      }
      if (!req.query.code) {
        return reply.redirect("/login?error=" + encodeURIComponent("SSO 未返回授权码"));
      }

      try {
        const tokens = await exchangeCode({
          providerSlug: parsed.slug,
          code: req.query.code,
          redirectUri: redirectUri(),
          codeVerifier: parsed.verifier,
        });
        const info = await fetchUserinfo(parsed.slug, tokens.access_token);
        const email = (info.email ?? "").toLowerCase().trim();
        if (!email) {
          return reply.redirect("/login?error=" + encodeURIComponent("SSO 用户没有 email，无法登录"));
        }

        // Find or create the user.
        let [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
        if (!user) {
          // SSO users have no local password — the IdP is the source of truth.
          // But the password_hash column is notNull, so we store a real bcrypt
          // hash of a random ~256-bit value. The hash IS valid bcrypt, just
          // unguessable, so any future "compare against passwordHash" code
          // path can't accidentally succeed against an SSO-only account.
          // (Earlier this was a raw base64 string — bcrypt.compare would
          // safely return false against that, but it violated the column's
          // contract and would have been catastrophic if a future bug ever
          // bypassed the bcrypt check.)
          const stubPassword = await hashPassword(randomBytes(32).toString("base64"));
          const [created] = await db
            .insert(schema.users)
            .values({
              email,
              // SSO IdP already verified the email — skip our own verification flow.
              emailVerified: true,
              passwordHash: stubPassword,
              displayName: info.name || info.preferred_username || null,
              ssoProviderSlug: parsed.slug,
            })
            .returning();
          if (!created) return reply.redirect("/login?error=" + encodeURIComponent("创建账号失败"));
          user = created;
          await db.insert(schema.calendars).values({
            ownerId: user.id, name: "My Calendar", color: "#6366f1", timezone: "Asia/Shanghai",
          });
        } else {
          // Disabled-account gate: stop the SSO flow BEFORE writing any login
          // event row or sending a success email, otherwise a disabled user
          // can keep triggering "you just signed in" alerts indefinitely.
          if (!userIsActive(user)) {
            return reply.redirect("/login?error=" + encodeURIComponent("账号已被管理员停用"));
          }
          // Existing user signing in via SSO — flip verified flag if it wasn't
          // already and record which provider this account uses for login.
          const patch: Partial<schema.User> = {};
          if (!user.emailVerified) patch.emailVerified = true;
          if (user.ssoProviderSlug !== parsed.slug) patch.ssoProviderSlug = parsed.slug;
          if (Object.keys(patch).length > 0) {
            patch.updatedAt = new Date();
            await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
            user = { ...user, ...patch } as schema.User;
          }
        }

        await createSession(reply, user.id, { mfaSatisfied: true });
        setThemeCookies(reply, user.themePalette, user.themeDensity);
        void notifyLoginSuccess(req, user, "sso").catch((err) => req.log.warn({ err }, "login_alert_failed"));
        void recordLoginEvent(req, user.id, "sso").catch((err) => req.log.warn({ err }, "login_event_failed"));
        return reply.redirect("/app");
      } catch (err) {
        req.log.warn({ err, slug: parsed.slug }, "sso_callback_failed");
        return reply.redirect("/login?error=" + encodeURIComponent("SSO 登录失败：" + (err instanceof Error ? err.message : "未知错误")));
      }
  };
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/auth/sso/callback", handleCallback);
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/auth/idp/callback", handleCallback);
}
