import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { loadSession } from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { getSettings, updateSettings } from "../lib/site_settings.js";
import { sendMail } from "../lib/mailer.js";
import {
  calendarInviteMail,
  loginAlertMail,
  passwordResetMail,
  verificationCodeMail,
  welcomeMail,
} from "../lib/email_templates.js";
import { applyUpdate, applyUpdateStream, checkForUpdates, pickBranch, pickRemote, restartProcess } from "../lib/self_update.js";
import { createProvider, deleteProvider, getProviderById, listAllProviders, updateProvider } from "../lib/sso_providers.js";
import { createApiToken, listAllApiTokens, revokeApiTokenAdmin } from "../lib/api_token.js";
import { listEnabledProvidersPublic } from "../lib/sso_providers.js";

async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const s = await loadSession(req);
  if (!s) {
    reply.redirect("/login");
    return null;
  }
  if (s.user.mfaEnabled && !s.mfaSatisfied) {
    reply.redirect("/login/mfa");
    return null;
  }
  if (!s.user.isAdmin) {
    reply.code(403).view("error", {
      title: "无权访问",
      user: s.user,
      csrfToken: csrfTokenFor(req),
      flash: {},
      statusCode: 403,
      heading: "权限不足",
      message: "你不是管理员。",
    });
    return null;
  }
  return s.user;
}

function flashFromQuery(req: FastifyRequest) {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return {
    error: typeof q.error === "string" ? q.error : undefined,
    success: typeof q.success === "string" ? q.success : undefined,
  };
}

export async function adminRoutes(app: FastifyInstance) {
  // Overview / settings dashboard
  app.get("/admin", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const settings = await getSettings();
    const userCount = await db.select({ c: sql<number>`count(*)::int` }).from(schema.users);
    const calendarCount = await db.select({ c: sql<number>`count(*)::int` }).from(schema.calendars);
    const eventCount = await db.select({ c: sql<number>`count(*)::int` }).from(schema.events);

    return reply.view("admin/index", {
      title: "管理后台",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      settings,
      stats: {
        users: userCount[0]?.c ?? 0,
        calendars: calendarCount[0]?.c ?? 0,
        events: eventCount[0]?.c ?? 0,
      },
    });
  });

  // Section pages
  app.get("/admin/site", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const settings = await getSettings();
    return reply.view("admin/site", {
      title: "站点设置 · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req), settings,
    });
  });

  app.get("/admin/logo", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const settings = await getSettings();
    return reply.view("admin/logo", {
      title: "Logo · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req), settings,
    });
  });

  app.get("/admin/smtp", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const settings = await getSettings();
    return reply.view("admin/smtp", {
      title: "SMTP 邮件 · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req), settings,
    });
  });

  app.get("/admin/sso", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const providers = await listAllProviders();
    return reply.view("admin/sso", {
      title: "SSO · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/sso",
      providers,
      callbackUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/sso/callback`,
    });
  });

  app.post("/admin/sso/providers", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "slug 只能包含 a-z 0-9 和 -"),
      issuerUrl: z.string().url(),
      clientId: z.string().min(1).max(200),
      clientSecret: z.string().min(1).max(400),
      label: z.string().min(1).max(100),
      enabled: z.string().optional().transform((v) => v === "on"),
      sortOrder: z.coerce.number().int().default(0),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.redirect("/admin/sso?error=" + encodeURIComponent("参数无效：" + body.error.errors[0]?.message));
    }
    try {
      await createProvider(body.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      return reply.redirect("/admin/sso?error=" + encodeURIComponent(`新增失败：${msg.includes("duplicate") ? "slug 已存在" : msg}`));
    }
    return reply.redirect("/admin/sso?success=" + encodeURIComponent(`已添加「${body.data.label}」`));
  });

  app.post<{ Params: { id: string } }>("/admin/sso/providers/:id", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/admin/sso");
    const prov = await getProviderById(id.data);
    if (!prov) return reply.redirect("/admin/sso?error=" + encodeURIComponent("提供方不存在"));
    const body = z.object({
      issuerUrl: z.string().url(),
      clientId: z.string().min(1).max(200),
      clientSecret: z.string().max(400).optional(), // empty → keep existing
      label: z.string().min(1).max(100),
      enabled: z.string().optional().transform((v) => v === "on"),
      sortOrder: z.coerce.number().int().default(0),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/sso?error=" + encodeURIComponent("参数无效"));
    const patch: Parameters<typeof updateProvider>[1] = {
      issuerUrl: body.data.issuerUrl,
      clientId: body.data.clientId,
      label: body.data.label,
      enabled: body.data.enabled,
      sortOrder: body.data.sortOrder,
    };
    if (body.data.clientSecret && body.data.clientSecret.trim()) patch.clientSecret = body.data.clientSecret.trim();
    await updateProvider(id.data, patch);
    return reply.redirect("/admin/sso?success=" + encodeURIComponent(`已更新「${body.data.label}」`));
  });

  app.post<{ Params: { id: string } }>("/admin/sso/providers/:id/delete", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/admin/sso");
    await deleteProvider(id.data);
    return reply.redirect("/admin/sso?success=" + encodeURIComponent("已删除"));
  });

  app.post("/admin/settings", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      siteName: z.string().min(1).max(200),
      registrationMode: z.enum(["closed", "public", "invite"]),
      icpNumber: z.string().max(100).optional().transform((v) => (v?.trim() ? v.trim() : null)),
      icpUrl: z.string().url().optional().transform((v) => (v?.trim() ? v.trim() : "https://beian.miit.gov.cn/")),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/site?error=" + encodeURIComponent("参数无效"));
    await updateSettings({
      siteName: body.data.siteName,
      registrationMode: body.data.registrationMode,
      icpNumber: body.data.icpNumber,
      icpUrl: body.data.icpUrl,
    });
    return reply.redirect("/admin/site?success=" + encodeURIComponent("站点设置已保存"));
  });

  app.post("/admin/smtp", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      host: z.string().optional().transform((v) => v?.trim() || null),
      port: z.coerce.number().int().positive().default(465),
      secure: z.string().optional().transform((v) => v === "on" || v === "true"),
      smtpUser: z.string().optional().transform((v) => v?.trim() || null),
      smtpPass: z.string().optional().transform((v) => v?.trim() || null),
      fromAddress: z.string().email().optional().or(z.literal("")).transform((v) => v?.trim() || null),
      fromName: z.string().max(100).optional().transform((v) => v?.trim() || "ByWave-Calendar"),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/smtp?error=" + encodeURIComponent("SMTP 参数无效"));
    const patch: Parameters<typeof updateSettings>[0] = {
      smtpHost: body.data.host,
      smtpPort: body.data.port,
      smtpSecure: body.data.secure,
      smtpUser: body.data.smtpUser,
      mailFromAddress: body.data.fromAddress,
      mailFromName: body.data.fromName,
    };
    // Only update password when submitted
    if (body.data.smtpPass) patch.smtpPass = body.data.smtpPass;
    await updateSettings(patch);
    return reply.redirect("/admin/smtp?success=" + encodeURIComponent("SMTP 配置已保存"));
  });

  app.post("/admin/sso/keycloak", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      enabled: z.string().optional().transform((v) => v === "on" || v === "true"),
      issuerUrl: z.string().url().optional().transform((v) => v?.trim() || null),
      clientId: z.string().max(200).optional().transform((v) => v?.trim() || null),
      clientSecret: z.string().max(400).optional().transform((v) => v?.trim() || null),
      label: z.string().max(100).optional().transform((v) => v?.trim() || "使用 SSO 登录"),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/sso?error=" + encodeURIComponent("SSO 参数无效"));
    const patch: Parameters<typeof updateSettings>[0] = {
      ssoKeycloakEnabled: body.data.enabled,
      ssoKeycloakIssuerUrl: body.data.issuerUrl,
      ssoKeycloakClientId: body.data.clientId,
      ssoKeycloakLabel: body.data.label,
    };
    // Only update secret if a non-empty value was submitted, so unchanged secrets aren't wiped.
    if (body.data.clientSecret) patch.ssoKeycloakClientSecret = body.data.clientSecret;
    await updateSettings(patch);
    return reply.redirect("/admin/sso?success=" + encodeURIComponent("SSO 设置已保存"));
  });

  // ---------- Logo upload ----------
  app.post("/admin/logo", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    // multipart requests don't carry CSRF cookie token reliably; rely on auth + admin check + same-origin.

    const file = await req.file();
    if (!file) return reply.redirect("/admin/logo?error=" + encodeURIComponent("请选择文件"));

    const allowed = new Set([
      "image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp",
    ]);
    if (!allowed.has(file.mimetype.toLowerCase())) {
      return reply.redirect("/admin/logo?error=" + encodeURIComponent("仅支持 PNG / JPG / SVG / WEBP"));
    }

    const uploadsDir = path.join(process.cwd(), "src", "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const buf = await file.toBuffer();
    if (buf.length > 2 * 1024 * 1024) {
      return reply.redirect("/admin/logo?error=" + encodeURIComponent("文件超过 2MB"));
    }

    // Normalize: center-crop square + resize to 512×512 PNG for consistent display.
    try {
      const processed = await sharp(buf, { failOn: "none" })
        .rotate()
        .resize({ width: 512, height: 512, fit: "cover", position: "center" })
        .png({ compressionLevel: 9 })
        .toBuffer();
      await writeFile(path.join(uploadsDir, "logo.png"), processed);
    } catch (err) {
      return reply.redirect("/admin/logo?error=" + encodeURIComponent("图片无法解析，请换一张"));
    }

    const url = `/static/uploads/logo.png?v=${Date.now()}`;
    await updateSettings({ logoUrl: url });
    return reply.redirect("/admin/logo?success=" + encodeURIComponent("Logo 已上传"));
  });

  app.post("/admin/logo/delete", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const settings = await getSettings();
    if (settings.logoUrl) {
      const m = settings.logoUrl.match(/\/static\/uploads\/(logo\.\w+)/);
      if (m && m[1]) {
        const p = path.join(process.cwd(), "src", "public", "uploads", m[1]);
        await unlink(p).catch(() => undefined);
      }
    }
    await updateSettings({ logoUrl: null });
    return reply.redirect("/admin/logo?success=" + encodeURIComponent("已删除 Logo"));
  });

  app.get("/admin/users", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        isAdmin: schema.users.isAdmin,
        emailVerified: schema.users.emailVerified,
        mfaEnabled: schema.users.mfaEnabled,
        ssoProviderSlug: schema.users.ssoProviderSlug,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt));
    // Aggregate auxiliary methods: passkey count per user + most-recent login method.
    const userIds = rows.map((r) => r.id);
    const passkeyCounts = userIds.length === 0 ? [] : await db
      .select({ userId: schema.webauthnCredentials.userId, count: sql<number>`count(*)::int` })
      .from(schema.webauthnCredentials)
      .where(inArray(schema.webauthnCredentials.userId, userIds))
      .groupBy(schema.webauthnCredentials.userId);
    const passkeyMap = new Map(passkeyCounts.map((r) => [r.userId, Number(r.count)]));
    const methodMap = new Map<string, string>();
    if (userIds.length > 0) {
      const recent = await db
        .select({
          userId: schema.loginEvents.userId,
          method: schema.loginEvents.method,
          createdAt: schema.loginEvents.createdAt,
        })
        .from(schema.loginEvents)
        .where(inArray(schema.loginEvents.userId, userIds))
        .orderBy(desc(schema.loginEvents.createdAt))
        .limit(500);
      // Walk newest-first and keep the first method seen per user.
      for (const r of recent) {
        if (!methodMap.has(r.userId)) methodMap.set(r.userId, r.method);
      }
    }
    return reply.view("admin/users", {
      title: "用户管理",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      users: rows.map((r) => ({
        ...r,
        passkeyCount: passkeyMap.get(r.id) ?? 0,
        lastLoginMethod: methodMap.get(r.id) ?? null,
      })),
    });
  });

  app.post("/admin/users/:id/toggle-admin", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/users");
    if (id.data === me.id) {
      return reply.redirect("/admin/users?error=" + encodeURIComponent("不能修改自己的管理员身份"));
    }
    const [target] = await db.select({ isAdmin: schema.users.isAdmin }).from(schema.users).where(eq(schema.users.id, id.data)).limit(1);
    if (!target) return reply.redirect("/admin/users?error=" + encodeURIComponent("用户不存在"));
    await db.update(schema.users).set({ isAdmin: !target.isAdmin, updatedAt: new Date() }).where(eq(schema.users.id, id.data));
    return reply.redirect("/admin/users?success=" + encodeURIComponent(target.isAdmin ? "已撤销管理员" : "已设为管理员"));
  });

  // ---------- Third-party API ----------
  // Lightweight <time data-tz> wrapper; the client-side local-time.js reformats
  // to the visitor's browser TZ on load.
  const localTimeIso = (d: Date) => `<time data-tz datetime="${d.toISOString()}" data-style="datetime">${d.toISOString()}</time>`;

  app.get("/admin/api", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    const settings = await getSettings();
    const tokens = await listAllApiTokens();
    const allUsers = await db.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName }).from(schema.users).orderBy(asc(schema.users.email));
    const providers = await listEnabledProvidersPublic();
    const issuedToken = typeof (req.query as { issued?: string }).issued === "string" ? (req.query as { issued: string }).issued : null;
    const issuedLabel = typeof (req.query as { issuedLabel?: string }).issuedLabel === "string" ? (req.query as { issuedLabel: string }).issuedLabel : null;
    return reply.view("admin/api", {
      title: "API · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/api",
      apiEnabled: settings.apiEnabled,
      ssoEnabled: providers.length > 0,
      tokens: tokens.map((t) => ({
        ...t,
        createdAtLocal: localTimeIso(t.createdAt),
        lastUsedAtLocal: t.lastUsedAt ? localTimeIso(t.lastUsedAt) : null,
        expiresAtLocal: t.expiresAt ? localTimeIso(t.expiresAt) : null,
      })),
      allUsers,
      issuedToken,
      issuedLabel,
      baseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
    });
  });

  app.post("/admin/api/toggle", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!verifyCsrf(req, reply)) return;
    const enabled = (req.body as { enabled?: string } | undefined)?.enabled === "on";
    await updateSettings({ apiEnabled: enabled });
    return reply.redirect("/admin/api?success=" + encodeURIComponent(enabled ? "API 已启用" : "API 已关闭（现存 token 暂停工作）"));
  });

  app.post("/admin/api/tokens", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      label: z.string().min(1).max(80),
      userId: z.string().uuid(),
      scope: z.enum(["read", "write"]).default("write"),
      expiresInDays: z.coerce.number().int().min(0).max(3650).default(0),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/api?error=" + encodeURIComponent("参数无效"));
    const targetExists = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, body.data.userId)).limit(1);
    if (targetExists.length === 0) return reply.redirect("/admin/api?error=" + encodeURIComponent("目标用户不存在"));
    const issued = await createApiToken({
      userId: body.data.userId,
      label: body.data.label,
      scope: body.data.scope,
      expiresInDays: body.data.expiresInDays > 0 ? body.data.expiresInDays : null,
    });
    const params = new URLSearchParams({ issued: issued.plain, issuedLabel: body.data.label, success: "Token 已生成，仅显示一次，请立即复制" });
    return reply.redirect("/admin/api?" + params.toString());
  });

  app.post<{ Params: { id: string } }>("/admin/api/tokens/:id/revoke", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/admin/api");
    await revokeApiTokenAdmin(id.data);
    return reply.redirect("/admin/api?success=" + encodeURIComponent("Token 已撤销"));
  });

  // ---------- Security knobs (risk-login + lockout) ----------
  app.get("/admin/security", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const settings = await getSettings();
    return reply.view("admin/security", {
      title: "安全设置",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      activeNav: "/admin/security",
      settings,
    });
  });

  app.post("/admin/security", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({
        riskLoginEnabled: z.string().optional(),
        lockoutEnabled: z.string().optional(),
        lockoutThreshold: z.coerce.number().int().min(1).max(100),
        lockoutMinutes: z.coerce.number().int().min(1).max(10080),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.redirect("/admin/security?error=" + encodeURIComponent("无效的数值（次数 1-100；时长 1-10080 分钟）"));
    }
    await updateSettings({
      riskLoginEnabled: body.data.riskLoginEnabled === "on",
      lockoutEnabled: body.data.lockoutEnabled === "on",
      lockoutThreshold: body.data.lockoutThreshold,
      lockoutMinutes: body.data.lockoutMinutes,
    });
    return reply.redirect("/admin/security?success=" + encodeURIComponent("安全设置已保存"));
  });

  // ---------- Email template preview (admin only) ----------
  app.post("/admin/smtp/preview", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({ to: z.string().email() }).safeParse(req.body);
    if (!body.success) {
      return reply.redirect("/admin/smtp?error=" + encodeURIComponent("请输入合法的邮箱地址"));
    }
    const to = body.data.to;
    const sent: string[] = [];
    const failed: string[] = [];
    const tasks: { label: string; build: () => ReturnType<typeof verificationCodeMail> }[] = [
      { label: "1. 邮箱验证码（注册）", build: () => verificationCodeMail(to, "123456") },
      { label: "2. 密码重置", build: () => passwordResetMail(to, "demo-token-not-real-zG7yQpKxL3mN9vBdE2hRsT4uW6f") },
      { label: "3. 新登录提醒", build: () => loginAlertMail(to, {
        email: to, displayName: "示例用户", loginAt: new Date(), ip: "203.0.113.42",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15",
        method: "password", location: "上海",
      }) },
      { label: "4. 日历邀请协作", build: () => calendarInviteMail(to, {
        calendarName: "工作日历", inviterName: "示例管理员", role: "editor",
        message: "把这个加进你的日历，每周一会议都在这里。", token: "demo-invitation-token",
      }) },
      { label: "5. 欢迎邮件", build: () => welcomeMail(to, "示例用户") },
    ];
    for (const t of tasks) {
      try {
        await sendMail(t.build());
        sent.push(t.label);
      } catch (err) {
        req.log.warn({ err, label: t.label }, "preview_email_send_failed");
        failed.push(t.label);
      }
    }
    const msg = failed.length
      ? `已发 ${sent.length} 封，失败 ${failed.length} 封（${failed.join(", ")}）—— 检查 SMTP 设置`
      : `已发送 5 封样式邮件到 ${to}，请查收`;
    return reply.redirect("/admin/smtp?success=" + encodeURIComponent(msg));
  });

  // ---------- Theme / appearance ----------
  app.get("/admin/theme", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const settings = await getSettings();
    return reply.view("admin/theme", {
      title: "外观",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      activeNav: "/admin/theme",
      currentPalette: settings.themePalette,
      currentDensity: settings.themeDensity,
    });
  });

  app.post("/admin/theme", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({
        palette: z.enum(["indigo", "emerald", "rose", "sky", "amber", "violet", "slate"]),
        density: z.enum(["comfortable", "compact"]),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.redirect("/admin/theme?error=" + encodeURIComponent("无效的选项"));
    }
    await updateSettings({ themePalette: body.data.palette, themeDensity: body.data.density });
    return reply.redirect("/admin/theme?success=" + encodeURIComponent("外观已更新"));
  });

  // ---------- Self-update (admin only) ----------
  app.get("/admin/update", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    return reply.view("admin/update", {
      title: "系统更新",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      activeNav: "/admin/update",
      remote: pickRemote(),
      branch: pickBranch(),
      pm2Name: process.env.PM2_PROCESS_NAME || "by-wave-calendar",
    });
  });

  app.post("/admin/update/check", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    try {
      const status = await checkForUpdates();
      return reply.send({ ok: true, status });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : "未知错误" });
    }
  });

  // Non-streaming fallback (kept for clients that don't support SSE)
  app.post("/admin/update/apply", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    try {
      const result = await applyUpdate();
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : "未知错误" });
    }
  });

  // Streaming variant with per-step progress (Server-Sent Events).
  app.post("/admin/update/apply-stream", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      for await (const ev of applyUpdateStream()) write(ev);
    } catch (err) {
      write({ type: "final", ok: false, error: err instanceof Error ? err.message : "未知错误" });
    } finally {
      reply.raw.end();
    }
  });

  app.post("/admin/update/restart", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    // Reply first; queue the restart so the response can flush.
    reply.send({ ok: true, scheduled: true });
    setTimeout(() => {
      void restartProcess().catch(() => undefined);
    }, 800);
    return reply;
  });

  void asc;
}
