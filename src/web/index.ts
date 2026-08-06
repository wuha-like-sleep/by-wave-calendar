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
import { issueCode, verifyCode, type PendingRegistration } from "../lib/email_verification.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";
import { getSettings, getCaptchaConfig } from "../lib/site_settings.js";
import { resolveLocaleFromRequest, makeT, clientStrings, tForRequest } from "../lib/i18n.js";
import { getClientRender, verifyCaptcha } from "../lib/captcha/index.js";
import { validateInvite, consumeInvite, type InviteValidation } from "../lib/signup_invite.js";
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

/** Request-scoped translate for route handlers — page titles, flash
 *  messages, error-view copy. Locale comes from `req.locale`, stashed by the
 *  view-locals hook in src/server.ts, so this matches whatever the template
 *  side of the same request renders. See tForRequest in src/lib/i18n.ts. */
function tr(req: FastifyRequest, key: string, vars?: Record<string, string | number>): string {
  return tForRequest(req)(key, vars);
}

/** User-facing message for a failed invite validation (never leaks token internals). */
function inviteErrorMsg(req: FastifyRequest, reason: Exclude<InviteValidation, { ok: true }>["reason"]): string {
  switch (reason) {
    case "revoked": return tr(req, "flash.invite.revoked");
    case "expired": return tr(req, "flash.invite.expired");
    case "exhausted": return tr(req, "flash.invite.exhausted");
    case "email_mismatch": return tr(req, "flash.invite.emailMismatch");
    case "not_found":
    default: return tr(req, "flash.invite.invalid");
  }
}

// Round-trip cookie for "send the user back to the page they tried to
// open before being bounced to /login." Lifetime is 15 min — long enough
// for password + MFA + risk-challenge but short enough that a stale
// value can't outlive the login session it belongs to.
const RETURN_TO_COOKIE = "bwc_return_to";
const RETURN_TO_TTL_S = 15 * 60;

/**
 * Validate an absolute path before redirecting to it. Defends against:
 *   - Open redirects to other domains  (//evil.com, https://evil.com)
 *   - Backslash tricks                  (/\\evil.com)
 *   - Arbitrary protocol schemes        (javascript:alert(1))
 *   - Overly long values                (DOS the cookie store)
 *
 * Only paths under our known authenticated surface area are allowed:
 * /app, /admin, /web-pair, /desktop-pair. Everything else (including
 * unsanitized inputs and external URLs) returns null and the caller
 * falls back to /app.
 */
export function sanitizeReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > 200) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Match the path prefix only; query string + fragment are allowed after.
  if (!/^\/(app|admin|web-pair|desktop-pair)(\/|$|\?|#)/.test(raw)) return null;
  // Strip fragment — we re-add on the client side anyway. Server-side
  // redirects don't carry fragments.
  return raw.split("#")[0] ?? null;
}

/** The path the unauth'd request was trying to reach. Used by the
 *  auth-gate helpers below to populate bwc_return_to before bouncing
 *  to /login. */
function currentPathFor(req: FastifyRequest): string | null {
  return sanitizeReturnTo(req.raw.url ?? "");
}

/** Persist the return-to in a signed cookie + redirect to /login. The
 *  cookie is read back at the end of the auth flow (password,
 *  challenge, MFA, Passkey, or SSO) and the user lands on the page
 *  they originally tried to reach. */
function bounceToLogin(req: FastifyRequest, reply: FastifyReply, flash?: Flash): null {
  const back = currentPathFor(req);
  if (back) {
    reply.setCookie(RETURN_TO_COOKIE, back, {
      httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production",
      path: "/", maxAge: RETURN_TO_TTL_S, signed: true,
    });
  }
  redirectWith(reply, "/login", flash ?? { error: tr(req, "flash.auth.signInFirst") });
  return null;
}

/** Read + clear the return-to cookie. Returns a sanitized path or null.
 *  Call at the end of any successful login path; the redirect target is
 *  the returned value or "/app" if absent. */
function consumeReturnTo(req: FastifyRequest, reply: FastifyReply): string | null {
  const raw = req.cookies[RETURN_TO_COOKIE];
  reply.clearCookie(RETURN_TO_COOKIE, { path: "/" });
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return sanitizeReturnTo(unsigned.value);
}

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
  if (!qs) return reply.redirect(path);
  // Use & when the path already carries a query string (e.g. /register?invite=…).
  const sep = path.includes("?") ? "&" : "?";
  return reply.redirect(`${path}${sep}${qs}`);
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
    // Stash the page they were trying to reach so they bounce back
    // here after re-auth (return_to cookie, signed, 15min TTL).
    return bounceToLogin(req, reply);
  }
  if (s.user.mfaEnabled && !s.mfaSatisfied) {
    // MFA-pending session — capture return_to too so the post-MFA
    // landing matches the page they were trying to open.
    const back = currentPathFor(req);
    if (back) {
      reply.setCookie(RETURN_TO_COOKIE, back, {
        httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production",
        path: "/", maxAge: RETURN_TO_TTL_S, signed: true,
      });
    }
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
      title: tr(req, "page.home"),
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
    });
  });

  app.get("/about", async (req, reply) => {
    return reply.view("landing", {
      title: tr(req, "page.about"),
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
  // Legal/policy pages are localized into all 8 locales via per-locale content
  // views at legal/content/<page>/<locale>.ejs. The effective locale honors
  // ?lang= (so the native apps open these in the app's language), then cookie /
  // user / site default / Accept-Language. updatedDate tracks the release date.
  const LEGAL_UPDATED = "2026-05-31";
  async function renderLegal(req: FastifyRequest, reply: FastifyReply, page: string, titleKey: string) {
    const settings = await getSettings();
    const user = await loadUserFromRequest(req);
    const locale = resolveLocaleFromRequest(req, user?.locale ?? null, settings.defaultLocale);
    return reply.view(`legal/content/${page}/${locale}`, {
      title: makeT(locale)(titleKey),
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      siteName: settings.siteName || "ByWave Calendar",
      updatedDate: LEGAL_UPDATED,
    });
  }

  app.get("/privacy", (req, reply) => renderLegal(req, reply, "privacy", "legal.privacy.title"));

  // Data Processing Policy — companion to /privacy, structured around
  // what we process, why, retention, security, sub-processors, and
  // cross-border. Linked from the footer + /privacy + /terms.
  app.get("/data-processing", (req, reply) => renderLegal(req, reply, "data-processing", "legal.dataProcessing.title"));

  app.get("/terms", (req, reply) => renderLegal(req, reply, "terms", "legal.terms.title"));

  // Open Source Licenses — per-platform inventory of the third-party
  // components shipped in the server/web, iOS, Android, and desktop
  // builds. Linked from the footer alongside the other legal pages.
  app.get("/open-source", (req, reply) => renderLegal(req, reply, "open-source", "legal.openSource.title"));

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

    // Desktop release (DMG / MSI / DEB). Per-asset, prefer the manifest's
    // `downloadUrl` (typically a GitHub Releases asset) so users get the
    // canonical, world-mirrored binary; fall back to server-hosted
    // /downloads/desktop/<filename> when the manifest only supplies a
    // filename (self-hoster mode). Manifest is optional; absence renders
    // "coming soon" placeholders.
    const { getLatestRelease: getDesktopRelease } = await import("../lib/desktop_release.js");
    const desktop = await getDesktopRelease();
    const fmtSize = (n?: number) => n && n > 0 ? `${(n / 1024 / 1024).toFixed(1)} MB` : "";
    const assetUrl = (a?: { downloadUrl: string; filename: string }) => {
      if (!a) return "";
      if (a.downloadUrl) return a.downloadUrl;
      return a.filename ? `/downloads/desktop/${encodeURIComponent(a.filename)}` : "";
    };
    const desktopMacUrl = assetUrl(desktop?.assets.mac);
    const desktopWinUrl = assetUrl(desktop?.assets.win);
    const desktopLinuxUrl = assetUrl(desktop?.assets.linux);
    return reply.view("download", {
      title: tr(req, "page.download"),
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
      iosEtaWeek: tr(req, "download.eta.thisWeek"),
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
      androidEtaWeek: tr(req, "download.eta.thisMonth"),
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
      desktopGitHub: "https://github.com/wuha-like-sleep/by-wave-calendar/releases",
      desktopGitee: "https://gitee.com/zhaorunsen/by-wave-calendar/releases",
      desktopEtaWeek: tr(req, "download.eta.thisMonth"),
    });
  });

  // Public-facing support / help page. Required for App Store
  // submission — Apple wants a working Support URL that doesn't 404
  // and lets users contact us without an account. Also linked from
  // the site footer alongside /privacy and /terms.
  app.get("/support", (req, reply) => renderLegal(req, reply, "support", "legal.support.title"));

  // -------- Auth pages --------
  // -------- Anonymous language switcher --------
  // Used by the 🌐 picker on /login (visitors who haven't signed in).
  // Logged-in users have a separate, persistent endpoint at
  // /app/settings/locale that also writes to user.locale.
  // CSRF protected to prevent a malicious page from setting the cookie
  // for our domain via a hidden form post.
  app.post("/locale", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const { isValidLocale, LOCALE_COOKIE, LOCALE_COOKIE_TTL_S } = await import("../lib/i18n.js");
    const body = z.object({
      locale: z.string().max(20),
      return_to: z.string().max(200).optional(),
    }).safeParse(req.body);
    if (!body.success || !isValidLocale(body.data.locale)) {
      return reply.redirect("/login");
    }
    reply.setCookie(LOCALE_COOKIE, body.data.locale, {
      httpOnly: false, sameSite: "lax", secure: env.NODE_ENV === "production",
      path: "/", maxAge: LOCALE_COOKIE_TTL_S,
    });
    // Bounce back to the page they switched language on. sanitizeReturnTo
    // only allows same-origin internal paths (no open redirect); falls back
    // to /app (which itself bounces unauth'd users to /login).
    const r = sanitizeReturnTo(body.data.return_to);
    return reply.redirect(r ?? "/app");
  });

  app.get("/login", async (req, reply) => {
    const user = await loadUserFromRequest(req);
    if (user) {
      // Already logged in — if they got here via /login?return_to=...
      // honor the redirect so 「打开链接 → 登录 → 跳回」flows for
      // already-signed-in users still work.
      const q = (req.query ?? {}) as { return_to?: unknown };
      const r = sanitizeReturnTo(q.return_to);
      return reply.redirect(r ?? "/app");
    }
    // If /login was opened with an explicit `?return_to=...` (e.g. a
    // shared link to a private page that requires auth, or the QR-pair
    // approve page redirecting unauth'd users) — promote that into the
    // signed cookie so the POST handler picks it up just like the
    // loadAuthedUser → bounceToLogin path does.
    {
      const q = (req.query ?? {}) as { return_to?: unknown };
      const r = sanitizeReturnTo(q.return_to);
      if (r) {
        reply.setCookie(RETURN_TO_COOKIE, r, {
          httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production",
          path: "/", maxAge: RETURN_TO_TTL_S, signed: true,
        });
      }
    }
    // QR scan-login requires BOTH the master APP feature AND the
    // qrLoginEnabled toggle. Render-time check keeps the tab hidden
    // when admin disabled it — better UX than letting the user click
    // and get a 403. Server still gates the endpoints in case someone
    // hand-crafts a request.
    const settings = await getSettings();
    return reply.view("auth/login", {
      title: tr(req, "login.title"),
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      form: {},
      qrLoginEnabled: settings.appsEnabled && settings.qrLoginEnabled,
      registrationMode: settings.registrationMode,
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
        // "记住我" checkbox. Browsers submit the literal "on" when a
        // checkbox is checked; omit the field entirely when not. So
        // anything other than "on" means transient (one-time) session.
        remember: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/login", { error: tr(req, "flash.login.badFormat") });
    }
    const rememberMe = body.data.remember === "on";
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, body.data.email)).limit(1);
    if (!user) {
      // Burn the same ~250ms of CPU as a real bcrypt verify so the
      // no-such-user path is time-indistinguishable from the wrong-
      // password path. Without this, an attacker can enumerate
      // registered emails by measuring response time.
      await verifyPasswordTimingSafe(body.data.password);
      req.log.warn({ email: body.data.email, ip: req.ip }, "login_failed_no_user");
      return redirectWith(reply, "/login", { error: tr(req, "flash.login.badCredentials") });
    }
    if (user.disabledAt) {
      req.log.warn({ userId: user.id, email: user.email, ip: req.ip }, "login_blocked_disabled");
      return redirectWith(reply, "/login", { error: tr(req, "flash.login.accountDisabled") });
    }
    if (isLocked(user)) {
      const mins = lockedRemainingMinutes(user);
      return redirectWith(reply, "/login", { error: tr(req, "flash.login.lockedMinutes", { minutes: mins }) });
    }
    if (!(await verifyPassword(body.data.password, user.passwordHash))) {
      await recordFailedLogin(user);
      req.log.warn({ userId: user.id, email: body.data.email, ip: req.ip }, "login_failed");
      return redirectWith(reply, "/login", { error: tr(req, "flash.login.badCredentials") });
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
        return redirectWith(reply, "/login", { error: tr(req, "flash.login.challengeMailFailed") });
      }
      reply.setCookie("bwc_login_chall", issued.token, {
        httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/", maxAge: 10 * 60,
      });
      // Carry the 「记住我」 choice through the challenge → create-session
      // hop. Stored as a tiny separate cookie so the challenge token's
      // server-side row stays unchanged. 10-min lifetime matches the
      // challenge code; cleared in /login/challenge POST below.
      if (rememberMe) {
        reply.setCookie("bwc_login_remember", "1", {
          httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/", maxAge: 10 * 60,
        });
      }
      return reply.redirect("/login/challenge");
    }

    await createSession(reply, user.id, { mfaSatisfied: !user.mfaEnabled, rememberMe });
    setThemeCookies(reply, user.themePalette, user.themeDensity);
    if (user.mfaEnabled) return reply.redirect("/login/mfa");
    void notifyLoginSuccess(req, user, "password").catch((err) => req.log.warn({ err }, "login_alert_failed"));
    void recordLoginEvent(req, user.id, "password").catch((err) => req.log.warn({ err }, "login_event_failed"));
    // 返回到失效前的页面 —— bwc_return_to 是登录前由 loadAuthedUser
    // 写入的。如果没有就回到 /app。
    return reply.redirect(consumeReturnTo(req, reply) ?? "/app");
  });

  // -------- Login challenge (new-device email code) --------
  app.get("/login/challenge", async (req, reply) => {
    const token = req.cookies["bwc_login_chall"];
    if (!token) return reply.redirect("/login");
    return reply.view("auth/login-challenge", {
      title: tr(req, "page.securityCheck"),
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      bareLayout: true, // single-purpose: enter the device verification code, nothing else
    });
  });

  app.post("/login/challenge", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const token = req.cookies["bwc_login_chall"];
    if (!token) return reply.redirect("/login");
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return redirectWith(reply, "/login/challenge", { error: tr(req, "flash.code.sixDigits") });
    const result = await verifyLoginChallenge(token, body.data.code);
    if (!result.ok) {
      const msg: Record<string, string> = {
        no_challenge: tr(req, "flash.challenge.noChallenge"),
        expired: tr(req, "flash.challenge.expired"),
        too_many_attempts: tr(req, "flash.challenge.tooManyAttempts"),
        wrong: tr(req, "flash.code.wrong"),
      };
      if (result.reason !== "wrong") reply.clearCookie("bwc_login_chall", { path: "/" });
      return redirectWith(reply, result.reason === "wrong" ? "/login/challenge" : "/login", {
        error: msg[result.reason] ?? tr(req, "flash.code.verifyFailed"),
      });
    }
    reply.clearCookie("bwc_login_chall", { path: "/" });
    // Pick up the「记住我」choice the user made on /login (stashed in
    // a parallel cookie before the redirect to challenge). Clear it
    // either way so the next login session starts fresh.
    const rememberMe = req.cookies["bwc_login_remember"] === "1";
    reply.clearCookie("bwc_login_remember", { path: "/" });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, result.userId)).limit(1);
    if (!user) return redirectWith(reply, "/login", { error: tr(req, "flash.login.userNotFound") });
    await createSession(reply, user.id, { mfaSatisfied: !user.mfaEnabled, rememberMe });
    setThemeCookies(reply, user.themePalette, user.themeDensity);
    if (user.mfaEnabled) return reply.redirect("/login/mfa");
    void notifyLoginSuccess(req, user, "password").catch((err) => req.log.warn({ err }, "login_alert_failed"));
    void recordLoginEvent(req, user.id, "password").catch((err) => req.log.warn({ err }, "login_event_failed"));
    return reply.redirect(consumeReturnTo(req, reply) ?? "/app");
  });

  // -------- Forgot / reset password --------
  app.get("/forgot-password", async (req, reply) => {
    return reply.view("auth/forgot-password", {
      title: tr(req, "page.forgotPassword"),
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
    const generic = tr(req, "flash.forgotPassword.generic");
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
        title: tr(req, "page.linkInvalid"),
        user: null,
        csrfToken: csrfTokenFor(req),
        flash: {},
        statusCode: 400,
        heading: tr(req, "errorPage.resetLink.heading"),
        message: tr(req, "errorPage.resetLink.message"),
      });
    }
    return reply.view("auth/reset-password", {
      title: tr(req, "resetPassword.title"),
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      token,
      // Single-purpose page: render bare chrome (no nav / footer / palette) so
      // the only thing reachable from a reset link is setting a new password —
      // even if the browser happens to be logged into an account.
      bareLayout: true,
    });
  });

  app.post<{ Params: { token: string } }>("/reset-password/:token", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const token = req.params.token;
    const reset = await loadValidReset(token);
    if (!reset) {
      return redirectWith(reply, "/forgot-password", { error: tr(req, "flash.resetPassword.linkInvalid") });
    }
    const body = z
      .object({
        password: z.string().min(8).max(200),
        confirm: z.string().min(1).max(200),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/reset-password/${encodeURIComponent(token)}`, { error: tr(req, "flash.resetPassword.tooShort") });
    }
    if (body.data.password !== body.data.confirm) {
      return redirectWith(reply, `/reset-password/${encodeURIComponent(token)}`, { error: tr(req, "flash.resetPassword.mismatch") });
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
    return redirectWith(reply, "/login", { success: tr(req, "flash.resetPassword.success") });
  });

  app.get("/register", async (req, reply) => {
    const settings = await getSettings();
    if (settings.registrationMode === "closed") {
      return reply.code(403).view("error", {
        title: tr(req, "page.registrationClosed"),
        user: null,
        csrfToken: csrfTokenFor(req),
        flash: {},
        statusCode: 403,
        heading: tr(req, "errorPage.registrationClosed.heading"),
        message: tr(req, "errorPage.registrationClosed.message"),
      });
    }
    let inviteToken: string | null = null;
    if (settings.registrationMode === "invite") {
      const q = z.object({ invite: z.string().max(128).optional() }).safeParse(req.query);
      const token = q.success ? q.data.invite : undefined;
      const v = await validateInvite(token);
      if (!v.ok) {
        // No token, or an invalid/expired/used one → don't render the form.
        return reply.code(403).view("error", {
          title: tr(req, "page.inviteOnly"),
          user: null,
          csrfToken: csrfTokenFor(req),
          flash: {},
          statusCode: 403,
          heading: tr(req, "errorPage.inviteOnly.heading"),
          message: token ? inviteErrorMsg(req, v.reason) : tr(req, "errorPage.inviteOnly.message"),
        });
      }
      inviteToken = token!;
    }
    const user = await loadUserFromRequest(req);
    if (user) return reply.redirect("/app");
    const inviteForValidation = inviteToken ? await validateInvite(inviteToken) : null;
    return reply.view("auth/register", {
      title: tr(req, "register.title"),
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      form: { email: inviteForValidation?.ok ? (inviteForValidation.invite.email ?? "") : "" },
      captcha: getClientRender(await getCaptchaConfig()),
      inviteToken,
      inviteEmailLocked: !!(inviteForValidation?.ok && inviteForValidation.invite.email),
    });
  });

  app.post("/register", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const settings = await getSettings();
    if (settings.registrationMode === "closed") {
      return redirectWith(reply, "/login", { error: tr(req, "flash.register.closed") });
    }
    const body = z
      .object({
        email: z.string().email().max(254),
        password: z.string().min(8).max(200),
        displayName: z.string().max(100).optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
        // honeypot field — must be empty
        company: z.string().max(0).optional(),
        // mandatory「同意条款」checkbox (browsers send "on" when checked)
        agreeTerms: z.string().optional(),
        // invite-mode registration token (carried by the hidden field)
        invite: z.string().max(128).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/register", { error: tr(req, "flash.login.badFormat") });
    }
    // The page this request came from (so error redirects keep the invite token).
    const registerBackUrl = body.data.invite
      ? `/register?invite=${encodeURIComponent(body.data.invite)}`
      : "/register";
    // Must agree to the Terms + Privacy Policy to register.
    if (body.data.agreeTerms !== "on") {
      return redirectWith(reply, registerBackUrl, { error: tr(req, "flash.register.mustAgree") });
    }
    // Cheap, recoverable input checks FIRST — they must not consume the
    // single-use captcha. The captcha is verified last (just below), right
    // before the expensive bcrypt + email send.
    const policyErr = passwordPolicyError(body.data.password);
    if (policyErr) {
      return redirectWith(reply, registerBackUrl, { error: policyErr });
    }
    const email = body.data.email.toLowerCase().trim();
    // Invite-mode gate: a valid (non-consumed) invite is required. We validate
    // here but only CONSUME it after email verification succeeds, so abandoned
    // registrations don't burn a single-use invite.
    let inviteToken: string | null = null;
    if (settings.registrationMode === "invite") {
      const v = await validateInvite(body.data.invite, email);
      if (!v.ok) {
        return redirectWith(reply, registerBackUrl, { error: inviteErrorMsg(req, v.reason) });
      }
      inviteToken = body.data.invite!;
    }
    const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (existing.length > 0) {
      return redirectWith(reply, registerBackUrl, { error: tr(req, "flash.register.emailTaken") });
    }
    // Human verification — pluggable provider. Verified LAST, after the cheap
    // recoverable checks above, so a weak password / duplicate email doesn't
    // burn the single-use captcha; and BEFORE the expensive bcrypt hash + email
    // send below, so a bot can't trigger those without passing it. verifyCaptcha
    // reads the captcha fields straight out of req.body by name and never throws.
    const captchaResult = await verifyCaptcha(
      await getCaptchaConfig(),
      req.body as Record<string, string | undefined>,
      req.ip,
    );
    if (!captchaResult.ok) {
      req.log.warn({ reason: captchaResult.reason }, "register_captcha_failed");
      return redirectWith(reply, registerBackUrl, { error: tr(req, "flash.register.captchaFailed") });
    }
    const passwordHash = await hashPassword(body.data.password);

    const result = await issueCode(email, { passwordHash, displayName: body.data.displayName ?? null, inviteToken });
    if (!result.ok) {
      return redirectWith(reply, registerBackUrl, { error: tr(req, "flash.register.codeSendFailed") });
    }

    reply.setCookie(PENDING_EMAIL_COOKIE, email, {
      httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/", maxAge: 15 * 60,
    });

    // If mailer is disabled in dev, the code was returned so we can log it.
    if (result.code && env.NODE_ENV === "development") {
      req.log.info(`[dev] verification code for ${email} = ${result.code}`);
    }

    return redirectWith(reply, "/verify-email", { success: tr(req, "flash.register.codeSent") });
  });

  app.get("/verify-email", async (req, reply) => {
    const email = req.cookies[PENDING_EMAIL_COOKIE];
    if (!email) return reply.redirect("/register");
    return reply.view("auth/verify-email", {
      title: tr(req, "page.verifyEmail"),
      user: null,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      email,
      mailerEnabled: await isMailerEnabled(),
      bareLayout: true, // single-purpose: enter the email verification code, nothing else
    });
  });

  app.post("/verify-email", {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const email = req.cookies[PENDING_EMAIL_COOKIE];
    if (!email) return reply.redirect("/register");

    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return redirectWith(reply, "/verify-email", { error: tr(req, "flash.code.sixDigits") });

    const result = await verifyCode(email, body.data.code);
    if (!result.ok) {
      const reasonMap: Record<string, string> = {
        no_pending: tr(req, "flash.verifyEmail.noPending"),
        expired: tr(req, "flash.verifyEmail.expired"),
        too_many_attempts: tr(req, "flash.verifyEmail.tooManyAttempts"),
        wrong: tr(req, "flash.code.wrong"),
      };
      const msg = reasonMap[result.reason ?? "wrong"] ?? tr(req, "flash.code.verifyFailed");
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
        // Consume the invite (if any) now that the account actually exists.
        // Best-effort: a race that exhausts the invite here shouldn't fail an
        // already-created account — log and move on.
        const inviteToken = result.payload?.inviteToken;
        if (inviteToken) {
          try {
            const consumed = await consumeInvite(inviteToken, email);
            if (!consumed.ok) req.log.warn({ email }, "invite_consume_failed_post_signup");
          } catch (err) {
            req.log.warn({ err }, "invite_consume_error");
          }
        }
      }
    }
    if (!user) return redirectWith(reply, "/verify-email", { error: tr(req, "flash.verifyEmail.completeFailed") });

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
    if (!pending) return redirectWith(reply, "/register", { error: tr(req, "flash.verifyEmail.restart") });

    const payload = pending.payload as unknown as PendingRegistration;
    const result = await issueCode(email, payload);
    if (!result.ok) return redirectWith(reply, "/verify-email", { error: tr(req, "flash.verifyEmail.resendFailed") });
    return redirectWith(reply, "/verify-email", { success: tr(req, "flash.verifyEmail.resent") });
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

    // Locale: same resolution chain as every other page (cookie > user >
    // site default > Accept-Language). The EJS template gets `t` from the
    // global view-locals hook; here we additionally build the client-side
    // strings map (window.BWC_T) for calendar-app.js, which can't call the
    // server-side t() — see clientStrings in src/lib/i18n.ts.
    const settings = await getSettings();
    const locale = resolveLocaleFromRequest(req, user.locale ?? null, settings.defaultLocale);

    return reply.view("app/calendar-app", {
      title: makeT(locale)("nav.calendar"),
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      calendars,
      timezones: listTimezones(locale),
      jsStrings: clientStrings(locale),
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
      title: tr(req, "dashboard.title"),
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
      return redirectWith(reply, "/app", { error: tr(req, "flash.calendar.nameRequired") });
    }
    await db.insert(schema.calendars).values({ ownerId: user.id, ...body.data });
    return redirectWith(reply, "/app", { success: tr(req, "flash.calendar.created") });
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
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.pickFile") });
    }
    const buf = await file.toBuffer();
    if (buf.length > 5 * 1024 * 1024) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.fileTooLarge") });
    }
    const text = buf.toString("utf8");
    if (!text.toUpperCase().includes("BEGIN:VCALENDAR")) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.notIcs") });
    }
    try {
      const result = await importIcsText(calId.data, text, { sourceTag: `file:${file.filename ?? "upload"}` });
      return redirectWith(reply, `/app/calendars/${calId.data}`, {
        success: tr(req, "flash.import.success", { inserted: result.inserted, updated: result.updated, skipped: result.skipped }),
      });
    } catch (err) {
      req.log.warn({ err }, "ics_file_import_failed");
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.failed", { error: err instanceof Error ? err.message : tr(req, "common.unknownError") }) });
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
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.pasteText") });
    }
    if (!body.data.text.toUpperCase().includes("BEGIN:VCALENDAR")) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.pasteNotIcs") });
    }
    try {
      const result = await importIcsText(calId.data, body.data.text, { sourceTag: "paste" });
      return redirectWith(reply, `/app/calendars/${calId.data}`, {
        success: tr(req, "flash.import.success", { inserted: result.inserted, updated: result.updated, skipped: result.skipped }),
      });
    } catch (err) {
      req.log.warn({ err }, "ics_text_import_failed");
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.failed", { error: err instanceof Error ? err.message : tr(req, "common.unknownError") }) });
    }
  });

  // Rate-limited: each call triggers a server-side outbound fetch to a
  // user-supplied URL. Even with the SSRF IP-block in place, an unthrottled
  // endpoint lets one account drive a lot of outbound requests (probing
  // public hosts, amplifying load). 10/min per IP is plenty for real use.
  app.post<{ Params: { id: string } }>("/app/calendars/:id/import/url-once", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const calId = z.string().uuid().safeParse(req.params.id);
    if (!calId.success) return reply.redirect("/app");
    if (!(await ownsCalendar(calId.data, user.id))) return reply.redirect("/app");

    const body = z.object({ url: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.urlInvalid") });
    }
    try {
      const text = await fetchIcsUrl(body.data.url);
      const result = await importIcsText(calId.data, text, { sourceTag: `url-once` });
      return redirectWith(reply, `/app/calendars/${calId.data}`, {
        success: tr(req, "flash.import.urlSuccess", { inserted: result.inserted, updated: result.updated, skipped: result.skipped }),
      });
    } catch (err) {
      req.log.warn({ err }, "ics_url_import_failed");
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.import.fetchFailed", { error: err instanceof Error ? err.message : tr(req, "common.unknownError") }) });
    }
  });

  // Rate-limited: creating a subscription immediately fires a server-side
  // fetch of the user-supplied URL (refreshSubscription below). Same
  // reasoning as /import/url-once.
  app.post<{ Params: { id: string } }>("/app/calendars/:id/subscriptions", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
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
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.subscription.urlInvalid") });
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
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.subscription.saveFailed") });
    }

    const refresh = await refreshSubscription(sub.id);
    if (!refresh.ok) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, {
        error: tr(req, "flash.subscription.savedFetchFailed", { error: refresh.error }),
      });
    }
    return redirectWith(reply, `/app/calendars/${calId.data}`, {
      success: tr(req, "flash.subscription.created", { inserted: refresh.result.inserted, updated: refresh.result.updated }),
    });
  });

  // Rate-limited: manual refresh triggers an immediate outbound fetch of the
  // subscription's user-supplied URL. Same reasoning as /import/url-once.
  app.post<{ Params: { id: string; subId: string } }>("/app/calendars/:id/subscriptions/:subId/refresh", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const params = z.object({ id: z.string().uuid(), subId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.redirect("/app");
    if (!(await ownsCalendar(params.data.id, user.id))) return reply.redirect("/app");
    const refresh = await refreshSubscription(params.data.subId);
    if (!refresh.ok) {
      return redirectWith(reply, `/app/calendars/${params.data.id}`, { error: tr(req, "flash.subscription.syncFailed", { error: refresh.error }) });
    }
    return redirectWith(reply, `/app/calendars/${params.data.id}`, {
      success: tr(req, "flash.subscription.synced", { inserted: refresh.result.inserted, updated: refresh.result.updated }),
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
    return redirectWith(reply, `/app/calendars/${params.data.id}`, { success: tr(req, "flash.subscription.deleted") });
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
    return redirectWith(reply, "/app", { success: tr(req, "flash.calendar.deleted") });
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
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.event.checkInput") });
    }

    const starts = new Date(body.data.startsAt);
    const ends = new Date(body.data.endsAt);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.event.badTime") });
    }
    if (ends < starts) {
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.event.endBeforeStart") });
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
    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: tr(req, "flash.event.added") });
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
      title: tr(req, "page.attendees", { summary: event.summary }),
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
      return redirectWith(reply, `/app/events/${evId.data}/attendees`, { error: tr(req, "flash.attendee.emailInvalid") });
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
      return redirectWith(reply, `/app/events/${evId.data}/attendees`, { error: tr(req, "flash.attendee.already", { email: inviteeEmail }) });
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
        error: tr(req, "flash.attendee.addedMailFailed", { email: inviteeEmail }),
      });
    }
    return redirectWith(reply, `/app/events/${evId.data}/attendees`, { success: tr(req, "flash.attendee.invited", { email: inviteeEmail }) });
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
    return redirectWith(reply, `/app/events/${evId.data}/attendees`, { success: tr(req, "flash.attendee.revoked", { email: target }) });
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
      ? tr(req, "flash.event.cancelledNotified", { count: result.cancelledNotices })
      : tr(req, "flash.event.deleted");
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
    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: tr(req, "flash.share.regenerated") });
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
    return redirectWith(reply, `/app/calendars/${params.data.id}`, { success: tr(req, "flash.share.revoked") });
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
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.member.emailInvalid") });
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
        return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.member.already", { email: inviteeEmail }) });
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
      return redirectWith(reply, `/app/calendars/${calId.data}`, { error: tr(req, "flash.member.inviteMailFailed") });
    }

    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: tr(req, "flash.member.invited", { email: inviteeEmail }) });
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
    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: tr(req, "flash.member.inviteRevoked") });
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
    return redirectWith(reply, `/app/calendars/${calId.data}`, { success: tr(req, "flash.member.removed") });
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
    const msg = body.data.status === "accepted" ? tr(req, "flash.rsvp.accepted")
              : body.data.status === "declined" ? tr(req, "flash.rsvp.declined")
              :                                   tr(req, "flash.rsvp.tentative");
    return reply.redirect(`/event-invite/${encodeURIComponent(req.params.token)}?success=${encodeURIComponent(msg)}`);
  });

  app.get<{ Params: { token: string } }>("/event-invite/:token", async (req, reply) => {
    const [tok] = await db.select().from(schema.eventInviteTokens).where(eq(schema.eventInviteTokens.token, req.params.token)).limit(1);
    if (!tok) {
      return reply.code(404).view("error", { title: tr(req, "page.inviteInvalid"), user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: tr(req, "errorPage.inviteInvalid.heading"), message: tr(req, "errorPage.inviteInvalid.message") });
    }
    if (tok.expiresAt < new Date()) {
      return reply.code(410).view("error", { title: tr(req, "page.expired"), user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 410, heading: tr(req, "errorPage.inviteExpired.heading"), message: tr(req, "errorPage.inviteExpired.message") });
    }
    const currentUser = await loadUserFromRequest(req);
    const [sourceEvent] = await db.select().from(schema.events).where(eq(schema.events.id, tok.sourceEventId)).limit(1);
    if (!sourceEvent) {
      return reply.code(404).view("error", { title: tr(req, "page.eventMissing"), user: currentUser, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: tr(req, "errorPage.eventMissing.heading"), message: tr(req, "errorPage.eventMissing.message") });
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
      title: tr(req, "page.addToCalendar"),
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
      return redirectWith(reply, `/event-invite/${encodeURIComponent(req.params.token)}`, { error: tr(req, "flash.eventInvite.expired") });
    }
    const body = z.object({ calendarId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, `/event-invite/${encodeURIComponent(req.params.token)}`, { error: tr(req, "flash.eventInvite.pickCalendar") });
    }
    if (!(await ownsCalendar(body.data.calendarId, user.id))) {
      return redirectWith(reply, `/event-invite/${encodeURIComponent(req.params.token)}`, { error: tr(req, "flash.eventInvite.noWriteAccess") });
    }
    const [sourceEvent] = await db.select().from(schema.events).where(eq(schema.events.id, tok.sourceEventId)).limit(1);
    if (!sourceEvent) {
      return redirectWith(reply, `/event-invite/${encodeURIComponent(req.params.token)}`, { error: tr(req, "flash.eventInvite.sourceGone") });
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
    return redirectWith(reply, "/app", { success: tr(req, "flash.eventInvite.added", { summary: sourceEvent.summary }) });
  });

  app.get<{ Params: { token: string } }>("/invite/:token", async (req, reply) => {
    const [inv] = await db
      .select()
      .from(schema.calendarInvitations)
      .where(eq(schema.calendarInvitations.token, req.params.token))
      .limit(1);
    if (!inv) {
      return reply.code(404).view("error", {
        title: tr(req, "page.inviteInvalid"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 404, heading: tr(req, "errorPage.calInviteInvalid.heading"), message: tr(req, "errorPage.calInviteInvalid.message"),
      });
    }
    if (inv.acceptedAt) {
      return reply.view("error", {
        title: tr(req, "page.accepted"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 200, heading: tr(req, "errorPage.calInviteAccepted.heading"), message: tr(req, "errorPage.calInviteAccepted.message"),
      });
    }
    if (inv.expiresAt < new Date()) {
      return reply.code(410).view("error", {
        title: tr(req, "page.expired"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 410, heading: tr(req, "errorPage.inviteExpired.heading"), message: tr(req, "errorPage.calInviteExpired.message"),
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
      title: tr(req, "page.acceptCalendarInvite"),
      user: currentUser,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      invitation: { token: inv.token, email: inv.email, role: inv.role, message: inv.message },
      calendar: cal,
      inviterName: inviter ? (inviter.displayName || inviter.email) : tr(req, "common.unknown"),
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
      return redirectWith(reply, `/invite/${req.params.token}`, { error: tr(req, "flash.eventInvite.expired") });
    }
    const user = await loadUserFromRequest(req);
    if (!user) {
      return redirectWith(reply, "/login", { error: tr(req, "flash.calInvite.signInAs", { email: inv.email }) });
    }
    if (user.email !== inv.email) {
      return redirectWith(reply, `/invite/${req.params.token}`, {
        error: tr(req, "flash.calInvite.wrongAccount", { email: inv.email }),
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
    return redirectWith(reply, "/app", { success: tr(req, "flash.calInvite.joined") });
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
      return redirectWith(reply, "/app", { success: tr(req, "flash.verifyEmail.alreadyVerified") });
    }
    // The verify-email flow expects a pending payload (passwordHash etc.) since
    // it was built for the register path; for already-existing users we just
    // mark verified after they enter the code, no user-creation step.
    const result = await issueCode(user.email, { passwordHash: user.passwordHash, displayName: user.displayName });
    if (!result.ok) {
      return redirectWith(reply, "/app", { error: tr(req, "flash.verifyEmail.sendFailed") });
    }
    reply.setCookie(PENDING_EMAIL_COOKIE, user.email, {
      httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/", maxAge: 15 * 60,
    });
    return redirectWith(reply, "/verify-email", { success: tr(req, "flash.verifyEmail.sentToInbox") });
  });

  // Shared data-load helper for all 5 sub-pages. They all render the
  // same EJS template (src/views/app/settings.ejs) — the only
  // difference is the `currentTab` view-local, which controls which
  // <section> blocks are visible. Keeping one template avoids
  // duplicating the modals + JS that span multiple sections (e.g.
  // the device-pair modal is rendered alongside the devices section
  // but its JS interacts with the calendar list and CalDAV setup).
  async function renderSettings(req: FastifyRequest, reply: FastifyReply, currentTab: "account" | "security" | "devices" | "notifications" | "appearance") {
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
    const q = (req.query ?? {}) as Record<string, unknown>;
    const newPlain = typeof q.newAppPassword === "string" ? q.newAppPassword : null;
    const newLabel = typeof q.newAppLabel === "string" ? q.newAppLabel : null;

    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const caldavBaseUrl = `${baseUrl}/caldav/`;
    const siteSettings = await getSettings();

    // Linked SSO identities + available providers (for the "登录方式" block).
    const { listIdentities } = await import("../lib/identities.js");
    const { listEnabledProvidersPublic } = await import("../lib/sso_providers.js");
    const linkedIdentities = await listIdentities(user.id);
    const ssoProviders = await listEnabledProvidersPublic();

    return reply.view("app/settings", {
      title: tr(req, "nav.settings"),
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
      linkedIdentities: linkedIdentities.map((i) => ({
        id: i.id,
        provider: i.provider,
        email: i.email,
        createdAtLocal: localTime(i.createdAt),
      })),
      ssoProviders,
      currentTab,
    });
  }

  // 5 routes — admin-style separate pages. Tab nav across the top is
  // rendered by src/views/app/settings/_nav.ejs, included from
  // settings.ejs. Old anchor links like /app/settings#passkey still
  // resolve (they just scroll inside the active tab); explicit links
  // from emails / nav menus should target the sub-route directly.
  app.get("/app/settings", (req, reply) => renderSettings(req, reply, "account"));
  app.get("/app/settings/security", (req, reply) => renderSettings(req, reply, "security"));
  app.get("/app/settings/devices", (req, reply) => renderSettings(req, reply, "devices"));
  app.get("/app/settings/notifications", (req, reply) => renderSettings(req, reply, "notifications"));
  app.get("/app/settings/appearance", (req, reply) => renderSettings(req, reply, "appearance"));

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
      title: tr(req, "search.heading"),
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
        title: tr(req, "page.appsDisabled"), user, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 403, heading: tr(req, "errorPage.appsDisabled.heading"),
        message: tr(req, "errorPage.appsDisabled.message"),
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
        title: tr(req, "page.signInLinkInvalid"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 400, heading: tr(req, "errorPage.signInLinkInvalid.heading"),
        message: tr(req, "errorPage.signInLinkInvalid.message"),
      });
    }
    const { consumeWebSessionToken } = await import("../routes/devices.js");
    const userId = consumeWebSessionToken(q.data.token);
    if (!userId) {
      return reply.code(403).view("error", {
        title: tr(req, "page.signInLinkExpired"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 403, heading: tr(req, "errorPage.signInLinkExpired.heading"),
        message: tr(req, "errorPage.signInLinkExpired.message"),
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
      title: tr(req, "page.loginHistory"),
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
      return redirectWith(reply, "/app/settings/devices", { error: tr(req, "flash.device.labelRequired") });
    }
    const issued = await createAppPassword(user.id, body.data.label);
    const params = new URLSearchParams({
      success: tr(req, "flash.device.appPasswordCreated"),
      newAppPassword: issued.plain,
      newAppLabel: body.data.label,
    });
    return reply.redirect(`/app/settings/devices?${params.toString()}#app-passwords`);
  });

  app.post<{ Params: { id: string } }>("/app/settings/app-passwords/:id/revoke", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/app/settings/devices");
    await revokeAppPassword(user.id, id.data);
    // Same TTL invalidation as password change — phone with the
    // revoked password should fail next sync, not 60s from now.
    invalidateCalDavAuthCache(user.id);
    return redirectWith(reply, "/app/settings/devices", { success: tr(req, "flash.device.appPasswordRevoked") });
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
      return redirectWith(reply, "/app/settings/appearance", { error: tr(req, "flash.appearance.invalid") });
    }
    if (body.data.reset) {
      await db.update(schema.users).set({ themePalette: null, themeDensity: null, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      clearThemeCookies(reply);
      return redirectWith(reply, "/app/settings/appearance", { success: tr(req, "flash.appearance.reset") });
    }
    const palette = isValidPalette(body.data.palette) ? body.data.palette : null;
    const density = isValidDensity(body.data.density) ? body.data.density : null;
    await db.update(schema.users).set({ themePalette: palette, themeDensity: density, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    setThemeCookies(reply, palette, density);
    return redirectWith(reply, "/app/settings/appearance", { success: tr(req, "flash.appearance.updated") });
  });

  // -------- 我的语言 -------- (per-user; overrides site default)
  // body.locale: "zh-CN" | "en" | "" (empty = inherit site default →
  // wipes the column, also clears the bwc_locale override cookie).
  app.post("/app/settings/locale", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const { isValidLocale, LOCALE_COOKIE, LOCALE_COOKIE_TTL_S } = await import("../lib/i18n.js");
    const body = z.object({ locale: z.string().max(20).optional() }).safeParse(req.body);
    if (!body.success) return redirectWith(reply, "/app/settings#language", { error: tr(req, "flash.language.invalid") });
    const raw = body.data.locale ?? "";
    if (raw === "") {
      // Empty selection → "Follow site default": wipe column + clear
      // explicit cookie. Next request resolves through site default.
      await db.update(schema.users).set({ locale: null, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      reply.clearCookie(LOCALE_COOKIE, { path: "/" });
    } else {
      if (!isValidLocale(raw)) return redirectWith(reply, "/app/settings#language", { error: tr(req, "flash.language.unsupported") });
      await db.update(schema.users).set({ locale: raw, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      // Also write the override cookie so the change takes effect on
      // THIS browser tab immediately (the redirect response carries it).
      reply.setCookie(LOCALE_COOKIE, raw, {
        httpOnly: false, sameSite: "lax", secure: env.NODE_ENV === "production",
        path: "/", maxAge: LOCALE_COOKIE_TTL_S,
      });
    }
    // No success toast: the UI visibly switching language IS the feedback,
    // and a hardcoded Chinese "语言已更新" toast looked wrong after switching
    // to another language. Just redirect back to the language section.
    return reply.redirect("/app/settings#language");
  });

  app.post("/app/settings/delete-account", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      password: z.string().min(1),
      confirm: z.string().min(1).max(100),
    }).safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/app/settings", { error: tr(req, "flash.deleteAccount.needPasswordAndPhrase") });
    }
    // The confirm phrase is i18n'd — the form shows
    // settings.account.deleteConfirmFieldPlaceholder in the user's locale.
    // We must accept whatever phrase that locale displays (not a hardcoded
    // zh-CN string), otherwise non-Chinese users could never delete their
    // account (they'd type the localized phrase the UI told them to, and a
    // `z.literal("删除我的账号")` check would always reject it). Resolve the
    // user's effective locale the same way the renderer does, then compare
    // against that locale's phrase. We also still accept the zh-CN phrase as
    // a back-compat fallback.
    const { resolveLocaleFromRequest, translate } = await import("../lib/i18n.js");
    const { getSettings: _getSettings } = await import("../lib/site_settings.js");
    const _settings = await _getSettings();
    const _locale = resolveLocaleFromRequest(req, user.locale, _settings.defaultLocale);
    const _expected = translate(_locale, "settings.account.deleteConfirmFieldPlaceholder");
    const _typed = body.data.confirm.trim();
    if (_typed !== _expected && _typed !== "删除我的账号") {
      return redirectWith(reply, "/app/settings", { error: tr(req, "flash.deleteAccount.phraseMismatch", { phrase: _expected }) });
    }
    // Verify password (SSO-only accounts can't self-delete this way; they
    // need to clear MFA / set a password first or contact admin).
    const ok = await verifyPassword(body.data.password, user.passwordHash);
    if (!ok) {
      return redirectWith(reply, "/app/settings", { error: tr(req, "flash.deleteAccount.wrongPassword") });
    }
    // Last-admin guard: refuse self-delete if this would leave the system
    // with zero admins. Same footgun as toggle-admin / toggle-disabled —
    // recovery from zero-admins requires manual DB intervention.
    if (user.isAdmin) {
      const { countActiveAdmins } = await import("../lib/user_state.js");
      if ((await countActiveAdmins()) <= 1) {
        return redirectWith(reply, "/app/settings", { error: tr(req, "flash.deleteAccount.lastAdmin") });
      }
    }
    // Hard delete — FK cascades clean up calendars/events/sessions/etc.
    await destroyAllUserSessions(user.id);
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
    await destroySession(req, reply);
    return redirectWith(reply, "/", { success: tr(req, "flash.deleteAccount.done") });
  });

  // Unlink an SSO login identity from the current account. Guards against
  // locking out an SSO-only account: refuse to remove the LAST identity when
  // the user also has no passkey (they'd have no usable way back in).
  app.post<{ Params: { id: string } }>("/app/settings/identities/:id/unlink", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/app/settings/security");
    const { listIdentities, unlinkIdentity } = await import("../lib/identities.js");
    const ids = await listIdentities(user.id);
    if (ids.length <= 1) {
      const pk = await db
        .select({ id: schema.webauthnCredentials.id })
        .from(schema.webauthnCredentials)
        .where(eq(schema.webauthnCredentials.userId, user.id))
        .limit(1);
      if (pk.length === 0) {
        return redirectWith(reply, "/app/settings/security", {
          error: tr(req, "flash.sso.onlyLoginMethod"),
        });
      }
    }
    await unlinkIdentity(user.id, id.data);
    return redirectWith(reply, "/app/settings/security", { success: tr(req, "flash.sso.unlinked") });
  });

  app.post("/app/settings/password", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/app/settings/security", { error: tr(req, "flash.password.badFormat") });
    }
    const policyErr = passwordPolicyError(body.data.newPassword);
    if (policyErr) {
      return redirectWith(reply, "/app/settings/security", { error: policyErr });
    }
    const ok = await verifyPassword(body.data.currentPassword, user.passwordHash);
    if (!ok) {
      return redirectWith(reply, "/app/settings/security", { error: tr(req, "flash.password.wrongCurrent") });
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
    return redirectWith(reply, "/login", { success: tr(req, "flash.password.updated") });
  });

  // -------- Booking links (Calendly-style) — management --------
  app.get("/app/booking-links", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const links = await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.userId, user.id)).orderBy(asc(schema.bookingLinks.title));
    const cals = await db.select({ id: schema.calendars.id, name: schema.calendars.name, color: schema.calendars.color }).from(schema.calendars).where(eq(schema.calendars.ownerId, user.id));
    return reply.view("app/booking-links", {
      title: tr(req, "page.bookingLinks"),
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
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "slug_format"),
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
    if (!body.success) {
      // The slug regex carries a "slug_format" sentinel instead of prose so
      // the human-readable text can be localized here; any other zod issue
      // falls through with its own message.
      const issue = body.error.errors[0];
      const detail = issue?.message === "slug_format" ? tr(req, "flash.bookingLink.slugFormat") : (issue?.message ?? "");
      return redirectWith(reply, "/app/booking-links", { error: tr(req, "flash.bookingLink.paramInvalid", { error: detail }) });
    }
    if (!(await ownsCalendar(body.data.calendarId, user.id))) {
      return redirectWith(reply, "/app/booking-links", { error: tr(req, "flash.bookingLink.calendarMissing") });
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
      const msg = err instanceof Error ? err.message : tr(req, "common.unknownError");
      return redirectWith(reply, "/app/booking-links", { error: msg.includes("duplicate") ? tr(req, "flash.bookingLink.slugTaken") : msg });
    }
    return redirectWith(reply, "/app/booking-links", { success: tr(req, "flash.bookingLink.created") });
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
    return redirectWith(reply, "/app/booking-links", { success: link.enabled ? tr(req, "flash.bookingLink.paused") : tr(req, "flash.bookingLink.enabled") });
  });

  app.post<{ Params: { id: string } }>("/app/booking-links/:id/delete", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/app/booking-links");
    await db.delete(schema.bookingLinks).where(and(eq(schema.bookingLinks.id, id.data), eq(schema.bookingLinks.userId, user.id)));
    return redirectWith(reply, "/app/booking-links", { success: tr(req, "flash.bookingLink.deleted") });
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
      success: link.notifyEmail ? tr(req, "flash.bookingLink.notifyOff") : tr(req, "flash.bookingLink.notifyOn"),
    });
  });

  // -------- Public booking pages --------
  app.get<{ Params: { userId: string; slug: string } }>("/book/:userId/:slug", async (req, reply) => {
    const userId = z.string().uuid().safeParse(req.params.userId);
    if (!userId.success) return reply.code(404).view("error", { title: tr(req, "page.notFound"), user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: tr(req, "errorPage.bookingNotFound.heading"), message: tr(req, "errorPage.bookingNotFound.message") });
    const link = await findLinkBySlug(userId.data, req.params.slug);
    if (!link || !link.enabled) {
      return reply.code(404).view("error", { title: tr(req, "page.notFound"), user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: tr(req, "errorPage.bookingDisabled.heading"), message: tr(req, "errorPage.bookingDisabled.message") });
    }
    const [owner] = await db.select({ email: schema.users.email, displayName: schema.users.displayName, disabledAt: schema.users.disabledAt }).from(schema.users).where(eq(schema.users.id, link.userId)).limit(1);
    if (!owner) return reply.code(404).type("text/plain").send("Not Found");
    // Disabled-account gate: don't accept bookings for a user the admin
    // has disabled — to the public the link should look exactly like
    // "not found" / "disabled link" so we don't leak account status.
    if (owner.disabledAt) {
      return reply.code(404).view("error", { title: tr(req, "page.notFound"), user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: tr(req, "errorPage.bookingDisabled.heading"), message: tr(req, "errorPage.bookingDisabled.message") });
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
    if (!link || !link.enabled) return redirectWith(reply, `/book/${userId.data}/${req.params.slug}`, { error: tr(req, "flash.booking.linkDisabled") });
    // Disabled-account gate: stop the booking before we INSERT an event
    // into the disabled user's calendar.
    const [ownerCheck] = await db.select({ disabledAt: schema.users.disabledAt }).from(schema.users).where(eq(schema.users.id, link.userId)).limit(1);
    if (!ownerCheck || ownerCheck.disabledAt) return redirectWith(reply, `/book/${userId.data}/${req.params.slug}`, { error: tr(req, "flash.booking.linkDisabled") });
    const body = z.object({
      startsAt: z.string().datetime({ offset: true }),
      guestEmail: z.string().email().max(254),
      guestName: z.string().min(1).max(100),
      guestMessage: z.string().max(2000).optional(),
    }).safeParse(req.body);
    if (!body.success) return redirectWith(reply, `/book/${userId.data}/${req.params.slug}`, { error: tr(req, "flash.booking.needEmailName") });
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
      return reply.redirect(`/book/${userId.data}/${req.params.slug}?success=${encodeURIComponent(tr(req, "flash.booking.success"))}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr(req, "flash.booking.failed");
      return redirectWith(reply, `/book/${userId.data}/${req.params.slug}`, { error: msg });
    }
  });

  app.get<{ Params: { token: string } }>("/book-cancel/:token", async (req, reply) => {
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.cancelToken, req.params.token)).limit(1);
    if (!b) return reply.code(404).view("error", { title: tr(req, "page.notFound"), user: null, csrfToken: csrfTokenFor(req), flash: {}, statusCode: 404, heading: tr(req, "errorPage.cancelLinkInvalid.heading"), message: tr(req, "errorPage.cancelLinkInvalid.message") });
    return reply.view("booking/cancel", {
      title: tr(req, "page.cancelBooking"),
      user: null, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      booking: b,
    });
  });

  app.post<{ Params: { token: string } }>("/book-cancel/:token", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.cancelToken, req.params.token)).limit(1);
    if (!b) return reply.redirect("/");
    if (b.cancelledAt) return redirectWith(reply, `/book-cancel/${req.params.token}`, { success: tr(req, "flash.booking.alreadyCancelled") });
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
    return redirectWith(reply, `/book-cancel/${req.params.token}`, { success: tr(req, "flash.booking.cancelled") });
  });
}
