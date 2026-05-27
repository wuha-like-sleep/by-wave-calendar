import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { hashPassword, passwordPolicyError, verifyPassword, verifyPasswordTimingSafe } from "../lib/password.js";
import {
  createSession,
  destroyAllUserSessions,
  destroySession,
  loadSession,
  loadUserFromRequest,
} from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { newEventUid, newInvitationToken, newShareToken } from "../lib/ids.js";
import { isMailerEnabled, sendMail } from "../lib/mailer.js";
import { welcomeMail, passwordResetMail, calendarInviteMail, securityChangeMail, loginChallengeMail, eventInviteMail } from "../lib/email_templates.js";
import { invitationIcs } from "../lib/ical.js";
import { cancelEvent } from "../lib/event_cancel.js";
import { availableSlots, bookSlot, DEFAULT_AVAILABILITY, findLinkBySlug, type WeeklyAvailability } from "../lib/booking.js";
import { issueCode, verifyCode } from "../lib/email_verification.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";
import { getSettings } from "../lib/site_settings.js";
import { listTimezones } from "../lib/timezones.js";
import { isLocked, lockedRemainingMinutes, recordFailedLogin, resetFailedLogin } from "../lib/login_lockout.js";
import { invalidateCalDavAuthCache } from "../lib/caldav_auth.js";
import { createReset, loadValidReset, consumeReset } from "../lib/password_reset.js";
import { createLoginChallenge, isLoginFamiliar, verifyLoginChallenge } from "../lib/login_risk.js";
import { createAppPassword, listAppPasswords, revokeAppPassword } from "../lib/app_password.js";
import { fetchIcsUrl, importIcsText, refreshSubscription } from "../lib/ics_import.js";
import { buildIcsFeed } from "../services/ics.js";
import { listRecentLogins, recordLoginEvent } from "../lib/login_history.js";
import { canEdit, canView, isOwner, listMembers, listPendingInvitations, listVisibleCalendarIds } from "../lib/calendar_access.js";
import { randomBytes } from "node:crypto";
import { clearThemeCookies, DENSITIES, isValidDensity, isValidPalette, PALETTES, setThemeCookies } from "../lib/user_theme.js";

const PENDING_EMAIL_COOKIE = "bwc_pending_email";

type Flash = { error?: string; success?: string };

function flashFromQuery(req: FastifyRequest): Flash {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return {
    error: typeof q.error === "string" ? q.error : undefined,
    success: typeof q.success === "string" ? q.success : undefined,
  };
}

function redirectWith(reply: FastifyReply, path: string, flash?: Flash) {
  const params = new URLSearchParams();
  if (flash?.error) params.set("error", flash.error);
  if (flash?.success) params.set("success", flash.success);
  const qs = params.toString();
  return reply.redirect(qs ? `${path}?${qs}` : path);
}

// Emit a <time> element carrying the UTC instant; the client-side local-time.js
// reformats it in the visitor's browser timezone on load. The server-rendered
// inner text is a no-JS fallback in the calendar's stored TZ (or Shanghai).
function localTime(d: Date, timezone = "Asia/Shanghai", style: "datetime" | "date" | "time" | "full" | "relative" = "datetime"): string {
  const fallback = (() => {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(d);
    } catch {
      return d.toISOString();
    }
  })();
  return `<time data-tz datetime="${d.toISOString()}" data-style="${style}">${fallback}</time>`;
}

async function loadAuthedUser(req: FastifyRequest, reply: FastifyReply) {
  const s = await loadSession(req);
  if (!s) {
    redirectWith(reply, "/login", { error: "请先登录" });
    return null;
  }
  if (s.user.mfaEnabled && !s.mfaSatisfied) {
    reply.redirect("/login/mfa");
    return null;
  }
  return s.user;
}

async function ownerOfCalendar(calendarId: string): Promise<string> {
  const [row] = await db.select({ ownerId: schema.calendars.ownerId }).from(schema.calendars).where(eq(schema.calendars.id, calendarId)).limit(1);
  return row?.ownerId ?? "";
}

async function ownsCalendar(calendarId: string, userId: string) {
  const rows = await db
    .select({ id: schema.calendars.id })
    .from(schema.calendars)
    .where(and(eq(schema.calendars.id, calendarId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return rows.length > 0;
}

export async function webRoutes(app: FastifyInstance) {
  // -------- Public pages --------
  app.get("/", async (req, reply) => {
    const user = await loadUserFromRequest(req);
    if (user) return reply.redirect("/app");
    return reply.view("landing", {
      title: "首页",
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
    });
  });

  app.get("/about", async (req, reply) => {
    return reply.view("landing", {
      title: "关于",
      user: await loadUserFromRequest(req),
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
    });
  });

  // Privacy + Terms — required by Apple App Store Connect for any APP
  // that handles personal data. Linked from the site footer + iOS APP
  // Settings + initial signup flow. Updated date is sourced from
  // package.json's version timestamp via getReleaseDate so a server
  // upgrade automatically refreshes the "最近更新" line.
  app.get("/privacy", async (req, reply) => {
    const settings = await getSettings();
    return reply.view("legal/privacy", {
      title: "隐私政策",
      user: await loadUserFromRequest(req),
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      siteName: settings.siteName || "ByWave Calendar",
      updatedDate: "2026-05-24",
    });
  });

  app.get("/terms", async (req, reply) => {
    const settings = await getSettings();
    return reply.view("legal/terms", {
      title: "使用条款",
      user: await loadUserFromRequest(req),
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      siteName: settings.siteName || "ByWave Calendar",
      updatedDate: "2026-05-24",
    });
  });

  // Public landing for app downloads — iOS App Store + Android APK +
  // browser fallback. Linked from the footer + landing hero + GitHub
  // / Gitee READMEs. URLs below are surfaced as locals so a single-line
  // edit here is the only thing needed when we cut a new release.
  //
  // Empty strings render the "not yet available" placeholder branches
  // in the template; non-empty strings switch to active download
  // buttons. Don't conditionally include the keys — the template reads
  // them with `<%= varName %>` which would print "undefined" on missing.
  app.get("/download", async (req, reply) => {
    const settings = await getSettings();
    // Read the Android release manifest so the version + APK link shown on
    // /download stays in sync with what the in-app updater sees. Falls
    // back to "not yet published" placeholders if the manifest is missing.
    // Prefers the manifest's downloadUrl (typically a GitHub Releases URL)
    // and falls back to the legacy server-hosted /downloads/android/ path.
    const { getLatestRelease } = await import("../lib/android_release.js");
    const rel = await getLatestRelease();
    const apkUrl = rel
      ? (rel.downloadUrl || `/downloads/android/${encodeURIComponent(rel.filename)}`)
      : "";
    const apkSize = rel
      ? `${(rel.sizeBytes / 1024 / 1024).toFixed(1)} MB`
      : "~15 MB";

    // Desktop release (DMG / MSI / DEB) — self-hosted only on this server,
    // never mirrored to GitHub/Gitee Releases because the desktop binary
    // hardcodes rl.lz-ss.com as the default server URL. Manifest is
    // optional; absence renders "coming soon" placeholders.
    const { getLatestRelease: getDesktopRelease } = await import("../lib/desktop_release.js");
    const desktop = await getDesktopRelease();
    const fmtSize = (n?: number) => n && n > 0 ? `${(n / 1024 / 1024).toFixed(1)} MB` : "";
    const desktopMacUrl = desktop?.assets.mac
      ? `/downloads/desktop/${encodeURIComponent(desktop.assets.mac.filename)}`
      : "";
    const desktopWinUrl = desktop?.assets.win
      ? `/downloads/desktop/${encodeURIComponent(desktop.assets.win.filename)}`
      : "";
    const desktopLinuxUrl = desktop?.assets.linux
      ? `/downloads/desktop/${encodeURIComponent(desktop.assets.linux.filename)}`
      : "";
    return reply.view("download", {
      title: "下载",
      user: await loadUserFromRequest(req),
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      siteName: settings.siteName || "ByWave Calendar",
      // iOS — App Store proper is now live as of 2026-05-26 (app id
      // 6772655143). TestFlight public beta also stays open as the
      // pre-release channel for v1.3.7+ builds we want to ship faster
      // than App Store's review cadence. The download template promotes
      // App Store to primary CTA when iosAppStoreUrl is non-empty and
      // automatically demotes TestFlight to a small secondary "Beta"
      // link below — no template change needed.
      iosVersion: "1.3.7",
      iosAppStoreUrl: "https://apps.apple.com/us/app/bywavecalendar/id6772655143",
      iosTestFlightUrl: "https://testflight.apple.com/join/rkM3hkpX",
      iosEtaWeek: "本周内",
      // Android — version + APK URL come from the live manifest at
      // apps/android/releases/latest.json (committed) or data/app-android-
      // manifest.json (runtime override). When the manifest is absent we
      // show the GitHub/Gitee Releases fallback links so users can still
      // find a build. The notes field, if present, surfaces below the
      // download button as a collapsible "本版更新内容" disclosure.
      androidVersion: rel?.versionName || "0.8.0",
      androidApkUrl: apkUrl,
      androidApkSize: apkSize,
      androidNotes: rel?.notes || "",
      androidApkGitHub: "https://github.com/wuha-like-sleep/by-wave-calendar/releases",
      androidApkGitee: "https://gitee.com/zhaorunsen/by-wave-calendar/releases",
      androidEtaWeek: "本月内",
      // Desktop — Mac (DMG) + Win (MSI) + Linux (DEB). Each URL is empty
      // until a manifest for that platform is published; the template
      // renders a "coming soon" branch when empty. Versions and notes
      // are shared across platforms (one Kotlin codebase → one release
      // bundle), so we expose a single `desktopVersion` rather than
      // per-OS variants.
      desktopVersion: desktop?.versionName || "v0.2",
      desktopNotes: desktop?.notes || "",
      desktopMacUrl,
      desktopMacSize: fmtSize(desktop?.assets.mac?.sizeBytes),
      desktopWinUrl,
      desktopWinSize: fmtSize(desktop?.assets.win?.sizeBytes),
      desktopLinuxUrl,
      desktopLinuxSize: fmtSize(desktop?.assets.linux?.sizeBytes),
      desktopEtaWeek: "本月内",
    });
  });

  // Public-facing support / help page. Required for App Store
  // submission — Apple wants a working Support URL that doesn't 404
  // and lets users contact us without an account. Also linked from
  // the site footer alongside /privacy and /terms.
  app.get("/support", async (req, reply) => {
    const settings = await getSettings();
    return reply.view("legal/support", {
      title: "技术支持",
      user: await loadUserFromRequest(req),
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      siteName: settings.siteName || "ByWave Calendar",
      updatedDate: "2026-05-24",
    });
  });

  // -------- Auth pages --------
  app.get("/login", async (req, reply) => {
    const user = await loadUserFromRequest(req);
    if (user) return reply.redirect("/app");
    return reply.view("auth/login", {
      title: "登录",
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      form: {},
    });
  });

  app.post("/login", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({
        // Normalize email here so /login agrees with /register, /forgot-password,
        // SSO, and CalDAV — they all lowercase+trim, but web /login used to
        // pass the raw value through. That meant a user who typed "ME@x.com"
        // saw "邮箱或密码错误" even though they were correctly registered as
        // "me@x.com". Worse, the JSON API could create shadow rows in
        // mixed case that bypassed disabled-account checks keyed on lowercase.
        email: z.string().email().transform((s) => s.toLowerCase().trim()),
        password: z.string().min(1).max(200),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/login", { error: "邮箱或密码格式不正确" });
    }
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, body.data.email)).limit(1);
    if (!user) {
      // Burn the same ~250ms of CPU as a real bcrypt verify so the
      // no-such-user path is time-indistinguishable from the wrong-
      // password path. Without this, an attacker can enumerate
      // registered emails by measuring response time.
      await verifyPasswordTimingSafe(body.data.password);
      req.log.warn({ email: body.data.email, ip: req.ip }, "login_failed_no_user");
      return redirectWith(reply, "/login", { error: "邮箱或密码错误" });
    }
    if (user.disabledAt) {
      req.log.warn({ userId: user.id, email: user.email, ip: req.ip }, "login_blocked_disabled");
      return redirectWith(reply, "/login", { error: "账号已停用，请联系管理员" });
    }
    if (isLocked(user)) {
      const mins = lockedRemainingMinutes(user);
      return redirectWith(reply, "/login", { error: `账号已临时锁定，请 ${mins} 分钟后再试，或点击「忘记密码」重置。` });
    }
    if (!(await verifyPassword(body.data.password, user.passwordHash))) {
      await recordFailedLogin(user);
      req.log.warn({ userId: user.id, email: body.data.email, ip: req.ip }, "login_failed");
      return redirectWith(reply, "/login", { error: "邮箱或密码错误" });
    }
    await resetFailedLogin(user.id);

    // Risk check: if the user has prior successful logins but this IP/UA is
    // unfamiliar AND they don't have MFA already in the loop, gate this login
    // behind an email-delivered 6-digit code. MFA users skip — TOTP already
    // covers the "new device" case. Passkey users skip too (they took a
    // different code path entirely; this branch is only for password login).
    // Admin can disable the whole thing via /admin/security → riskLoginEnabled.
    const settings = await getSettings();
    const ua = String(req.headers["user-agent"] ?? "unknown");
    const familiar = settings.riskLoginEnabled
      ? await isLoginFamiliar(user.id, req.ip, ua)
      : true;
    if (!familiar && !user.mfaEnabled) {
      const issued = await createLoginChallenge(user.id, req.ip, ua);
      try {
        await sendMail(loginChallengeMail(user.email, issued.code, { ip: req.ip, userAgent: ua }));
      } catch (err) {
        req.log.warn({ err }, "login_challenge_mail_failed");
        return redirectWith(reply, "/login", { error: "需要邮件验证，但邮件发送失败 —— 请联系管理员" });
      }
      reply.setCookie("bwc_login_chall", issued.token, {
        httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/", maxAge: 10 * 60,
      });
      return reply.redirect("/login/challenge");
    }

    await createSession(reply, user.id, { mfaSatisfied: !user.mfaEnabled });
    setThemeCookies(reply, user.themePalette, user.themeDensity);
    if (user.mfaEnabled) return reply.redirect("/login/mfa");
    void notifyLoginSuccess(req, user, "password").catch((err) => req.log.warn({ err }, "login_alert_failed"));
    void recordLoginEvent(req, user.id, "password").catch((err) => req.log.warn({ err }, "login_event_failed"));
    return reply.redirect("/app");
  });

  // -------- Login challenge (new-device email code) --------
  app.get("/login/challenge", async (req, reply) => {
    const token = req.cookies["bwc_login_chall"];
    if (!token) return reply.redirect("/login");
    return reply.view("auth/login-challenge", {
      title: "安全验证",
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
    });
  });

  app.post("/login/challenge", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const token = req.cookies["bwc_login_chall"];
    if (!token) return reply.redirect("/login");
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return redirectWith(reply, "/login/challenge", { error: "请输入 6 位数字验证码" });
    const result = await verifyLoginChallenge(token, body.data.code);
    if (!result.ok) {
      const msg: Record<string, string> = {
        no_challenge: "验证已过期，请重新登录",
        expired: "验证码已过期，请重新登录",
        too_many_attempts: "尝试次数过多，请重新登录",
        wrong: "验证码错误",
      };
      if (result.reason !== "wrong") reply.clearCookie("bwc_login_chall", { path: "/" });
      return redirectWith(reply, result.reason === "wrong" ? "/login/challenge" : "/login", {
        error: msg[result.reason] ?? "验证失败",
      });
    }
    reply.clearCookie("bwc_login_chall", { path: "/" });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, result.userId)).limit(1);
    if (!user) return redirectWith(reply, "/login", { error: "用户不存在" });
    await createSession(reply, user.id, { mfaSatisfied: !user.mfaEnabled });
    setThemeCookies(reply, user.themePalette, user.themeDensity);
    if (user.mfaEnabled) return reply.redirect("/login/mfa");
    void notifyLoginSuccess(req, user, "password").catch((err) => req.log.warn({ err }, "login_alert_failed"));
    void recordLoginEvent(req, user.id, "password").catch((err) => req.log.warn({ err }, "login_event_failed"));
    return reply.redirect("/app");
  });

  // -------- Forgot / reset password --------
  app.get("/forgot-password", async (req, reply) => {
    return reply.view("auth/forgot-password", {
      title: "忘记密码",
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      form: {},
    });
  });

  app.post("/forgot-password", {
    config: { rateLimit: { max: 3, timeWindow: "5 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({ email: z.string().email().max(254) }).safeParse(req.body);
    // Generic response regardless of whether the email exists, to prevent enumeration.
    const generic = "如果该邮箱已注册，重置链接将很快到达邮箱（请检查垃圾邮件）。";
    if (!body.success) {
      return redirectWith(reply, "/forgot-password", { success: generic });
    }
    const email = body.data.email.toLowerCase().trim();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (user) {
      try {
        const token = await createReset(user.id);
        await sendMail(passwordResetMail(user.email, token));
      } catch (err) {
        req.log.warn({ err, email }, "password_reset_send_failed");
      }
    } else {
      req.log.info({ email, ip: req.ip }, "forgot_password_unknown_email");
    }
    return redirectWith(reply, "/forgot-password", { success: generic });
  });

  app.get<{ Params: { token: string } }>("/reset-password/:token", async (req, reply) => {
    const token = req.params.token;
    const reset = await loadValidReset(token);
    if (!reset) {
      return reply.code(400).view("error", {
        title: "链接无效",
        user: null,
        csrfToken: csrfTokenFor(req),
        flash: {},
        statusCode: 400,
        heading: "重置链接无效或已过期",
        message: "请重新申请密码重置邮件。链接 1 小时内有效，且每个链接只能使用一次。",
      });
    }
    return reply.view("auth/reset-password", {
      title: "重置密码",
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      token,
    });
  });

  app.post<{ Params: { token: string } }>("/reset-password/:token", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const token = req.params.token;
    const reset = await loadValidReset(token);
    if (!reset) {
      return redirectWith(reply, "/forgot-password", { error: "重置链接无效或已过期，请重新申请" });
    }
    const body = z
      .object({
        password: z.string().min(8).max(200),
        confirm: z.string().min(1).max(200),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/reset-password/${encodeURIComponent(token)}`, { error: "密码至少 8 位" });
    }
    if (body.data.password !== body.data.confirm) {
      return redirectWith(reply, `/reset-password/${encodeURIComponent(token)}`, { error: "两次输入的密码不一致" });
    }
    const policyErr = passwordPolicyError(body.data.password);
    if (policyErr) {
      return redirectWith(reply, `/reset-password/${encodeURIComponent(token)}`, { error: policyErr });
    }
    const passwordHash = await hashPassword(body.data.password);
    await db
      .update(schema.users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(schema.users.id, reset.userId));
    await consumeReset(token);
    await destroyAllUserSessions(reset.userId);
    return redirectWith(reply, "/login", { success: "密码已重置，请使用新密码登录" });
  });

  app.get("/register", async (req, reply) => {
    const settings = await getSettings();
    if (settings.registrationMode === "closed") {
      return reply.code(403).view("error", {
        title: "注册关闭",
        user: null,
        csrfToken: csrfTokenFor(req),
        flash: {},
        statusCode: 403,
        heading: "注册已关闭",
        message: "管理员暂时关闭了开放注册。",
      });
    }
    if (settings.registrationMode === "invite") {
      return reply.code(403).view("error", {
        title: "仅邀请注册",
        user: null,
        csrfToken: csrfTokenFor(req),
        flash: {},
        statusCode: 403,
        heading: "仅邀请注册",
        message: "本站当前仅接受邀请注册，请联系管理员获取邀请链接。",
      });
    }
    const user = await loadUserFromRequest(req);
    if (user) return reply.redirect("/app");
    return reply.view("auth/register", {
      title: "注册",
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      form: {},
    });
  });

  app.post("/register", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const settings = await getSettings();
    if (settings.registrationMode !== "public") {
      return redirectWith(reply, "/login", { error: "公开注册已关闭" });
    }
    const body = z
      .object({
        email: z.string().email().max(254),
        password: z.string().min(8).max(200),
        displayName: z.string().max(100).optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
        // honeypot field — must be empty
        company: z.string().max(0).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/register", { error: "邮箱或密码格式不正确" });
    }
    const policyErr = passwordPolicyError(body.data.password);
    if (policyErr) {
      return redirectWith(reply, "/register", { error: policyErr });
    }
    const email = body.data.email.toLowerCase().trim();
    const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (existing.length > 0) {
      return redirectWith(reply, "/register", { error: "该邮箱已注册" });
    }
    const passwordHash = await hashPassword(body.data.password);

    const result = await issueCode(email, { passwordHash, displayName: body.data.displayName ?? null });
    if (!result.ok) {
      return redirectWith(reply, "/register", { error: "验证码发送失败，请稍后重试或联系管理员" });
    }

    reply.setCookie(PENDING_EMAIL_COOKIE, email, {
      httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/", maxAge: 15 * 60,
    });

    // If mailer is disabled in dev, the code was returned so we can log it.
    if (result.code && env.NODE_ENV === "development") {
      req.log.info(`[dev] verification code for ${email} = ${result.code}`);
    }

    return redirectWith(reply, "/verify-email", { success: "验证码已发送至你的邮箱，10 分钟内有效" });
  });

  app.get("/verify-email", async (req, reply) => {
    const email = req.cookies[PENDING_EMAIL_COOKIE];
    if (!email) return reply.redirect("/register");
    return reply.view("auth/verify-email", {
      title: "验证邮箱",
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      email,
      mailerEnabled: await isMailerEnabled(),
    });
  });

  app.post("/verify-email", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const email = req.cookies[PENDING_EMAIL_COOKIE];
    if (!email) return reply.redirect("/register");

    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return redirectWith(reply, "/verify-email", { error: "请输入 6 位数字验证码" });

    const result = await verifyCode(email, body.data.code);
    if (!result.ok) {
      const reasonMap: Record<string, string> = {
        no_pending: "未发现待验证的注册请求，请重新注册",
        expired: "验证码已过期，请重新获取",
        too_many_attempts: "尝试次数过多，请稍后再试",
        wrong: "验证码错误",
      };
      const msg = reasonMap[result.reason ?? "wrong"] ?? "验证失败";
      return redirectWith(reply, "/verify-email", { error: msg });
    }

    // If the user already exists (re-verification path for old unverified accounts),
    // just flip emailVerified=true. Otherwise create the user + seed default calendar.
    const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    let user: schema.User | undefined;
    if (existing) {
      const [updated] = await db
        .update(schema.users)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(schema.users.id, existing.id))
        .returning();
      user = updated;
    } else {
      const [created] = await db
        .insert(schema.users)
        .values({
          email,
          emailVerified: true,
          passwordHash: result.payload!.passwordHash,
          displayName: result.payload!.displayName,
        })
        .returning();
      user = created;
      if (user) {
        await db.insert(schema.calendars).values({
          ownerId: user.id, name: "My Calendar", color: "#6366f1", timezone: "Asia/Shanghai",
        });
      }
    }
    if (!user) return redirectWith(reply, "/verify-email", { error: "完成验证失败" });

    reply.clearCookie(PENDING_EMAIL_COOKIE, { path: "/" });
    // Don't overwrite an existing session if the user was already logged in.
    const existingSession = await loadSession(req);
    if (!existingSession) await createSession(reply, user.id);
    if (!existing) {
      void sendMail(welcomeMail(user.email, user.displayName)).catch((err) => req.log.warn({ err }, "welcome_mail_failed"));
    }
    return reply.redirect("/app");
  });

  app.post("/verify-email/resend", {
    config: { rateLimit: { max: 3, timeWindow: "5 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const email = req.cookies[PENDING_EMAIL_COOKIE];
    if (!email) return reply.redirect("/register");

    // We need the original pending payload to re-issue. Read from DB.
    const [pending] = await db
      .select()
      .from(schema.emailVerifications)
      .where(eq(schema.emailVerifications.email, email))
      .limit(1);
    if (!pending) return redirectWith(reply, "/register", { error: "请重新发起注册" });

    const payload = pending.payload as unknown as { passwordHash: string; displayName: string | null };
    const result = await issueCode(email, payload);
    if (!result.ok) return redirectWith(reply, "/verify-email", { error: "发送失败，请稍后重试" });
    return redirectWith(reply, "/verify-email", { success: "新的验证码已发送" });
  });

  // Logout handler — shared by two URL surfaces.
  //
  // We register at BOTH /logout and /sign-out because 宝塔 / 阿里云 / 各种
  // WAF often have default rules that block the literal "/logout" path
  // (CSRF-paranoid rule false-positive), returning 444. Hosters can't
  // always disable WAF rules, so we ship a safe alternative.
  //
  // POST requires CSRF; GET is intentionally idempotent (URL-bar flow,
  // service-worker fetch, etc.) — the worst a CSRF "attack" can do is
  // log the user out, which is the same outcome they were aiming at.
  const doLogoutPost = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!verifyCsrf(req, reply)) return;
    await destroySession(req, reply);
    clearThemeCookies(reply);
    return reply.redirect("/");
  };
  const doLogoutGet = async (req: FastifyRequest, reply: FastifyReply) => {
    await destroySession(req, reply);
    clearThemeCookies(reply);
    // Optional ?next= for "log out then go to <page>" flows (e.g. the
    // invite/accept page wanting to land the user on /login afterwards).
    // Strict relative-path validation — must start with "/" and not "//"
    // (which would be a protocol-relative URL → open redirect).
    const next = typeof (req.query as { next?: string }).next === "string"
      ? (req.query as { next: string }).next
      : "";
    const safe = /^\/[^/]/.test(next) ? next : "/";
    return reply.redirect(safe);
  };
  app.post("/logout", doLogoutPost);
  app.get("/logout", doLogoutGet);
  app.post("/sign-out", doLogoutPost);
  app.get("/sign-out", doLogoutGet);

  // -------- Authed app --------
  // Main calendar view (Google/Synology-style grid + sidebar).
  app.get("/app", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const owned = await db
      .select({
        id: schema.calendars.id,
        name: schema.calendars.name,
        color: schema.calendars.color,
        timezone: schema.calendars.timezone,
      })
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id))
      .orderBy(asc(schema.calendars.name));
    const shared = await db
      .select({
        id: schema.calendars.id,
        name: schema.calendars.name,
        color: schema.calendars.color,
        timezone: schema.calendars.timezone,
        role: schema.calendarMembers.role,
      })
      .from(schema.calendars)
      .innerJoin(schema.calendarMembers, eq(schema.calendarMembers.calendarId, schema.calendars.id))
      .where(eq(schema.calendarMembers.userId, user.id))
      .orderBy(asc(schema.calendars.name));
    // Deduplicate (owner can't also be member, but be defensive)
    const seen = new Set(owned.map((c) => c.id));
    const calendars = [...owned, ...shared.filter((c) => !seen.has(c.id))];

    return reply.view("app/calendar-app", {
      title: "日历",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      calendars,
      timezones: listTimezones(),
      publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
      appShell: true,
    });
  });

  // Legacy card-grid dashboard, kept as an alt view.
  app.get("/app/calendars", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const rows = await db
      .select({
        id: schema.calendars.id,
        name: schema.calendars.name,
        description: schema.calendars.description,
        color: schema.calendars.color,
        timezone: schema.calendars.timezone,
        eventCount: sql<number>`coalesce(count(${schema.events.id}), 0)::int`,
      })
      .from(schema.calendars)
      .leftJoin(schema.events, eq(schema.events.calendarId, schema.calendars.id))
      .where(eq(schema.calendars.ownerId, user.id))
      .groupBy(schema.calendars.id)
      .orderBy(desc(schema.calendars.createdAt));

    return reply.view("app/dashboard", {
      title: "我的日历",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      calendars: rows,
    });
  });

  app.post("/app/calendars", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        timezone: z.string().max(100).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/app", { error: "请填写日历名称" });
    }
    await db.insert(schema.calendars).values({ ownerId: user.id, ...body.data });
    return redirectWith(reply, "/app", { success: "日历已创建" });
  });

  app.get<{ Params: { id: string } }>("/app/calendars/:id", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");

    const [calendar] = await db.select().from(schema.calendars).where(eq(schema.calendars.id, calId.data)).limit(1);
    if (!calendar) return reply.redirect("/app");

    const eventRows = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, calendar.id), isNull(schema.events.deletedAt)))
      .orderBy(asc(schema.events.startsAt));

    const tokenRows = await db
      .select()
      .from(schema.shareTokens)
      .where(and(eq(schema.shareTokens.calendarId, calendar.id), isNull(schema.shareTokens.revokedAt)))
      .orderBy(desc(schema.shareTokens.createdAt));

    const subs = await db
      .select()
      .from(schema.calendarSubscriptions)
      .where(eq(schema.calendarSubscriptions.calendarId, calendar.id))
      .orderBy(desc(schema.calendarSubscriptions.createdAt));

    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");

    return reply.view("app/calendar", {
      title: calendar.name,
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      calendar,
      events: eventRows.map((e) => ({
        ...e,
        startsAtLocal: localTime(e.startsAt, calendar.timezone),
        endsAtLocal: localTime(e.endsAt, calendar.timezone),
      })),
      shareTokens: tokenRows.map((t) => ({ ...t, url: `${baseUrl}/ics/${t.token}.ics` })),
      subscriptions: subs.map((s) => ({
        ...s,
        lastFetchedAtLocal: s.lastFetchedAt ? localTime(s.lastFetchedAt) : null,
      })),
      members: await listMembers(calendar.id),
      pendingInvitations: (await listPendingInvitations(calendar.id)).map((i) => ({
        ...i,
        createdAtLocal: localTime(i.createdAt),
        expiresAtLocal: localTime(i.expiresAt),
      })),
    });
  });

  // ---------- ICS import ----------
  // Single-calendar ICS snapshot download. Different from /ics/<token>:
  // - This one is a one-shot file download (Content-Disposition: attachment),
  //   not a subscription. The user gets a frozen .ics they can attach to
  //   an email or import into another tool.
  // - Auth is the normal session, not a share token — so you can grab your
  //   own calendar without minting (and later having to revoke) a public URL.
  app.get<{ Params: { id: string } }>("/app/calendars/:id/export.ics", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.code(404).type("text/plain").send("Not Found");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.code(404).type("text/plain").send("Not Found");
    const [cal] = await db.select().from(schema.calendars).where(eq(schema.calendars.id, calId.data)).limit(1);
    if (!cal) return reply.code(404).type("text/plain").send("Not Found");
    const events = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, cal.id), isNull(schema.events.deletedAt)))
      .orderBy(asc(schema.events.startsAt));
    const body = buildIcsFeed(cal, events);
    // Slug the filename so e.g. "工作 / Work" doesn't blow up downloads.
    const safeName = cal.name.replace(/[^a-zA-Z0-9一-鿿-]+/g, "_").slice(0, 50) || "calendar";
    reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="${safeName}.ics"`)
      .send(body);
  });

  app.post<{ Params: { id: string } }>("/app/calendars/:id/import/file", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");

    const file = await req.file();
    if (!file) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "请选择 .ics 文件" });
    }
    const buf = await file.toBuffer();
    if (buf.length > 5 * 1024 * 1024) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "文件过大（>5MB）" });
    }
    const text = buf.toString("utf8");
    if (!text.toUpperCase().includes("BEGIN:VCALENDAR")) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "不是有效的 iCalendar 文件" });
    }
    try {
      const result = await importIcsText(calId.data, text, { sourceTag: `file:${file.filename ?? "upload"}` });
      return redirectWith(reply, `/app/calendars/${calId.data}`, {
        success: `导入成功：新增 ${result.inserted} · 更新 ${result.updated} · 跳过 ${result.skipped}`,
      });
    } catch (err) {
      req.log.warn({ err }, "ics_file_import_failed");
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "导入失败：" + (err instanceof Error ? err.message : "未知错误") });
    }
  });

  app.post<{ Params: { id: string } }>("/app/calendars/:id/import/text", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");

    const body = z.object({ text: z.string().min(20).max(5 * 1024 * 1024) }).safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "请粘贴 .ics 文本内容" });
    }
    if (!body.data.text.toUpperCase().includes("BEGIN:VCALENDAR")) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "粘贴的内容不是 iCalendar 格式" });
    }
    try {
      const result = await importIcsText(calId.data, body.data.text, { sourceTag: "paste" });
      return redirectWith(reply, `/app/calendars/${calId.data}`, {
        success: `导入成功：新增 ${result.inserted} · 更新 ${result.updated} · 跳过 ${result.skipped}`,
      });
    } catch (err) {
      req.log.warn({ err }, "ics_text_import_failed");
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "导入失败：" + (err instanceof Error ? err.message : "未知错误") });
    }
  });

  app.post<{ Params: { id: string } }>("/app/calendars/:id/import/url-once", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");

    const body = z.object({ url: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "请输入有效的 URL" });
    }
    try {
      const text = await fetchIcsUrl(body.data.url);
      const result = await importIcsText(calId.data, text, { sourceTag: `url-once` });
      return redirectWith(reply, `/app/calendars/${calId.data}`, {
        success: `从 URL 导入成功：新增 ${result.inserted} · 更新 ${result.updated} · 跳过 ${result.skipped}`,
      });
    } catch (err) {
      req.log.warn({ err }, "ics_url_import_failed");
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "拉取失败：" + (err instanceof Error ? err.message : "未知错误") });
    }
  });

  app.post<{ Params: { id: string } }>("/app/calendars/:id/subscriptions", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");

    const body = z
      .object({
        url: z.string().min(1).max(2000),
        label: z.string().max(60).optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
        refreshMinutes: z.coerce.number().int().min(15).max(10080).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "请输入有效的订阅 URL" });
    }

    const [sub] = await db
      .insert(schema.calendarSubscriptions)
      .values({
        calendarId: calId.data,
        url: body.data.url.trim(),
        label: body.data.label ?? null,
        refreshMinutes: body.data.refreshMinutes ?? 360,
      })
      .returning({ id: schema.calendarSubscriptions.id });
    if (!sub) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "保存订阅失败" });
    }

    const refresh = await refreshSubscription(sub.id);
    if (!refresh.ok) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, {
        error: `订阅已保存但首次拉取失败：${refresh.error}（将按周期重试）`,
      });
    }
    return redirectWith(reply, `/app/calendars/${calId.data}`, {
      success: `订阅创建并同步成功：新增 ${refresh.result.inserted} · 更新 ${refresh.result.updated}`,
    });
  });

  app.post<{ Params: { id: string; subId: string } }>("/app/calendars/:id/subscriptions/:subId/refresh", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const params = z.object({ id: z.string().uuid(), subId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.redirect("/app");
    if (!(await ownsCalendar(params.data.id, user.id))) return reply.redirect("/app");
    const refresh = await refreshSubscription(params.data.subId);
    if (!refresh.ok) {
      return redirectWith(reply, `/app/calendars/${params.data.id}`, { error: "同步失败：" + refresh.error });
    }
    return redirectWith(reply, `/app/calendars/${params.data.id}`, {
      success: `同步完成：新增 ${refresh.result.inserted} · 更新 ${refresh.result.updated}`,
    });
  });

  app.post<{ Params: { id: string; subId: string } }>("/app/calendars/:id/subscriptions/:subId/delete", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const params = z.object({ id: z.string().uuid(), subId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.redirect("/app");
    if (!(await ownsCalendar(params.data.id, user.id))) return reply.redirect("/app");
    await db
      .delete(schema.calendarSubscriptions)
      .where(and(
        eq(schema.calendarSubscriptions.id, params.data.subId),
        eq(schema.calendarSubscriptions.calendarId, params.data.id),
      ));
    return redirectWith(reply, `/app/calendars/${params.data.id}`, { success: "订阅已删除（已导入事件保留）" });
  });

  app.post<{ Params: { id: string } }>("/app/calendars/:id/delete", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    await db
      .delete(schema.calendars)
      .where(and(eq(schema.calendars.id, calId.data), eq(schema.calendars.ownerId, user.id)));
    return redirectWith(reply, "/app", { success: "日历已删除" });
  });

  app.post<{ Params: { id: string } }>("/app/calendars/:id/events", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");

    const body = z
      .object({
        summary: z.string().min(1).max(500),
        description: z.string().max(5000).optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
        location: z.string().max(500).optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
        startsAt: z.string().min(1),
        endsAt: z.string().min(1),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "请检查输入" });
    }

    const starts = new Date(body.data.startsAt);
    const ends = new Date(body.data.endsAt);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "时间格式无效" });
    }
    if (ends < starts) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "结束时间不能早于开始时间" });
    }

    await db.insert(schema.events).values({
      calendarId: calId.data,
      uid: newEventUid(),
      summary: body.data.summary,
      description: body.data.description,
      location: body.data.location,
      startsAt: starts,
      endsAt: ends,
    });
    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: "事件已添加" });
  });

  // ---------- Event attendees (dedicated invite/revoke page) ----------
  app.get<{ Params: { id: string } }>("/app/events/:id/attendees", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const evId = z.string().uuid().safeParse(req.params.id);
    if (!evId.success) return reply.redirect("/app");
    const [ev] = await db
      .select()
      .from(schema.events)
      .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
      .where(and(eq(schema.events.id, evId.data), eq(schema.calendars.ownerId, user.id)))
      .limit(1);
    if (!ev) return reply.redirect("/app");
    const event = ev.events;
    const calendar = ev.calendars;
    if (event.deletedAt) {
      // Allow viewing the audit trail; just slap a "cancelled" badge on top.
    }
    const extra = (event.extra as { attendees?: string[]; url?: string } | null) ?? {};
    const attendees = Array.isArray(extra.attendees) ? extra.attendees : [];
    const tokens = await db
      .select()
      .from(schema.eventInviteTokens)
      .where(eq(schema.eventInviteTokens.sourceEventId, event.id))
      .orderBy(desc(schema.eventInviteTokens.createdAt));
    return reply.view("app/event-attendees", {
      title: "管理参与者 · " + event.summary,
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      event: {
        ...event,
        startsAtLocal: localTime(event.startsAt, calendar.timezone, event.allDay ? "date" : "datetime"),
        endsAtLocal: localTime(event.endsAt, calendar.timezone, event.allDay ? "date" : "datetime"),
      },
      calendar,
      attendees,
      tokens: tokens.map((t) => ({
        ...t,
        createdAtLocal: localTime(t.createdAt),
        expiresAtLocal: localTime(t.expiresAt),
        acceptedAtLocal: t.acceptedAt ? localTime(t.acceptedAt) : null,
      })),
    });
  });

  app.post<{ Params: { id: string } }>("/app/events/:id/attendees/invite", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const evId = z.string().uuid().safeParse(req.params.id);
    if (!evId.success) return reply.redirect("/app");
    const body = z.object({ email: z.string().email().max(254) }).safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/app/events/${evId.data}/attendees`, { error: "请输入合法邮箱" });
    }
    const inviteeEmail = body.data.email.toLowerCase().trim();

    const [ev] = await db
      .select()
      .from(schema.events)
      .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
      .where(and(eq(schema.events.id, evId.data), eq(schema.calendars.ownerId, user.id)))
      .limit(1);
    if (!ev) return reply.redirect("/app");
    const event = ev.events;
    const extra = (event.extra as Record<string, unknown> | null) ?? {};
    const current = Array.isArray(extra.attendees) ? (extra.attendees as string[]) : [];
    if (current.includes(inviteeEmail)) {
      return redirectWith(reply, `/app/events/${evId.data}/attendees`, { error: `${inviteeEmail} 已是参与者` });
    }
    const next = [...current, inviteeEmail];
    await db.update(schema.events).set({ extra: { ...extra, attendees: next }, updatedAt: new Date() }).where(eq(schema.events.id, event.id));

    // Fire the invite mail with .ics attachment + deep-link token (mirror /api/events).
    const inviteToken = newInvitationToken();
    try {
      await db.insert(schema.eventInviteTokens).values({
        token: inviteToken,
        sourceEventId: event.id,
        recipientEmail: inviteeEmail,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      const ics = invitationIcs({
        event: {
          uid: event.uid,
          summary: event.summary,
          description: event.description,
          location: event.location,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          allDay: event.allDay,
          updatedAt: new Date(),
        },
        organizerEmail: user.email,
        organizerName: user.displayName || user.email,
        attendees: [{ email: inviteeEmail }],
        method: "REQUEST",
      });
      await sendMail(eventInviteMail(inviteeEmail, {
        organizerEmail: user.email,
        organizerName: user.displayName || user.email,
        summary: event.summary,
        description: event.description,
        location: event.location,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        uid: event.uid,
        timezone: (event.extra as { timezone?: string } | null)?.timezone ?? null,
        icsBody: ics,
        inviteToken,
      }));
    } catch (err) {
      req.log.warn({ err, to: inviteeEmail }, "event_invite_send_failed");
      return redirectWith(reply, `/app/events/${evId.data}/attendees`, {
        error: `${inviteeEmail} 已添加为参与者，但邀请邮件发送失败`,
      });
    }
    return redirectWith(reply, `/app/events/${evId.data}/attendees`, { success: `已邀请 ${inviteeEmail}` });
  });

  app.post<{ Params: { id: string } }>("/app/events/:id/attendees/revoke", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const evId = z.string().uuid().safeParse(req.params.id);
    if (!evId.success) return reply.redirect("/app");
    const body = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!body.success) return reply.redirect(`/app/events/${evId.data}/attendees`);
    const target = body.data.email.toLowerCase().trim();

    const [ev] = await db
      .select()
      .from(schema.events)
      .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
      .where(and(eq(schema.events.id, evId.data), eq(schema.calendars.ownerId, user.id)))
      .limit(1);
    if (!ev) return reply.redirect("/app");
    const event = ev.events;
    const extra = (event.extra as Record<string, unknown> | null) ?? {};
    const current = Array.isArray(extra.attendees) ? (extra.attendees as string[]) : [];
    const next = current.filter((e) => e !== target);
    await db.update(schema.events).set({ extra: { ...extra, attendees: next }, updatedAt: new Date() }).where(eq(schema.events.id, event.id));
    // Invalidate pending tokens for this recipient (accepted ones stay for audit)
    await db
      .delete(schema.eventInviteTokens)
      .where(and(
        eq(schema.eventInviteTokens.sourceEventId, event.id),
        eq(schema.eventInviteTokens.recipientEmail, target),
        isNull(schema.eventInviteTokens.acceptedAt),
      ));
    return redirectWith(reply, `/app/events/${evId.data}/attendees`, { success: `已撤销 ${target}` });
  });

  app.post<{ Params: { id: string } }>("/app/events/:id/delete", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const evId = z.string().uuid().safeParse(req.params.id);
    if (!evId.success) return reply.redirect("/app");

    const rows = await db
      .select({ id: schema.events.id, calendarId: schema.events.calendarId })
      .from(schema.events)
      .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
      .where(and(eq(schema.events.id, evId.data), eq(schema.calendars.ownerId, user.id)))
      .limit(1);
    const target = rows[0];
    if (!target) return reply.redirect("/app");
    const result = await cancelEvent(target.id, { id: user.id, email: user.email, displayName: user.displayName });
    const msg = result.cancelledNotices > 0
      ? `事件已取消，已给 ${result.cancelledNotices} 位参与者发送取消通知`
      : "事件已删除";
    return redirectWith(reply, `/app/calendars/${target.calendarId}`, { success: msg });
  });

  app.post<{ Params: { id: string } }>("/app/calendars/:id/share-tokens", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");
    const body = z.object({ label: z.string().max(100).optional().transform((v) => (v?.trim() ? v.trim() : undefined)) }).safeParse(req.body ?? {});
    const label = body.success ? body.data.label : undefined;
    await db.insert(schema.shareTokens).values({ token: newShareToken(), calendarId: calId.data, label });
    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: "已生成新的订阅链接" });
  });

  app.post<{ Params: { id: string; token: string } }>("/app/calendars/:id/share-tokens/:token/revoke", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const params = z.object({ id: z.string().uuid(), token: z.string().min(1) }).safeParse(req.params);
    if (!params.success) return reply.redirect("/app");
    if (!(await ownsCalendar(params.data.id, user.id))) return reply.redirect("/app");
    await db
      .update(schema.shareTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.shareTokens.token, params.data.token), eq(schema.shareTokens.calendarId, params.data.id)));
    return redirectWith(reply, `/app/calendars/${params.data.id}`, { success: "订阅链接已撤销" });
  });

  // ---------- Calendar invitations ----------
  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  app.post<{ Params: { id: string } }>("/app/calendars/:id/invitations", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");

    const body = z
      .object({
        email: z.string().email().max(254),
        role: z.enum(["viewer", "editor"]).default("viewer"),
        message: z.string().max(500).optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "请输入有效的邮箱（最长 254 字符）" });
    }
    const inviteeEmail = body.data.email.toLowerCase().trim();

    const [cal] = await db.select().from(schema.calendars).where(eq(schema.calendars.id, calId.data)).limit(1);
    if (!cal) return reply.redirect("/app");

    // If the invitee already exists and is already a member, short-circuit.
    const [invitee] = await db.select().from(schema.users).where(eq(schema.users.email, inviteeEmail)).limit(1);
    if (invitee) {
      const [existing] = await db
        .select({ id: schema.calendarMembers.id })
        .from(schema.calendarMembers)
        .where(and(eq(schema.calendarMembers.calendarId, calId.data), eq(schema.calendarMembers.userId, invitee.id)))
        .limit(1);
      if (existing) {
        return redirectWith(reply, `/app/calendars/${calId.data}`, { error: `${inviteeEmail} 已是协作者` });
      }
    }

    const token = newInvitationToken();
    await db.insert(schema.calendarInvitations).values({
      token,
      calendarId: calId.data,
      email: inviteeEmail,
      role: body.data.role,
      invitedBy: user.id,
      message: body.data.message ?? null,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });

    try {
      await sendMail(calendarInviteMail(inviteeEmail, {
        calendarName: cal.name,
        inviterName: user.displayName || user.email,
        role: body.data.role,
        message: body.data.message ?? null,
        token,
      }));
    } catch (err) {
      req.log.warn({ err }, "invite_send_failed");
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: "邀请已创建，但邮件发送失败" });
    }

    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: `已邀请 ${inviteeEmail}（7 天内有效）` });
  });

  app.post<{ Params: { id: string; token: string } }>("/app/calendars/:id/invitations/:token/revoke", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");
    await db
      .delete(schema.calendarInvitations)
      .where(and(
        eq(schema.calendarInvitations.calendarId, calId.data),
        eq(schema.calendarInvitations.token, req.params.token),
      ));
    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: "邀请已撤销" });
  });

  app.post<{ Params: { id: string; memberId: string } }>("/app/calendars/:id/members/:memberId/remove", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    const memberId = z.string().uuid().safeParse(req.params.memberId);
    if (!calId.success || !memberId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");
    await db
      .delete(schema.calendarMembers)
      .where(and(
        eq(schema.calendarMembers.id, memberId.data),
        eq(schema.calendarMembers.calendarId, calId.data),
      ));
    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: "已移除成员" });
  });

  // ---------- Event-invite deep link ("添加到我的日历" from the email) ----------
  // Returns the .ics for an invite token; Google/Apple/Outlook auto-import.
  // No login required — the token IS the credential.
  app.get<{ Params: { token: string } }>("/event-invite/:token.ics", async (req, reply) => {
    const [tok] = await db.select().from(schema.eventInviteTokens).where(eq(schema.eventInviteTokens.token, req.params.token)).limit(1);
    if (!tok || tok.expiresAt < new Date()) return reply.code(410).type("text/plain").send("Invitation expired");
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, tok.sourceEventId)).limit(1);
    if (!event) return reply.code(404).type("text/plain").send("Event not found");
    if (event.deletedAt) return reply.code(410).type("text/plain").send("Event was cancelled by the organizer");
    const [organizer] = await db.select().from(schema.users).where(eq(schema.users.id, await ownerOfCalendar(event.calendarId))).limit(1);
    const ics = invitationIcs({
      event: {
        uid: event.uid, summary: event.summary, description: event.description,
        location: event.location, startsAt: event.startsAt, endsAt: event.endsAt,
        allDay: event.allDay, updatedAt: event.updatedAt,
      },
      organizerEmail: organizer?.email ?? "noreply@bywave.example",
      organizerName: organizer?.displayName || organizer?.email || "ByWave Calendar",
      attendees: [{ email: tok.recipientEmail }],
      method: "REQUEST",
    });
    reply.header("Content-Type", 'text/calendar; charset=utf-8; method=REQUEST');
    reply.header("Content-Disposition", `attachment; filename="${event.summary.replace(/[^\w-]/g, "_").slice(0, 40)}.ics"`);
    return reply.send(ics);
  });

  // RSVP — independent of "did you add to your own calendar"
  app.post<{ Params: { token: string } }>("/event-invite/:token/respond", async (req, reply) => {
    const body = z.object({ status: z.enum(["accepted", "declined", "tentative"]) }).safeParse(req.body);
    if (!body.success) return reply.redirect(`/event-invite/${encodeURIComponent(req.params.token)}?error=bad-status`);
    const [tok] = await db.select().from(schema.eventInviteTokens).where(eq(schema.eventInviteTokens.token, req.params.token)).limit(1);
    if (!tok || tok.expiresAt < new Date()) return reply.redirect(`/event-invite/${encodeURIComponent(req.params.token)}?error=expired`);
    // Block RSVP when event is cancelled — the response would be meaningless.
    const [ev] = await db.select({ deletedAt: schema.events.deletedAt }).from(schema.events).where(eq(schema.events.id, tok.sourceEventId)).limit(1);
    if (ev?.deletedAt) return reply.redirect(`/event-invite/${encodeURIComponent(req.params.token)}?error=event-cancelled`);
    await db
      .update(schema.eventInviteTokens)
      .set({ responseStatus: body.data.status, respondedAt: new Date() })
      .where(eq(schema.eventInviteTokens.token, tok.token));
    // Bump the source event's updatedAt so CalDAV ETag / ctag invalidates
    // for the organizer's iOS Calendar — without this, the phone keeps
    // showing PARTSTAT=NEEDS-ACTION because it never re-fetches.
    await db
      .update(schema.events)
      .set({ updatedAt: new Date() })
      .where(eq(schema.events.id, tok.sourceEventId));
    const msg = body.data.status === "accepted" ? "已回复：参加"
              : body.data.status === "declined" ? "已回复：不参加"
              :                                   "已回复：可能参加";
    return reply.redirect(`/event-invite/${encodeURIComponent(req.params.token)}?success=${encodeURIComponent(msg)}`);
  });

  app.get<{ Params: { token: string } }>("/event-invite/:token", async (req, reply) => {
    const [tok] = await db.select().from(schema.eventInviteTokens).where(eq(schema.eventInviteTokens.token, req.params.token)).limit(1);
    if (!tok) {
      return reply.code(404).view("error", { title: "邀请无效", user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: "邀请链接无效", message: "请检查邮件里的链接是否完整。" });
    }
    if (tok.expiresAt < new Date()) {
      return reply.code(410).view("error", { title: "已过期", user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 410, heading: "邀请链接已过期", message: "请联系邀请人重新发送邀请。" });
    }
    const currentUser = await loadUserFromRequest(req);
    const [sourceEvent] = await db.select().from(schema.events).where(eq(schema.events.id, tok.sourceEventId)).limit(1);
    if (!sourceEvent) {
      return reply.code(404).view("error", { title: "事件不存在", user: currentUser, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: "原事件已被删除", message: "邀请人撤销了这次活动。" });
    }
    // Build Google Calendar pre-filled event URL (no login needed on Google's side).
    const fmtGcal = (d: Date) => sourceEvent.allDay
      ? d.toISOString().slice(0, 10).replace(/-/g, "")
      : d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const gcalParams = new URLSearchParams({
      action: "TEMPLATE",
      text: sourceEvent.summary,
      dates: `${fmtGcal(sourceEvent.startsAt)}/${fmtGcal(sourceEvent.endsAt)}`,
    });
    if (sourceEvent.description) gcalParams.set("details", sourceEvent.description);
    if (sourceEvent.location) gcalParams.set("location", sourceEvent.location);
    const myCals = currentUser ? await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, currentUser.id))
      .orderBy(asc(schema.calendars.name)) : [];
    return reply.view("invite/event-accept", {
      title: "添加到日历",
      user: currentUser,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      token: tok.token,
      recipientEmail: tok.recipientEmail,
      responseStatus: tok.responseStatus,
      sourceEvent: {
        ...sourceEvent,
        startsAtLocal: localTime(sourceEvent.startsAt, "Asia/Shanghai", sourceEvent.allDay ? "date" : "datetime"),
        endsAtLocal: localTime(sourceEvent.endsAt, "Asia/Shanghai", sourceEvent.allDay ? "date" : "datetime"),
        // The view checks this to render the "已取消" notice + hide RSVP/add-to-calendar.
        deletedAt: sourceEvent.deletedAt,
      },
      calendars: myCals,
      alreadyAccepted: !!tok.acceptedAt,
      googleCalendarUrl: `https://www.google.com/calendar/render?${gcalParams.toString()}`,
      icsDownloadUrl: `${baseUrl}/event-invite/${encodeURIComponent(tok.token)}.ics`,
    });
  });

  app.post<{ Params: { token: string } }>("/event-invite/:token/accept", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const [tok] = await db.select().from(schema.eventInviteTokens).where(eq(schema.eventInviteTokens.token, req.params.token)).limit(1);
    if (!tok || tok.expiresAt < new Date()) {
      return redirectWith(reply, `/event-invite/${encodeURIComponent(req.params.token)}`, { error: "邀请已失效" });
    }
    const body = z.object({ calendarId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/event-invite/${encodeURIComponent(req.params.token)}`, { error: "请选择要加入的日历" });
    }
    if (!(await ownsCalendar(body.data.calendarId, user.id))) {
      return redirectWith(reply, `/event-invite/${encodeURIComponent(req.params.token)}`, { error: "不能写入这本日历" });
    }
    const [sourceEvent] = await db.select().from(schema.events).where(eq(schema.events.id, tok.sourceEventId)).limit(1);
    if (!sourceEvent) {
      return redirectWith(reply, `/event-invite/${encodeURIComponent(req.params.token)}`, { error: "原事件已不存在" });
    }
    // Copy the event into the recipient's chosen calendar with a fresh UID so
    // it shows up as their own row. Owner edits to the source won't propagate;
    // for two-way sync the recipient should accept the calendar invitation.
    await db.insert(schema.events).values({
      calendarId: body.data.calendarId,
      uid: newEventUid(),
      summary: sourceEvent.summary,
      description: sourceEvent.description,
      location: sourceEvent.location,
      startsAt: sourceEvent.startsAt,
      endsAt: sourceEvent.endsAt,
      allDay: sourceEvent.allDay,
      rrule: sourceEvent.rrule,
      extra: { ...((sourceEvent.extra as Record<string, unknown> | null) ?? {}), importedFromInvite: tok.token },
    });
    await db.update(schema.eventInviteTokens).set({ acceptedAt: new Date() }).where(eq(schema.eventInviteTokens.token, tok.token));
    return redirectWith(reply, "/app", { success: `已添加 ${sourceEvent.summary} 到你的日历` });
  });

  app.get<{ Params: { token: string } }>("/invite/:token", async (req, reply) => {
    const [inv] = await db
      .select()
      .from(schema.calendarInvitations)
      .where(eq(schema.calendarInvitations.token, req.params.token))
      .limit(1);
    if (!inv) {
      return reply.code(404).view("error", {
        title: "邀请无效", user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 404, heading: "邀请链接无效或已撤销", message: "请联系邀请你的人重新发送。",
      });
    }
    if (inv.acceptedAt) {
      return reply.view("error", {
        title: "已接受", user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 200, heading: "这条邀请已被接受", message: "可以直接到日历中查看共享的内容。",
      });
    }
    if (inv.expiresAt < new Date()) {
      return reply.code(410).view("error", {
        title: "已过期", user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 410, heading: "邀请链接已过期", message: "邀请仅 7 天内有效。请联系邀请人重发。",
      });
    }
    const [cal] = await db.select().from(schema.calendars).where(eq(schema.calendars.id, inv.calendarId)).limit(1);
    // inv.invitedBy is now nullable (SET NULL FK) — if the inviter has been
    // deleted, skip the lookup and the template falls back to "未知".
    const inviter = inv.invitedBy
      ? (await db.select().from(schema.users).where(eq(schema.users.id, inv.invitedBy)).limit(1))[0]
      : null;
    const currentUser = await loadUserFromRequest(req);
    return reply.view("invite/accept", {
      title: "接受日历邀请",
      user: currentUser,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      invitation: { token: inv.token, email: inv.email, role: inv.role, message: inv.message },
      calendar: cal,
      inviterName: inviter ? (inviter.displayName || inviter.email) : "未知",
      emailMatches: currentUser ? currentUser.email === inv.email : false,
    });
  });

  app.post<{ Params: { token: string } }>("/invite/:token/accept", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const [inv] = await db
      .select()
      .from(schema.calendarInvitations)
      .where(eq(schema.calendarInvitations.token, req.params.token))
      .limit(1);
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) {
      return redirectWith(reply, `/invite/${req.params.token}`, { error: "邀请已失效" });
    }
    const user = await loadUserFromRequest(req);
    if (!user) {
      return redirectWith(reply, "/login", { error: `请先用 ${inv.email} 登录或注册以接受邀请` });
    }
    if (user.email !== inv.email) {
      return redirectWith(reply, `/invite/${req.params.token}`, {
        error: `这封邀请发给 ${inv.email}，请切换到该账号后再接受`,
      });
    }
    await db.insert(schema.calendarMembers).values({
      calendarId: inv.calendarId,
      userId: user.id,
      role: inv.role,
      invitedBy: inv.invitedBy,
    }).onConflictDoNothing();
    await db
      .update(schema.calendarInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(schema.calendarInvitations.token, inv.token));
    return redirectWith(reply, "/app", { success: "已加入日历，刷新后会出现在你的日历列表" });
  });

  // Re-issue a verification code for already-logged-in users who never
  // verified (created before email verification was enforced).
  app.post("/app/verify-email/send", {
    config: { rateLimit: { max: 3, timeWindow: "5 minute" } },
  }, async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    if (user.emailVerified) {
      return redirectWith(reply, "/app", { success: "邮箱已经是验证过的状态" });
    }
    // The verify-email flow expects a pending payload (passwordHash etc.) since
    // it was built for the register path; for already-existing users we just
    // mark verified after they enter the code, no user-creation step.
    const result = await issueCode(user.email, { passwordHash: user.passwordHash, displayName: user.displayName });
    if (!result.ok) {
      return redirectWith(reply, "/app", { error: "验证码发送失败，请稍后重试" });
    }
    reply.setCookie(PENDING_EMAIL_COOKIE, user.email, {
      httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/", maxAge: 15 * 60,
    });
    return redirectWith(reply, "/verify-email", { success: "验证码已发送到你的邮箱，输入后即可完成验证" });
  });

  app.get("/app/settings", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const passkeys = await db
      .select({
        id: schema.webauthnCredentials.id,
        deviceName: schema.webauthnCredentials.deviceName,
        createdAt: schema.webauthnCredentials.createdAt,
        lastUsedAt: schema.webauthnCredentials.lastUsedAt,
      })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, user.id))
      .orderBy(desc(schema.webauthnCredentials.createdAt));

    const apps = await listAppPasswords(user.id);
    // Login history moved to a dedicated /app/logins page — settings is
    // now leaner; the 资料 section links there.
    const q = (req.query ?? {}) as Record<string, unknown>;
    const newPlain = typeof q.newAppPassword === "string" ? q.newAppPassword : null;
    const newLabel = typeof q.newAppLabel === "string" ? q.newAppLabel : null;

    // CalDAV connection info — surface the URL + username so users don't
    // have to dig through docs to set up iPhone / macOS / Thunderbird.
    // We don't show the principal-href because RFC 6764 discovery resolves
    // it automatically from the base /caldav/ URL on every client we
    // care about (Apple Calendar, Thunderbird, DAVx5, Outlook).
    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const caldavBaseUrl = `${baseUrl}/caldav/`;

    // Surface the apps-enabled flag so the EJS can hide the
    // 「绑定新设备」 button + show a notice when the admin turned it off.
    const siteSettings = await getSettings();

    return reply.view("app/settings", {
      title: "设置",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      createdAtLocal: localTime(user.createdAt),
      userPalette: user.themePalette,
      userDensity: user.themeDensity,
      passkeys: passkeys.map((p) => ({
        ...p,
        createdAtLocal: localTime(p.createdAt),
        lastUsedAtLocal: p.lastUsedAt ? localTime(p.lastUsedAt) : null,
      })),
      appPasswords: apps.map((a) => ({
        ...a,
        createdAtLocal: localTime(a.createdAt),
        lastUsedAtLocal: a.lastUsedAt ? localTime(a.lastUsedAt) : null,
      })),
      newAppPassword: newPlain,
      newAppLabel: newLabel,
      caldavBaseUrl,
      appsEnabled: siteSettings.appsEnabled,
    });
  });

  // Login history as its own page. Shows more rows (100 vs 30 in the
  // old settings tab) since we're no longer crammed in alongside MFA
  // and Passkey config. Linked from /app/settings#profile and from
  // the security-alert email's "查看登录历史" button.
  // Full-page event search. /api/v1/search powers the Cmd+K palette; this
  // page wraps the same endpoint for cases where users want to scan more
  // than 10 results at a time (e.g. "where's that meeting from 3 months ago?").
  app.get("/app/search", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const q = (req.query as { q?: string })?.q ?? "";
    return reply.view("app/search", {
      title: "搜索事件",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      initialQuery: q,
    });
  });

  // Native APP "Sign in with browser" bridge. Used by iOS/Android/desktop
  // APPs to delegate login to the web flow — which covers passkey + MFA
  // + OIDC SSO without any new server endpoints.
  //
  // Flow:
  //   1. APP opens ASWebAuthenticationSession to this URL
  //   2. If not logged in → user gets the web login (any method)
  //   3. We mint a one-time pairing code bound to this user
  //   4. Redirect to bywave://auth/complete?code=<code>&state=<state>
  //   5. APP catches the redirect, exchanges code via existing
  //      /api/v1/devices/pair-claim → has refresh + access tokens
  //
  // The pairing code is short-lived (5 min) and single-use, identical to
  // the QR pairing flow — just kicked off automatically instead of
  // displayed as a QR. apps_enabled gate applies (admin can disable).
  app.get("/app/auth/native", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const q = z.object({
      // Opaque round-trip identifier the APP supplies so it can verify
      // the callback corresponds to its own request (anti-CSRF for the
      // URL scheme handoff). We just echo it back.
      state: z.string().min(1).max(200).optional(),
      // Custom URL scheme the APP wants the redirect to use. We only
      // honor `bywave://` (and `bywave-staging://` for dev builds);
      // anything else is rejected so this can't be turned into an open
      // redirect.
      scheme: z.string().regex(/^[a-z0-9-]{2,32}$/).optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send("bad_request");

    const settings = await getSettings();
    if (!settings.appsEnabled) {
      return reply.code(403).view("error", {
        title: "APP 已停用", user, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 403, heading: "管理员已停用 APP 同步",
        message: "请联系管理员重新启用，或在网页继续使用。",
      });
    }

    const scheme = q.data.scheme === "bywave-staging" ? "bywave-staging" : "bywave";
    // Reuse the existing pairing-code flow. The APP claims it via
    // /api/v1/devices/pair-claim (no need for a new endpoint).
    const { initPairing } = await import("../lib/devices.js");
    const { code } = await initPairing(user.id);

    const params = new URLSearchParams({ code });
    if (q.data.state) params.set("state", q.data.state);
    return reply.redirect(`${scheme}://auth/complete?${params.toString()}`);
  });

  // Companion to POST /api/v1/auth/web-session. The iOS APP opens this
  // URL inside SFSafariViewController; we consume the one-shot token,
  // create a real bwc_sid session cookie, and redirect to the requested
  // page. From the user's perspective: tap a settings row in the APP →
  // get dropped inside the web UI signed in.
  //
  // Token storage is in-memory (see src/routes/devices.ts). 5-minute TTL,
  // single-use. If validation fails we render the standard error page —
  // do NOT echo back the token in any output (logs go to pino; the URL
  // bar will still show it for a moment but it's already burned).
  app.get("/app/auth/from-native", async (req, reply) => {
    const q = z.object({
      token: z.string().min(32).max(64),
      next: z.string().min(1).max(200).optional(),
    }).safeParse(req.query);
    if (!q.success) {
      return reply.code(400).view("error", {
        title: "登录链接无效", user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 400, heading: "登录链接格式不对",
        message: "请回到 APP 重新生成链接（链接只能使用一次，且 5 分钟内有效）。",
      });
    }
    const { consumeWebSessionToken } = await import("../routes/devices.js");
    const userId = consumeWebSessionToken(q.data.token);
    if (!userId) {
      return reply.code(403).view("error", {
        title: "登录链接已过期", user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 403, heading: "登录链接已过期或已被使用",
        message: "请回到 APP 重新打开账号管理页。",
      });
    }
    const { createSession } = await import("../lib/session.js");
    await createSession(reply, userId, { mfaSatisfied: true });
    // Validate next — must be a relative /app/ path. The Zod regex on
    // the API side already enforces this, but defense-in-depth at the
    // consumer end too in case future callers forget.
    const next = (q.data.next && /^\/app(\/.*)?$/.test(q.data.next)) ? q.data.next : "/app/settings";
    return reply.redirect(next);
  });

  app.get("/app/logins", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const recentLogins = await listRecentLogins(user.id, 100);
    return reply.view("app/logins", {
      title: "登录历史",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      recentLogins: recentLogins.map((e) => ({
        ...e,
        createdAtLocal: localTime(e.createdAt),
      })),
    });
  });

  app.post("/app/settings/app-passwords", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({ label: z.string().min(1).max(60) })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/app/settings", { error: "请填写设备标签（最长 60 字）" });
    }
    const issued = await createAppPassword(user.id, body.data.label);
    const params = new URLSearchParams({
      success: "已生成新的 CalDAV 应用密码，仅显示一次，请立即保存到客户端。",
      newAppPassword: issued.plain,
      newAppLabel: body.data.label,
    });
    return reply.redirect(`/app/settings?${params.toString()}#app-passwords`);
  });

  app.post<{ Params: { id: string } }>("/app/settings/app-passwords/:id/revoke", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/app/settings");
    await revokeAppPassword(user.id, id.data);
    // Same TTL invalidation as password change — phone with the
    // revoked password should fail next sync, not 60s from now.
    invalidateCalDavAuthCache(user.id);
    return redirectWith(reply, "/app/settings", { success: "应用密码已撤销" });
  });

  app.post("/app/settings/theme", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({
        palette: z.string().optional(),
        density: z.string().optional(),
        reset: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/app/settings", { error: "无效的外观选项" });
    }
    if (body.data.reset) {
      await db.update(schema.users).set({ themePalette: null, themeDensity: null, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      clearThemeCookies(reply);
      return redirectWith(reply, "/app/settings", { success: "已恢复为站点默认外观" });
    }
    const palette = isValidPalette(body.data.palette) ? body.data.palette : null;
    const density = isValidDensity(body.data.density) ? body.data.density : null;
    await db.update(schema.users).set({ themePalette: palette, themeDensity: density, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    setThemeCookies(reply, palette, density);
    return redirectWith(reply, "/app/settings", { success: "外观已更新" });
  });

  app.post("/app/settings/delete-account", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      password: z.string().min(1),
      confirm: z.literal("删除我的账号"),
    }).safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/app/settings", { error: "请输入密码并精确输入「删除我的账号」以确认" });
    }
    // Verify password (SSO-only accounts can't self-delete this way; they
    // need to clear MFA / set a password first or contact admin).
    const ok = await verifyPassword(body.data.password, user.passwordHash);
    if (!ok) {
      return redirectWith(reply, "/app/settings", { error: "密码错误，账号未删除" });
    }
    // Last-admin guard: refuse self-delete if this would leave the system
    // with zero admins. Same footgun as toggle-admin / toggle-disabled —
    // recovery from zero-admins requires manual DB intervention.
    if (user.isAdmin) {
      const { countActiveAdmins } = await import("../lib/user_state.js");
      if ((await countActiveAdmins()) <= 1) {
        return redirectWith(reply, "/app/settings", { error: "你是唯一的管理员，无法删除自己。请先提升另一个用户为管理员。" });
      }
    }
    // Hard delete — FK cascades clean up calendars/events/sessions/etc.
    await destroyAllUserSessions(user.id);
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await destroySession(req, reply);
    return redirectWith(reply, "/", { success: "账号已永久删除。感谢你曾经使用 ByWave Calendar。" });
  });

  app.post("/app/settings/password", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/app/settings", { error: "新密码格式不正确" });
    }
    const policyErr = passwordPolicyError(body.data.newPassword);
    if (policyErr) {
      return redirectWith(reply, "/app/settings", { error: policyErr });
    }
    const ok = await verifyPassword(body.data.currentPassword, user.passwordHash);
    if (!ok) {
      return redirectWith(reply, "/app/settings", { error: "当前密码错误" });
    }
    const passwordHash = await hashPassword(body.data.newPassword);
    await db.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    void sendMail(securityChangeMail(user.email, { kind: "password_changed" }))
      .catch((err) => req.log.warn({ err }, "password_change_mail_failed"));
    // Invalidate all sessions including current; user must re-login
    await destroyAllUserSessions(user.id);
    // Drop any cached CalDAV auth tokens for this user — otherwise
    // their iPhone could keep syncing for up to 60s on the old password.
    invalidateCalDavAuthCache(user.id);
    await destroySession(req, reply);
    return redirectWith(reply, "/login", { success: "密码已更新，请重新登录" });
  });

  // -------- Booking links (Calendly-style) — management --------
  app.get("/app/booking-links", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const links = await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.userId, user.id)).orderBy(asc(schema.bookingLinks.title));
    const cals = await db.select({ id: schema.calendars.id, name: schema.calendars.name, color: schema.calendars.color }).from(schema.calendars).where(eq(schema.calendars.ownerId, user.id));
    return reply.view("app/booking-links", {
      title: "预约链接",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      links: links.map((l) => ({ ...l, publicUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/book/${user.id}/${l.slug}` })),
      calendars: cals,
      defaultAvailability: DEFAULT_AVAILABILITY,
    });
  });

  app.post("/app/booking-links", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "URL 标识只能 a-z 0-9 和 -"),
      title: z.string().min(1).max(120),
      description: z.string().max(2000).optional().transform((v) => v?.trim() || undefined),
      calendarId: z.string().uuid(),
      durationMinutes: z.coerce.number().int().min(5).max(480),
      minNoticeHours: z.coerce.number().int().min(0).max(720),
      maxDaysAhead: z.coerce.number().int().min(1).max(90),
      bufferBeforeMin: z.coerce.number().int().min(0).max(240).default(0),
      bufferAfterMin: z.coerce.number().int().min(0).max(240).default(0),
      // HTML checkbox sends "on" when checked, omits the key entirely
      // when unchecked. Map both to a boolean — default true so the
      // checkbox starts checked and unchecking it explicitly opts out.
      notifyEmail: z.union([z.literal("on"), z.literal("off"), z.undefined()])
        .transform((v) => v !== "off" && v !== undefined),
    }).safeParse(req.body);
    if (!body.success) return redirectWith(reply, "/app/booking-links", { error: "参数无效：" + (body.error.errors[0]?.message ?? "") });
    if (!(await ownsCalendar(body.data.calendarId, user.id))) {
      return redirectWith(reply, "/app/booking-links", { error: "目标日历不存在或不属于你" });
    }
    try {
      await db.insert(schema.bookingLinks).values({
        userId: user.id,
        slug: body.data.slug,
        calendarId: body.data.calendarId,
        title: body.data.title,
        description: body.data.description ?? null,
        durationMinutes: body.data.durationMinutes,
        weeklyAvailability: DEFAULT_AVAILABILITY,
        minNoticeHours: body.data.minNoticeHours,
        maxDaysAhead: body.data.maxDaysAhead,
        bufferBeforeMin: body.data.bufferBeforeMin,
        bufferAfterMin: body.data.bufferAfterMin,
        notifyEmail: body.data.notifyEmail,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      return redirectWith(reply, "/app/booking-links", { error: msg.includes("duplicate") ? "slug 已存在" : msg });
    }
    return redirectWith(reply, "/app/booking-links", { success: "预约链接已创建" });
  });

  app.post<{ Params: { id: string } }>("/app/booking-links/:id/toggle", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/app/booking-links");
    const [link] = await db.select().from(schema.bookingLinks).where(and(eq(schema.bookingLinks.id, id.data), eq(schema.bookingLinks.userId, user.id))).limit(1);
    if (!link) return reply.redirect("/app/booking-links");
    await db.update(schema.bookingLinks).set({ enabled: !link.enabled, updatedAt: new Date() }).where(eq(schema.bookingLinks.id, id.data));
    return redirectWith(reply, "/app/booking-links", { success: link.enabled ? "已暂停" : "已启用" });
  });

  app.post<{ Params: { id: string } }>("/app/booking-links/:id/delete", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/app/booking-links");
    await db.delete(schema.bookingLinks).where(and(eq(schema.bookingLinks.id, id.data), eq(schema.bookingLinks.userId, user.id)));
    return redirectWith(reply, "/app/booking-links", { success: "已删除" });
  });

  // Toggle whether the owner receives an email when someone books a
  // slot. Separate from /toggle (which turns the whole link on/off)
  // because users want fine control — "link is live AND I don't need
  // an email for every booking" is a common case.
  app.post<{ Params: { id: string } }>("/app/booking-links/:id/toggle-notify", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/app/booking-links");
    const [link] = await db.select().from(schema.bookingLinks)
      .where(and(eq(schema.bookingLinks.id, id.data), eq(schema.bookingLinks.userId, user.id)))
      .limit(1);
    if (!link) return reply.redirect("/app/booking-links");
    await db.update(schema.bookingLinks)
      .set({ notifyEmail: !link.notifyEmail, updatedAt: new Date() })
      .where(eq(schema.bookingLinks.id, id.data));
    return redirectWith(reply, "/app/booking-links", {
      success: link.notifyEmail ? "已关闭邮件通知" : "已开启邮件通知",
    });
  });

  // -------- Public booking pages --------
  app.get<{ Params: { userId: string; slug: string } }>("/book/:userId/:slug", async (req, reply) => {
    const userId = z.string().uuid().safeParse(req.params.userId);
    if (!userId.success) return reply.code(404).view("error", { title: "找不到", user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: "预约链接不存在", message: "请检查链接是否正确。" });
    const link = await findLinkBySlug(userId.data, req.params.slug);
    if (!link || !link.enabled) {
      return reply.code(404).view("error", { title: "找不到", user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: "预约链接不存在或已停用", message: "请联系发布方获取新链接。" });
    }
    const [owner] = await db.select({ email: schema.users.email, displayName: schema.users.displayName, disabledAt: schema.users.disabledAt }).from(schema.users).where(eq(schema.users.id, link.userId)).limit(1);
    if (!owner) return reply.code(404).type("text/plain").send("Not Found");
    // Disabled-account gate: don't accept bookings for a user the admin
    // has disabled — to the public the link should look exactly like
    // "not found" / "disabled link" so we don't leak account status.
    if (owner.disabledAt) {
      return reply.code(404).view("error", { title: "找不到", user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: "预约链接不存在或已停用", message: "请联系发布方获取新链接。" });
    }
    const slots = await availableSlots(link, new Date(), link.maxDaysAhead);
    // Group slots by date string for the picker.
    const byDate = new Map<string, { startsAt: Date; endsAt: Date }[]>();
    for (const s of slots) {
      const key = s.startsAt.toISOString().slice(0, 10);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key)!.push(s);
    }
    return reply.view("booking/public", {
      title: link.title,
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      link,
      owner,
      slotsByDate: Array.from(byDate.entries()).map(([date, slots]) => ({ date, slots })),
    });
  });

  app.post<{ Params: { userId: string; slug: string } }>("/book/:userId/:slug", {
    config: { rateLimit: { max: 10, timeWindow: "10 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const userId = z.string().uuid().safeParse(req.params.userId);
    if (!userId.success) return reply.redirect("/");
    const link = await findLinkBySlug(userId.data, req.params.slug);
    if (!link || !link.enabled) return redirectWith(reply, `/book/${userId.data}/${req.params.slug}`, { error: "链接已停用" });
    // Disabled-account gate: stop the booking before we INSERT an event
    // into the disabled user's calendar.
    const [ownerCheck] = await db.select({ disabledAt: schema.users.disabledAt }).from(schema.users).where(eq(schema.users.id, link.userId)).limit(1);
    if (!ownerCheck || ownerCheck.disabledAt) return redirectWith(reply, `/book/${userId.data}/${req.params.slug}`, { error: "链接已停用" });
    const body = z.object({
      startsAt: z.string().datetime({ offset: true }),
      guestEmail: z.string().email().max(254),
      guestName: z.string().min(1).max(100),
      guestMessage: z.string().max(2000).optional(),
    }).safeParse(req.body);
    if (!body.success) return redirectWith(reply, `/book/${userId.data}/${req.params.slug}`, { error: "请填写邮箱和姓名" });
    const startsAt = new Date(body.data.startsAt);
    const endsAt = new Date(startsAt.getTime() + link.durationMinutes * 60_000);
    try {
      const { booking } = await bookSlot({ link, startsAt, endsAt, guestEmail: body.data.guestEmail, guestName: body.data.guestName, guestMessage: body.data.guestMessage });
      // Confirmation emails (don't fail the booking if mail breaks).
      const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, link.userId)).limit(1);
      const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
      const cancelUrl = `${baseUrl}/book-cancel/${encodeURIComponent(booking.cancelToken)}`;
      const fmt = (d: Date) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
      const lines = `${link.title}\n时间：${fmt(startsAt)} — ${fmt(endsAt)}\n${body.data.guestMessage ? "\n留言：" + body.data.guestMessage + "\n" : ""}\n取消链接：${cancelUrl}`;
      sendMail({
        to: body.data.guestEmail,
        subject: `✓ 预约确认：${link.title}`,
        text: `你的预约已确认。\n\n${lines}`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:auto;padding:24px;background:#f1f5f9;"><div style="background:#fff;border-radius:16px;padding:24px;"><h1 style="font-size:22px;color:#0f172a;margin:0 0 12px;">✓ 预约已确认</h1><p style="font-size:15px;color:#0f172a;font-weight:600;margin:0 0 6px;">${link.title}</p><p style="font-size:14px;color:#475569;margin:0 0 14px;">与 ${(owner?.displayName || owner?.email || "").replace(/[<>&]/g, "")} 的预约</p><div style="background:#f8fafc;border-left:3px solid #6366f1;padding:12px 14px;border-radius:6px;font-size:14px;color:#334155;">📅 ${fmt(startsAt)} — ${fmt(endsAt)}</div>${body.data.guestMessage ? `<div style="margin-top:12px;padding:12px;background:#f8fafc;border-radius:6px;color:#475569;font-size:13px;">${body.data.guestMessage.replace(/[<>&]/g, "")}</div>` : ""}<p style="margin:16px 0 6px;font-size:13px;color:#64748b;">需要取消？<a href="${cancelUrl}" style="color:#dc2626;">点这里</a>。</p></div></div>`,
      }).catch(() => undefined);
      // Guest's confirmation email above is unconditional — they need
      // the cancel link. The OWNER notification respects link.notifyEmail
      // (opt-out toggle, default on). Lets the owner avoid inbox noise
      // for high-traffic links while still letting guests get their copy.
      if (owner && link.notifyEmail) {
        sendMail({
          to: owner.email,
          subject: `📅 新预约：${body.data.guestName} — ${link.title}`,
          text: `新预约：${body.data.guestName} <${body.data.guestEmail}>\n${lines}`,
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:auto;padding:24px;background:#f1f5f9;"><div style="background:#fff;border-radius:16px;padding:24px;"><h1 style="font-size:22px;color:#0f172a;margin:0 0 12px;">📅 新预约</h1><p style="font-size:14px;color:#475569;margin:0 0 14px;"><strong>${body.data.guestName.replace(/[<>&]/g, "")}</strong> &lt;${body.data.guestEmail.replace(/[<>&]/g, "")}&gt; 通过<strong>${link.title}</strong>预约了你的时间</p><div style="background:#f8fafc;border-left:3px solid #6366f1;padding:12px 14px;border-radius:6px;font-size:14px;color:#334155;">📅 ${fmt(startsAt)} — ${fmt(endsAt)}</div>${body.data.guestMessage ? `<div style="margin-top:12px;padding:12px;background:#f8fafc;border-radius:6px;color:#475569;font-size:13px;white-space:pre-wrap;">${body.data.guestMessage.replace(/[<>&]/g, "")}</div>` : ""}</div></div>`,
        }).catch(() => undefined);
      }
      return reply.redirect(`/book/${userId.data}/${req.params.slug}?success=${encodeURIComponent("预约成功！确认邮件已发到你的邮箱。")}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "预约失败";
      return redirectWith(reply, `/book/${userId.data}/${req.params.slug}`, { error: msg });
    }
  });

  app.get<{ Params: { token: string } }>("/book-cancel/:token", async (req, reply) => {
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.cancelToken, req.params.token)).limit(1);
    if (!b) return reply.code(404).view("error", { title: "找不到", user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: "取消链接无效", message: "请检查邮件里的链接。" });
    return reply.view("booking/cancel", {
      title: "取消预约",
      user: null, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      booking: b,
    });
  });

  app.post<{ Params: { token: string } }>("/book-cancel/:token", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.cancelToken, req.params.token)).limit(1);
    if (!b) return reply.redirect("/");
    if (b.cancelledAt) return redirectWith(reply, `/book-cancel/${req.params.token}`, { success: "这个预约已经取消过了" });
    // Mark booking + soft-delete the underlying event.
    await db.update(schema.bookings).set({ cancelledAt: new Date() }).where(eq(schema.bookings.id, b.id));
    if (b.eventId) {
      const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, b.eventId)).limit(1);
      if (ev && !ev.deletedAt) {
        const [link] = await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.id, b.linkId)).limit(1);
        if (link) {
          const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, link.userId)).limit(1);
          if (owner) {
            await cancelEvent(ev.id, { id: owner.id, email: owner.email, displayName: owner.displayName });
          }
        }
      }
    }
    return redirectWith(reply, `/book-cancel/${req.params.token}`, { success: "预约已取消" });
  });
}
