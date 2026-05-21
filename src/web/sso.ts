import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { createSession } from "../lib/session.js";
import { getSettings, getSsoConfig } from "../lib/site_settings.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  generatePkce,
  randomState,
} from "../lib/sso.js";
import { recordLoginEvent } from "../lib/login_history.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";

const STATE_COOKIE = "bwc_sso_state";

function redirectUri(): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/sso/callback`;
}

export async function ssoRoutes(app: FastifyInstance) {
  app.get("/auth/sso/login", async (req, reply) => {
    const settings = await getSettings();
    if (!settings.ssoKeycloakEnabled) {
      return reply.code(404).type("text/plain").send("SSO not enabled");
    }
    try {
      const state = randomState();
      const nonce = randomState();
      const { verifier, challenge } = generatePkce();
      const cookieValue = Buffer.from(JSON.stringify({ state, nonce, verifier })).toString("base64url");
      reply.setCookie(STATE_COOKIE, cookieValue, {
        httpOnly: true,
        sameSite: "lax",
        secure: env.NODE_ENV === "production",
        path: "/",
        maxAge: 10 * 60,
      });
      const url = await buildAuthorizeUrl({
        redirectUri: redirectUri(),
        state,
        nonce,
        codeChallenge: challenge,
      });
      return reply.redirect(url);
    } catch (err) {
      req.log.warn({ err }, "sso_login_start_failed");
      return reply.redirect("/login?error=" + encodeURIComponent("SSO 配置异常：" + (err instanceof Error ? err.message : "未知错误")));
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/auth/sso/callback",
    async (req, reply) => {
      if (req.query.error) {
        return reply.redirect("/login?error=" + encodeURIComponent(`SSO 返回错误：${req.query.error_description || req.query.error}`));
      }
      const sso = await getSsoConfig();
      if (!sso.enabled) return reply.redirect("/login?error=" + encodeURIComponent("SSO 已被关闭"));

      const cookie = req.cookies[STATE_COOKIE];
      if (!cookie) return reply.redirect("/login?error=" + encodeURIComponent("SSO 会话已过期，请重试"));
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      let parsed: { state: string; nonce: string; verifier: string };
      try {
        parsed = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
      } catch {
        return reply.redirect("/login?error=" + encodeURIComponent("SSO 状态损坏"));
      }
      if (!req.query.state || req.query.state !== parsed.state) {
        return reply.redirect("/login?error=" + encodeURIComponent("SSO state 不匹配（可能 CSRF 攻击）"));
      }
      if (!req.query.code) {
        return reply.redirect("/login?error=" + encodeURIComponent("SSO 未返回授权码"));
      }

      try {
        const tokens = await exchangeCode({
          code: req.query.code,
          redirectUri: redirectUri(),
          codeVerifier: parsed.verifier,
        });
        const info = await fetchUserinfo(tokens.access_token);
        const email = (info.email ?? "").toLowerCase().trim();
        if (!email) {
          return reply.redirect("/login?error=" + encodeURIComponent("SSO 用户没有 email，无法登录"));
        }

        // Find or create the user.
        let [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
        if (!user) {
          // Create a stub user; password is random (account is SSO-only unless they set one later via /forgot-password).
          const stubPassword = randomBytes(32).toString("base64");
          const [created] = await db
            .insert(schema.users)
            .values({
              email,
              emailVerified: info.email_verified ?? true,
              passwordHash: stubPassword, // intentionally unusable for password login
              displayName: info.name || info.preferred_username || null,
            })
            .returning();
          if (!created) return reply.redirect("/login?error=" + encodeURIComponent("创建账号失败"));
          user = created;
        }

        await createSession(reply, user.id, { mfaSatisfied: true });
        void notifyLoginSuccess(req, user, "sso").catch((err) => req.log.warn({ err }, "login_alert_failed"));
        void recordLoginEvent(req, user.id, "sso").catch((err) => req.log.warn({ err }, "login_event_failed"));
        return reply.redirect("/app");
      } catch (err) {
        req.log.warn({ err }, "sso_callback_failed");
        return reply.redirect("/login?error=" + encodeURIComponent("SSO 登录失败：" + (err instanceof Error ? err.message : "未知错误")));
      }
    },
  );
}
