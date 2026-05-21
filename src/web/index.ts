import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  createSession,
  destroyAllUserSessions,
  destroySession,
  loadSession,
  loadUserFromRequest,
} from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { newEventUid, newShareToken } from "../lib/ids.js";
import { isMailerEnabled, sendMail } from "../lib/mailer.js";
import { welcomeMail, passwordResetMail } from "../lib/email_templates.js";
import { issueCode, verifyCode } from "../lib/email_verification.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";
import { getSettings } from "../lib/site_settings.js";
import { listTimezones } from "../lib/timezones.js";
import { isLocked, lockedRemainingMinutes, recordFailedLogin, resetFailedLogin } from "../lib/login_lockout.js";
import { createReset, loadValidReset, consumeReset } from "../lib/password_reset.js";
import { createAppPassword, listAppPasswords, revokeAppPassword } from "../lib/app_password.js";
import { fetchIcsUrl, importIcsText, refreshSubscription } from "../lib/ics_import.js";

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

function localTime(d: Date, timezone = "Asia/Shanghai"): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return d.toISOString();
  }
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
      .object({ email: z.string().email(), password: z.string().min(1).max(200) })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/login", { error: "邮箱或密码格式不正确" });
    }
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, body.data.email)).limit(1);
    if (!user) {
      req.log.warn({ email: body.data.email, ip: req.ip }, "login_failed_no_user");
      return redirectWith(reply, "/login", { error: "邮箱或密码错误" });
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
    await createSession(reply, user.id, { mfaSatisfied: !user.mfaEnabled });
    if (user.mfaEnabled) return reply.redirect("/login/mfa");
    void notifyLoginSuccess(req, user, "password").catch((err) => req.log.warn({ err }, "login_alert_failed"));
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
      return redirectWith(reply, "/register", { error: "邮箱或密码格式不正确（密码至少 8 位）" });
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

    // Create the user
    const [user] = await db
      .insert(schema.users)
      .values({
        email,
        emailVerified: true,
        passwordHash: result.payload!.passwordHash,
        displayName: result.payload!.displayName,
      })
      .returning();
    if (!user) return redirectWith(reply, "/verify-email", { error: "创建账号失败" });

    reply.clearCookie(PENDING_EMAIL_COOKIE, { path: "/" });
    await createSession(reply, user.id);
    void sendMail(welcomeMail(user.email, user.displayName)).catch((err) => req.log.warn({ err }, "welcome_mail_failed"));
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

  app.post("/logout", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    await destroySession(req, reply);
    return reply.redirect("/");
  });

  // -------- Authed app --------
  // Main calendar view (Google/Synology-style grid + sidebar).
  app.get("/app", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    const calendars = await db
      .select({
        id: schema.calendars.id,
        name: schema.calendars.name,
        color: schema.calendars.color,
        timezone: schema.calendars.timezone,
      })
      .from(schema.calendars)
      .where(eq(schema.calendars.ownerId, user.id))
      .orderBy(asc(schema.calendars.name));

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
      .where(eq(schema.events.calendarId, calendar.id))
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
    });
  });

  // ---------- ICS import ----------
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
    await db.delete(schema.events).where(eq(schema.events.id, target.id));
    return redirectWith(reply, `/app/calendars/${target.calendarId}`, { success: "事件已删除" });
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
    const q = (req.query ?? {}) as Record<string, unknown>;
    const newPlain = typeof q.newAppPassword === "string" ? q.newAppPassword : null;
    const newLabel = typeof q.newAppLabel === "string" ? q.newAppLabel : null;

    return reply.view("app/settings", {
      title: "设置",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      createdAtLocal: localTime(user.createdAt),
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
    return redirectWith(reply, "/app/settings", { success: "应用密码已撤销" });
  });

  app.post("/app/settings/password", async (req, reply) => {
    const user = await loadAuthedUser(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) })
      .safeParse(req.body);
    if (!body.success) {
      return redirectWith(reply, "/app/settings", { error: "新密码至少 8 位" });
    }
    const ok = await verifyPassword(body.data.currentPassword, user.passwordHash);
    if (!ok) {
      return redirectWith(reply, "/app/settings", { error: "当前密码错误" });
    }
    const passwordHash = await hashPassword(body.data.newPassword);
    await db.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    // Invalidate all sessions including current; user must re-login
    await destroyAllUserSessions(user.id);
    await destroySession(req, reply);
    return redirectWith(reply, "/login", { success: "密码已更新，请重新登录" });
  });
}
