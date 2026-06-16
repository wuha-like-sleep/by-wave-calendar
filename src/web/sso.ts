import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { createSession, loadSession } from "../lib/session.js";
import { getProviderBySlug, listEnabledProvidersPublic } from "../lib/sso_providers.js";
import { findUserIdByIdentity, linkIdentity } from "../lib/identities.js";
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

  const handleProviderLogin = async (req: FastifyRequest<{ Params: { slug: string }; Querystring: { link?: string } }>, reply: FastifyReply) => {
    const slug = req.params.slug;
    const prov = await getProviderBySlug(slug);
    if (!prov || !prov.enabled) return reply.code(404).type("text/plain").send("Provider not found");
    // Link mode: a logged-in user is BINDING this SSO identity to their current
    // account (rather than logging in/switching). Only honored when a session
    // actually exists; the callback re-checks the session as the authority.
    const linkMode = req.query.link === "1" && Boolean(await loadSession(req));
    try {
      const state = randomState();
      const nonce = randomState();
      const { verifier, challenge } = generatePkce();
      const cookieValue = Buffer.from(JSON.stringify({ slug, state, nonce, verifier, link: linkMode })).toString("base64url");
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
  app.get<{ Params: { slug: string }; Querystring: { link?: string } }>("/auth/sso/:slug/login", handleProviderLogin);
  app.get<{ Params: { slug: string }; Querystring: { link?: string } }>("/auth/idp/:slug/login", handleProviderLogin);

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

      let parsed: { slug: string; state: string; nonce: string; verifier: string; link?: boolean };
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
        const subject = (info.sub ?? "").trim();
        if (!email) {
          return reply.redirect("/login?error=" + encodeURIComponent("SSO 用户没有 email，无法登录"));
        }
        if (!subject) {
          return reply.redirect("/login?error=" + encodeURIComponent("SSO 令牌缺少 sub，无法识别身份"));
        }

        // ---- Link mode: bind this SSO identity to the CURRENT account. ----
        // The session cookie survives the OIDC round-trip, so re-read it here
        // as the authority (the state cookie only flags intent). We do NOT
        // switch/create accounts in this branch.
        if (parsed.link) {
          const session = await loadSession(req);
          if (!session) {
            return reply.redirect("/login?error=" + encodeURIComponent("绑定失败：请先登录后再绑定 SSO"));
          }
          const linked = await linkIdentity({ userId: session.user.id, provider: parsed.slug, subject, email });
          if (!linked.ok) {
            return reply.redirect("/app/settings/security?error=" + encodeURIComponent("该 SSO 身份已绑定到别的账号"));
          }
          if (session.user.ssoProviderSlug !== parsed.slug) {
            await db.update(schema.users).set({ ssoProviderSlug: parsed.slug, updatedAt: new Date() }).where(eq(schema.users.id, session.user.id));
          }
          return reply.redirect("/app/settings/security?success=" + encodeURIComponent("已绑定 SSO 登录方式"));
        }

        // ---- Normal login: resolve by (provider, subject) → email → create. ----
        let user: schema.User | undefined;
        const byIdentityUserId = await findUserIdByIdentity(parsed.slug, subject);
        if (byIdentityUserId) {
          [user] = await db.select().from(schema.users).where(eq(schema.users.id, byIdentityUserId)).limit(1);
        }
        if (!user) {
          // Fall back to email — preserves the historical "same email = same
          // account" behavior — and auto-link the subject so subsequent logins
          // match by subject even if the IdP later changes the email.
          [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
          if (user) {
            await linkIdentity({ userId: user.id, provider: parsed.slug, subject, email });
          }
        }
        if (!user) {
          // Brand-new SSO user. SSO accounts have no local password — the IdP is
          // the source of truth — but password_hash is notNull, so store a valid
          // bcrypt hash of a random ~256-bit value (unguessable; any future
          // "compare against passwordHash" path safely fails).
          const stubPassword = await hashPassword(randomBytes(32).toString("base64"));
          const [created] = await db
            .insert(schema.users)
            .values({
              email,
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
          await linkIdentity({ userId: user.id, provider: parsed.slug, subject, email });
        }

        // Disabled-account gate: stop BEFORE writing any login event / alert,
        // otherwise a disabled user can keep triggering "you just signed in".
        if (!userIsActive(user)) {
          return reply.redirect("/login?error=" + encodeURIComponent("账号已被管理员停用"));
        }
        // Keep the email-verified flag + last-used provider fresh.
        {
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
        // 返回到失效前的页面 —— bwc_return_to cookie 写在 /login 入口
        // 或鉴权失败时。SSO 跳转期间 cookie 一直在浏览器里，回来读得到。
        let redirect = "/app";
        const raw = req.cookies["bwc_return_to"];
        if (raw) {
          const unsigned = req.unsignCookie(raw);
          if (unsigned.valid && unsigned.value) {
            const v = unsigned.value;
            if (v.length > 0 && v.length <= 200 &&
                v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") &&
                /^\/(app|admin|web-pair|desktop-pair)(\/|$|\?|#)/.test(v)) {
              redirect = v.split("#")[0] ?? "/app";
            }
          }
          reply.clearCookie("bwc_return_to", { path: "/" });
        }
        return reply.redirect(redirect);
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
