import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { verifyCsrf, csrfTokenFor } from "../lib/csrf.js";
import { tForRequest } from "../lib/i18n.js";
import {
  loadSession,
  markSessionMfaSatisfied,
  destroyAllUserSessions,
  destroySession,
  createSession,
} from "../lib/session.js";
import { isLocked, lockedRemainingMinutes, recordFailedLogin, resetFailedLogin } from "../lib/login_lockout.js";
import {
  consumeBackupCode,
  generateBackupCodes,
  newTotpSecret,
  totpQrDataUrl,
  verifyTotpCode,
  type BackupCode,
} from "../lib/mfa.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";
import { sendMail } from "../lib/mailer.js";
import { securityChangeMail } from "../lib/email_templates.js";
import { recordLoginEvent } from "../lib/login_history.js";
import { setThemeCookies } from "../lib/user_theme.js";
import { returnToOrApp } from "../lib/return_to.js";

function flashFromQuery(req: any) {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return {
    error: typeof q.error === "string" ? q.error : undefined,
    success: typeof q.success === "string" ? q.success : undefined,
  };
}

/** Request-scoped translate for route handlers — flash messages, page
 *  titles, error-view copy. Locale comes from `req.locale`, stashed by the
 *  view-locals hook in src/server.ts. See tForRequest in src/lib/i18n.ts. */
function tr(req: FastifyRequest, key: string, vars?: Record<string, string | number>): string {
  return tForRequest(req)(key, vars);
}

export async function mfaRoutes(app: FastifyInstance) {
  // ---- Login MFA challenge ----
  app.get("/login/mfa", async (req, reply) => {
    const s = await loadSession(req);
    if (!s) return reply.redirect("/login");
    if (s.mfaSatisfied || !s.user.mfaEnabled) return reply.redirect("/app");
    return reply.view("auth/mfa", {
      title: tr(req, "page.mfa"),
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      // Mid-login, single purpose: bare chrome so the half-authenticated
      // session can't reach the nav or the ⌘K palette before MFA is satisfied.
      bareLayout: true,
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
    if (!body.success) return reply.redirect("/login/mfa?error=" + encodeURIComponent(tr(req, "flash.mfa.codeFormat")));

    const code = body.data.code.trim();
    const secret = s.user.mfaTotpSecret;
    if (!secret) return reply.redirect("/login?error=" + encodeURIComponent(tr(req, "flash.mfa.configError")));

    // 账号已经被锁（不管是密码错的还是验证码错的）：这个半登录作废，回登录页。
    // 否则锁着的账号在这一页照样能继续猜验证码。
    if (isLocked(s.user)) {
      await destroySession(req, reply);
      return reply.redirect("/login?error=" + encodeURIComponent(
        tr(req, "flash.login.lockedMinutes", { minutes: lockedRemainingMinutes(s.user) })));
    }

    // 回到原本要去的那一页。判据收在 lib/return_to.ts，四条登录路共用一份 ——
    // 这里原来是手抄的第三份，注释还写着「keep both in sync」。
    const consumeMfaReturnTo = () => returnToOrApp(req, reply);

    if (verifyTotpCode(secret, code)) {
      await resetFailedLogin(s.user.id);
      await markSessionMfaSatisfied(req);
      void notifyLoginSuccess(req, s.user, "mfa").catch((err) => req.log.warn({ err }, "login_alert_failed"));
      void recordLoginEvent(req, s.user.id, "mfa").catch((err) => req.log.warn({ err }, "login_event_failed"));
      setThemeCookies(reply, s.user.themePalette, s.user.themeDensity);
      return reply.redirect(consumeMfaReturnTo());
    }

    // Try as backup code
    const codes = (s.user.mfaBackupCodes as BackupCode[] | null) ?? [];
    const consumed = consumeBackupCode(codes, code);
    if (consumed.ok) {
      await db
        .update(schema.users)
        .set({ mfaBackupCodes: consumed.updated as unknown as object, updatedAt: new Date() })
        .where(eq(schema.users.id, s.user.id));
      await resetFailedLogin(s.user.id);
      await markSessionMfaSatisfied(req);
      void notifyLoginSuccess(req, s.user, "mfa").catch((err) => req.log.warn({ err }, "login_alert_failed"));
      void recordLoginEvent(req, s.user.id, "mfa").catch((err) => req.log.warn({ err }, "login_event_failed"));
      setThemeCookies(reply, s.user.themePalette, s.user.themeDensity);
      // Backup-code login: still honor return_to but tack on the
      // success message via query string so the user sees「已使用备用码」
      // banner on their original page.
      const target = consumeMfaReturnTo();
      const sep = target.includes("?") ? "&" : "?";
      return reply.redirect(target + sep + "success=" + encodeURIComponent(tr(req, "flash.mfa.backupUsed")));
    }

    req.log.warn({ userId: s.user.id, ip: req.ip }, "mfa_failed");
    // **验证码输错也算进账号锁定。** 以前只有密码错才算：拿到密码的人停在这一页，
    // 半登录能活好几天，只受「每个 IP 每分钟 10 次」限制，可以一直猜下去。
    // 锁定的次数和时长就是后台已经在配的那一套，没有另起一套。
    await recordFailedLogin(s.user);
    const [fresh] = await db.select().from(schema.users).where(eq(schema.users.id, s.user.id)).limit(1);
    if (fresh && isLocked(fresh)) {
      // 刚被锁上：这个半登录作废，要猜就得重新输密码 —— 而密码那一关也锁着。
      await destroySession(req, reply);
      return reply.redirect("/login?error=" + encodeURIComponent(
        tr(req, "flash.login.lockedMinutes", { minutes: lockedRemainingMinutes(fresh) })));
    }
    return reply.redirect("/login/mfa?error=" + encodeURIComponent(tr(req, "flash.code.wrong")));
  });

  // ---- MFA setup (authed) ----
  app.get("/app/settings/mfa/setup", async (req, reply) => {
    const s = await loadSession(req);
    if (!s || (s.user.mfaEnabled && !s.mfaSatisfied)) return reply.redirect("/login");
    if (s.user.mfaEnabled) return reply.redirect("/app/settings?error=" + encodeURIComponent(tr(req, "flash.mfa.alreadyEnabled")));

    const secret = newTotpSecret();
    const qr = await totpQrDataUrl(s.user.email, secret);

    return reply.view("app/mfa-setup", {
      title: tr(req, "page.mfaSetup"),
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
    if (!body.success) return reply.redirect("/app/settings/mfa/setup?error=" + encodeURIComponent(tr(req, "flash.mfa.enterCode")));

    if (!verifyTotpCode(body.data.secret, body.data.code)) {
      return reply.redirect("/app/settings/mfa/setup?error=" + encodeURIComponent(tr(req, "flash.mfa.wrongCodeRescan")));
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

    void sendMail(securityChangeMail(s.user.email, { kind: "mfa_enabled" }))
      .catch((err) => req.log.warn({ err }, "mfa_enable_mail_failed"));

    return reply.view("app/mfa-enabled", {
      title: tr(req, "page.mfaEnabled"),
      user: { ...s.user, mfaEnabled: true },
      csrfToken: csrfTokenFor(req),
      flash: { success: tr(req, "flash.mfa.enabled") },
      backupCodes: plain,
    });
  });

  app.post("/app/settings/mfa/disable", async (req, reply) => {
    const s = await loadSession(req);
    if (!s || !s.mfaSatisfied) return reply.redirect("/login");
    if (!verifyCsrf(req, reply)) return;
    if (!s.user.mfaEnabled) return reply.redirect("/app/settings");

    const body = z.object({ code: z.string().min(6).max(20) }).safeParse(req.body);
    if (!body.success) return reply.redirect("/app/settings?error=" + encodeURIComponent(tr(req, "flash.mfa.confirmCurrentCode")));

    const secret = s.user.mfaTotpSecret;
    if (!secret) return reply.redirect("/app/settings?error=" + encodeURIComponent(tr(req, "flash.mfa.stateError")));
    if (!verifyTotpCode(secret, body.data.code)) {
      return reply.redirect("/app/settings?error=" + encodeURIComponent(tr(req, "flash.code.wrong")));
    }
    await db
      .update(schema.users)
      .set({ mfaEnabled: false, mfaTotpSecret: null, mfaBackupCodes: null, updatedAt: new Date() })
      .where(eq(schema.users.id, s.user.id));
    void sendMail(securityChangeMail(s.user.email, { kind: "mfa_disabled" }))
      .catch((err) => req.log.warn({ err }, "mfa_disable_mail_failed"));
    return reply.redirect("/app/settings?success=" + encodeURIComponent(tr(req, "flash.mfa.disabled")));
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
      title: tr(req, "page.mfaBackupCodes"),
      user: s.user,
      csrfToken: csrfTokenFor(req),
      flash: { success: tr(req, "flash.mfa.backupRegenerated") },
      backupCodes: plain,
    });
  });
}

// Note: createSession import is needed for the type but not used here directly;
// referenced indirectly through web/index.ts which handles initial session create.
void createSession;
void destroyAllUserSessions;
