import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { verifyCsrf, csrfTokenFor } from "../lib/csrf.js";
import {
  loadSession,
  markSessionMfaSatisfied,
  destroyAllUserSessions,
  createSession,
} from "../lib/session.js";
import {
  consumeBackupCode,
  generateBackupCodes,
  newTotpSecret,
  totpQrDataUrl,
  verifyTotpCode,
  type BackupCode,
} from "../lib/mfa.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";
import { recordLoginEvent } from "../lib/login_history.js";

function flashFromQuery(req: any) {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return {
    error: typeof q.error === "string" ? q.error : undefined,
    success: typeof q.success === "string" ? q.success : undefined,
  };
}

export async function mfaRoutes(app: FastifyInstance) {
  // ---- Login MFA challenge ----
  app.get("/login/mfa", async (req, reply) => {
    const s = await loadSession(req);
    if (!s) return reply.redirect("/login");
    if (s.mfaSatisfied || !s.user.mfaEnabled) return reply.redirect("/app");
    return reply.view("auth/mfa", {
      title: "二次验证",
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
    });
  });

  app.post("/login/mfa", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const s = await loadSession(req);
    if (!s) return reply.redirect("/login");
    if (s.mfaSatisfied || !s.user.mfaEnabled) return reply.redirect("/app");

    const body = z.object({ code: z.string().min(6).max(20) }).safeParse(req.body);
    if (!body.success) return reply.redirect("/login/mfa?error=" + encodeURIComponent("请输入 6 位验证码"));

    const code = body.data.code.trim();
    const secret = s.user.mfaTotpSecret;
    if (!secret) return reply.redirect("/login?error=" + encodeURIComponent("MFA 配置异常"));

    if (verifyTotpCode(secret, code)) {
      await markSessionMfaSatisfied(req);
      void notifyLoginSuccess(req, s.user, "mfa").catch((err) => req.log.warn({ err }, "login_alert_failed"));
      void recordLoginEvent(req, s.user.id, "mfa").catch((err) => req.log.warn({ err }, "login_event_failed"));
      return reply.redirect("/app");
    }

    // Try as backup code
    const codes = (s.user.mfaBackupCodes as BackupCode[] | null) ?? [];
    const consumed = consumeBackupCode(codes, code);
    if (consumed.ok) {
      await db
        .update(schema.users)
        .set({ mfaBackupCodes: consumed.updated as unknown as object, updatedAt: new Date() })
        .where(eq(schema.users.id, s.user.id));
      await markSessionMfaSatisfied(req);
      void notifyLoginSuccess(req, s.user, "mfa").catch((err) => req.log.warn({ err }, "login_alert_failed"));
      void recordLoginEvent(req, s.user.id, "mfa").catch((err) => req.log.warn({ err }, "login_event_failed"));
      return reply.redirect("/app?success=" + encodeURIComponent("已使用备用码登录，请重新生成"));
    }

    req.log.warn({ userId: s.user.id, ip: req.ip }, "mfa_failed");
    return reply.redirect("/login/mfa?error=" + encodeURIComponent("验证码错误"));
  });

  // ---- MFA setup (authed) ----
  app.get("/app/settings/mfa/setup", async (req, reply) => {
    const s = await loadSession(req);
    if (!s || (s.user.mfaEnabled && !s.mfaSatisfied)) return reply.redirect("/login");
    if (s.user.mfaEnabled) return reply.redirect("/app/settings?error=" + encodeURIComponent("已启用 MFA，先停用再重新设置"));

    const secret = newTotpSecret();
    const qr = await totpQrDataUrl(s.user.email, secret);

    return reply.view("app/mfa-setup", {
      title: "设置二次验证",
      user: s.user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      secret,
      qr,
    });
  });

  app.post("/app/settings/mfa/enable", async (req, reply) => {
    const s = await loadSession(req);
    if (!s || !s.mfaSatisfied) return reply.redirect("/login");
    if (!verifyCsrf(req, reply)) return;
    if (s.user.mfaEnabled) return reply.redirect("/app/settings");

    const body = z
      .object({ secret: z.string().min(16).max(64), code: z.string().min(6).max(8) })
      .safeParse(req.body);
    if (!body.success) return reply.redirect("/app/settings/mfa/setup?error=" + encodeURIComponent("请输入验证码"));

    if (!verifyTotpCode(body.data.secret, body.data.code)) {
      return reply.redirect("/app/settings/mfa/setup?error=" + encodeURIComponent("验证码错误，请重新扫码再试"));
    }

    const { plain, stored } = generateBackupCodes();
    await db
      .update(schema.users)
      .set({
        mfaEnabled: true,
        mfaTotpSecret: body.data.secret,
        mfaBackupCodes: stored as unknown as object,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, s.user.id));

    return reply.view("app/mfa-enabled", {
      title: "MFA 已启用",
      user: { ...s.user, mfaEnabled: true },
      csrfToken: csrfTokenFor(req),
      flash: { success: "MFA 已启用，请保存下面的备用码" },
      backupCodes: plain,
    });
  });

  app.post("/app/settings/mfa/disable", async (req, reply) => {
    const s = await loadSession(req);
    if (!s || !s.mfaSatisfied) return reply.redirect("/login");
    if (!verifyCsrf(req, reply)) return;
    if (!s.user.mfaEnabled) return reply.redirect("/app/settings");

    const body = z.object({ code: z.string().min(6).max(20) }).safeParse(req.body);
    if (!body.success) return reply.redirect("/app/settings?error=" + encodeURIComponent("请输入当前验证码以确认"));

    const secret = s.user.mfaTotpSecret;
    if (!secret) return reply.redirect("/app/settings?error=" + encodeURIComponent("MFA 状态异常"));
    if (!verifyTotpCode(secret, body.data.code)) {
      return reply.redirect("/app/settings?error=" + encodeURIComponent("验证码错误"));
    }
    await db
      .update(schema.users)
      .set({ mfaEnabled: false, mfaTotpSecret: null, mfaBackupCodes: null, updatedAt: new Date() })
      .where(eq(schema.users.id, s.user.id));
    return reply.redirect("/app/settings?success=" + encodeURIComponent("已关闭 MFA"));
  });

  app.post("/app/settings/mfa/regenerate-codes", async (req, reply) => {
    const s = await loadSession(req);
    if (!s || !s.mfaSatisfied) return reply.redirect("/login");
    if (!verifyCsrf(req, reply)) return;
    if (!s.user.mfaEnabled) return reply.redirect("/app/settings");
    const { plain, stored } = generateBackupCodes();
    await db
      .update(schema.users)
      .set({ mfaBackupCodes: stored as unknown as object, updatedAt: new Date() })
      .where(eq(schema.users.id, s.user.id));
    return reply.view("app/mfa-enabled", {
      title: "新的备用码",
      user: s.user,
      csrfToken: csrfTokenFor(req),
      flash: { success: "已生成新的备用码，旧的已失效" },
      backupCodes: plain,
    });
  });
}

// Note: createSession import is needed for the type but not used here directly;
// referenced indirectly through web/index.ts which handles initial session create.
void createSession;
void destroyAllUserSessions;
