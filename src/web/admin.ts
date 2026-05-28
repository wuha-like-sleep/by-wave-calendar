import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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
import { addRemote, applyUpdate, applyUpdateStream, checkForUpdates, listRemotes, pickBranch, pickRemote, restartProcess } from "../lib/self_update.js";
import { createProvider, deleteProvider, getProviderById, listAllProviders, updateProvider } from "../lib/sso_providers.js";
import { createApiToken, listAllApiTokens, revokeApiTokenAdmin } from "../lib/api_token.js";
import { exportData, importData, BACKUP_VERSION, type BackupBundle } from "../lib/backup.js";
import { audit } from "../lib/audit.js";
import { listEnabledProvidersPublic } from "../lib/sso_providers.js";
import { revokeAllUserCredentials, countActiveAdmins } from "../lib/user_state.js";
import { invalidateCalDavAuthCache, getCalDavAuthCacheStats } from "../lib/caldav_auth.js";
import { createOAuthClient, OAUTH_SCOPES, type OAuthScope } from "../lib/oauth_server.js";

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
  // Force-MFA gate: when site_settings.forceAdminMfa is true, admin accounts
  // can read but must enable MFA before they can touch anything.
  const settings = await getSettings();
  if (settings.forceAdminMfa && !s.user.mfaEnabled) {
    reply.redirect("/app/settings/mfa/setup?error=" + encodeURIComponent("管理员账号必须启用 MFA 才能进入后台"));
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

    // Counts. Use parallel queries — they don't depend on each other,
    // so Promise.all is a real win on a busy DB.
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      userRow, activeUserRow, disabledUserRow, adminRow,
      calendarRow, eventRow, recurringRow, deletedRow,
      loginDayRow, loginWeekRow,
      webhookRow, deliveryFailRow, oauthAppRow, apiTokenRow,
      inviteOpenRow, inviteAcceptedRow,
    ] = await Promise.all([
      db.select({ c: sql<number>`count(*)::int` }).from(schema.users),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.users).where(isNull(schema.users.disabledAt)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.users).where(isNotNull(schema.users.disabledAt)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.users).where(eq(schema.users.isAdmin, true)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.calendars),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.events).where(isNull(schema.events.deletedAt)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.events).where(and(isNotNull(schema.events.rrule), isNull(schema.events.deletedAt))),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.events).where(isNotNull(schema.events.deletedAt)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.loginEvents).where(gte(schema.loginEvents.createdAt, oneDayAgo)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.loginEvents).where(gte(schema.loginEvents.createdAt, sevenDaysAgo)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.webhooks).where(eq(schema.webhooks.enabled, true)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.webhookDeliveries)
        .where(and(gte(schema.webhookDeliveries.createdAt, oneDayAgo), eq(schema.webhookDeliveries.ok, false))),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.oauthClients),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.apiTokens).where(isNull(schema.apiTokens.revokedAt)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.eventInviteTokens).where(isNull(schema.eventInviteTokens.respondedAt)),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.eventInviteTokens).where(isNotNull(schema.eventInviteTokens.respondedAt)),
    ]);

    // Recent audit-log entries — top 5 give a "what happened lately" feel.
    const recentAudit = await db
      .select({
        id: schema.adminAuditLog.id,
        action: schema.adminAuditLog.action,
        targetType: schema.adminAuditLog.targetType,
        createdAt: schema.adminAuditLog.createdAt,
        actorUserId: schema.adminAuditLog.actorUserId,
      })
      .from(schema.adminAuditLog)
      .orderBy(desc(schema.adminAuditLog.createdAt))
      .limit(5);

    return reply.view("admin/index", {
      title: "管理后台",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      settings,
      stats: {
        users: userRow[0]?.c ?? 0,
        usersActive: activeUserRow[0]?.c ?? 0,
        usersDisabled: disabledUserRow[0]?.c ?? 0,
        admins: adminRow[0]?.c ?? 0,
        calendars: calendarRow[0]?.c ?? 0,
        events: eventRow[0]?.c ?? 0,
        recurringEvents: recurringRow[0]?.c ?? 0,
        deletedEvents: deletedRow[0]?.c ?? 0,
        loginsDay: loginDayRow[0]?.c ?? 0,
        loginsWeek: loginWeekRow[0]?.c ?? 0,
        activeWebhooks: webhookRow[0]?.c ?? 0,
        failedDeliveriesDay: deliveryFailRow[0]?.c ?? 0,
        oauthApps: oauthAppRow[0]?.c ?? 0,
        apiTokensLive: apiTokenRow[0]?.c ?? 0,
        invitesOpen: inviteOpenRow[0]?.c ?? 0,
        invitesAccepted: inviteAcceptedRow[0]?.c ?? 0,
      },
      recentAudit: recentAudit.map((r) => ({
        ...r,
        createdAtLocal: r.createdAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
      })),
      // Boot info — surfaces "is the server actually alive?" at a glance.
      runtime: {
        nodeVersion: process.versions.node,
        uptimeSec: Math.floor(process.uptime()),
        memMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      // CalDAV auth cache stats — surface hit rate so admins can see
      // the iOS/Android sync acceleration is working. Cold cache or
      // 0% hit rate would indicate every request is doing bcrypt
      // (which is what makes CalDAV sync take 5-10 seconds).
      caldavCache: getCalDavAuthCacheStats(),
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

  // SSO management. Dual-registered at /admin/sso and /admin/idp because
  // 宝塔 WAF blocks the "sso" substring outright (returns 444). /admin/idp
  // is the working path; /admin/sso kept around for users who whitelist
  // the original. All internal redirects target /admin/idp so the post-
  // submit URL never hits the WAF.
  const ssoIndex = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const providers = await listAllProviders();
    return reply.view("admin/sso", {
      title: "SSO · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/idp",
      providers,
      // Tell admins to register THIS callback URL with the IdP. The /auth/sso
      // variant won't work behind WAF, so we surface the safer one.
      callbackUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/idp/callback`,
    });
  };
  app.get("/admin/sso", ssoIndex);
  app.get("/admin/idp", ssoIndex);

  const ssoCreateProvider = async (req: FastifyRequest, reply: FastifyReply) => {
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
      return reply.redirect("/admin/idp?error=" + encodeURIComponent("参数无效：" + body.error.errors[0]?.message));
    }
    try {
      await createProvider(body.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      return reply.redirect("/admin/idp?error=" + encodeURIComponent(`新增失败：${msg.includes("duplicate") ? "slug 已存在" : msg}`));
    }
    return reply.redirect("/admin/idp?success=" + encodeURIComponent(`已添加「${body.data.label}」`));
  };
  app.post("/admin/sso/providers", ssoCreateProvider);
  app.post("/admin/idp/providers", ssoCreateProvider);

  const ssoUpdateProvider = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/admin/idp");
    const prov = await getProviderById(id.data);
    if (!prov) return reply.redirect("/admin/idp?error=" + encodeURIComponent("提供方不存在"));
    const body = z.object({
      issuerUrl: z.string().url(),
      clientId: z.string().min(1).max(200),
      clientSecret: z.string().max(400).optional(), // empty → keep existing
      label: z.string().min(1).max(100),
      enabled: z.string().optional().transform((v) => v === "on"),
      sortOrder: z.coerce.number().int().default(0),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/idp?error=" + encodeURIComponent("参数无效"));
    const patch: Parameters<typeof updateProvider>[1] = {
      issuerUrl: body.data.issuerUrl,
      clientId: body.data.clientId,
      label: body.data.label,
      enabled: body.data.enabled,
      sortOrder: body.data.sortOrder,
    };
    if (body.data.clientSecret && body.data.clientSecret.trim()) patch.clientSecret = body.data.clientSecret.trim();
    await updateProvider(id.data, patch);
    return reply.redirect("/admin/idp?success=" + encodeURIComponent(`已更新「${body.data.label}」`));
  };
  app.post<{ Params: { id: string } }>("/admin/sso/providers/:id", ssoUpdateProvider);
  app.post<{ Params: { id: string } }>("/admin/idp/providers/:id", ssoUpdateProvider);

  const ssoDeleteProvider = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/admin/idp");
    await deleteProvider(id.data);
    return reply.redirect("/admin/idp?success=" + encodeURIComponent("已删除"));
  };
  app.post<{ Params: { id: string } }>("/admin/sso/providers/:id/delete", ssoDeleteProvider);
  app.post<{ Params: { id: string } }>("/admin/idp/providers/:id/delete", ssoDeleteProvider);

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

  const ssoKeycloakLegacy = async (req: FastifyRequest, reply: FastifyReply) => {
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
    if (!body.success) return reply.redirect("/admin/idp?error=" + encodeURIComponent("SSO 参数无效"));
    const patch: Parameters<typeof updateSettings>[0] = {
      ssoKeycloakEnabled: body.data.enabled,
      ssoKeycloakIssuerUrl: body.data.issuerUrl,
      ssoKeycloakClientId: body.data.clientId,
      ssoKeycloakLabel: body.data.label,
    };
    if (body.data.clientSecret) patch.ssoKeycloakClientSecret = body.data.clientSecret;
    await updateSettings(patch);
    return reply.redirect("/admin/idp?success=" + encodeURIComponent("SSO 设置已保存"));
  };
  app.post("/admin/sso/keycloak", ssoKeycloakLegacy);
  app.post("/admin/idp/keycloak", ssoKeycloakLegacy);

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
        disabledAt: schema.users.disabledAt,
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
    // Last-admin guard: refuse to demote the only remaining admin —
    // otherwise the system ends up with zero admins and recovery
    // requires manual DB surgery (UPDATE users SET is_admin = true...).
    if (target.isAdmin && (await countActiveAdmins()) <= 1) {
      return reply.redirect("/admin/users?error=" + encodeURIComponent("拒绝：这是最后一个管理员，撤销后系统将无人可管理"));
    }
    await db.update(schema.users).set({ isAdmin: !target.isAdmin, updatedAt: new Date() }).where(eq(schema.users.id, id.data));
    await audit(req, me.id, target.isAdmin ? "user.demote_admin" : "user.promote_admin", { targetType: "user", targetId: id.data });
    return reply.redirect("/admin/users?success=" + encodeURIComponent(target.isAdmin ? "已撤销管理员" : "已设为管理员"));
  });

  app.post("/admin/users/:id/toggle-disabled", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/users");
    if (id.data === me.id) {
      return reply.redirect("/admin/users?error=" + encodeURIComponent("不能停用自己的账号"));
    }
    const [target] = await db.select({ disabledAt: schema.users.disabledAt, isAdmin: schema.users.isAdmin, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, id.data)).limit(1);
    if (!target) return reply.redirect("/admin/users?error=" + encodeURIComponent("用户不存在"));
    if (target.disabledAt) {
      await db.update(schema.users).set({ disabledAt: null, updatedAt: new Date() }).where(eq(schema.users.id, id.data));
      await audit(req, me.id, "user.enable", { targetType: "user", targetId: id.data, details: { email: target.email } });
      return reply.redirect("/admin/users?success=" + encodeURIComponent(`已重新启用 ${target.email}`));
    }
    // Last-admin guard: refuse to disable the only remaining admin.
    if (target.isAdmin && (await countActiveAdmins()) <= 1) {
      return reply.redirect("/admin/users?error=" + encodeURIComponent("拒绝：这是最后一个管理员，停用后系统将无人可管理"));
    }
    await db.update(schema.users).set({ disabledAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, id.data));
    // Also kill any live sessions so logout is immediate.
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id.data));
    // And revoke every long-lived credential — API tokens (n8n / Zapier)
    // and app passwords (CalDAV in Apple Calendar) outlive sessions and
    // would otherwise keep working after the disable.
    await revokeAllUserCredentials(id.data);
    // Drop CalDAV auth cache so any iPhone-in-the-wild gets 401
    // within a request instead of waiting 60s for TTL.
    invalidateCalDavAuthCache(id.data);
    await audit(req, me.id, "user.disable", { targetType: "user", targetId: id.data, details: { email: target.email } });
    return reply.redirect("/admin/users?success=" + encodeURIComponent(`已停用 ${target.email}（所有设备已下线，API Token 和应用密码已撤销）`));
  });

  app.post("/admin/users/:id/revoke-sessions", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/users");
    const [target] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, id.data)).limit(1);
    if (!target) return reply.redirect("/admin/users?error=" + encodeURIComponent("用户不存在"));
    const deleted = await db.delete(schema.sessions).where(eq(schema.sessions.userId, id.data)).returning({ id: schema.sessions.id });
    // Kick = nuclear option: also revoke API tokens + app passwords so the
    // user's mobile CalDAV client and n8n workflows stop syncing too.
    await revokeAllUserCredentials(id.data);
    invalidateCalDavAuthCache(id.data);
    await audit(req, me.id, "user.revoke_sessions", { targetType: "user", targetId: id.data, details: { email: target.email, sessionsKilled: deleted.length } });
    return reply.redirect("/admin/users?success=" + encodeURIComponent(`已踢出 ${target.email} 的 ${deleted.length} 个登录会话，并撤销了 API Token / 应用密码`));
  });

  // ---------- Admin audit log ----------
  app.get("/admin/audit", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    const rows = await db
      .select({
        id: schema.adminAuditLog.id,
        action: schema.adminAuditLog.action,
        targetType: schema.adminAuditLog.targetType,
        targetId: schema.adminAuditLog.targetId,
        details: schema.adminAuditLog.details,
        ip: schema.adminAuditLog.ip,
        userAgent: schema.adminAuditLog.userAgent,
        createdAt: schema.adminAuditLog.createdAt,
        actorEmail: schema.users.email,
      })
      .from(schema.adminAuditLog)
      // LEFT JOIN (was INNER) — actorUserId is SET NULL on user delete, and
      // we still want to show those rows ("[已删除用户]" instead of dropping
      // the entry entirely).
      .leftJoin(schema.users, eq(schema.users.id, schema.adminAuditLog.actorUserId))
      .orderBy(desc(schema.adminAuditLog.createdAt))
      .limit(200);
    return reply.view("admin/audit", {
      title: "审计日志 · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/audit",
      entries: rows.map((r) => ({
        ...r,
        createdAtIso: `<time data-tz datetime="${r.createdAt.toISOString()}" data-style="datetime">${r.createdAt.toISOString()}</time>`,
        detailsJson: r.details ? JSON.stringify(r.details, null, 2) : null,
      })),
    });
  });

  // ---------- Backup / restore ----------
  app.get("/admin/backup", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    return reply.view("admin/backup", {
      title: "数据备份 · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/backup",
      bundleVersion: BACKUP_VERSION,
    });
  });

  app.get("/admin/backup/export", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    const bundle = await exportData();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="bywave-backup-${stamp}.json"`);
    return reply.send(JSON.stringify(bundle, null, 2));
  });

  app.post("/admin/backup/import", {
    config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    // multipart: no CSRF cookie reliably — gate on admin status.
    const file = await req.file();
    if (!file) return reply.redirect("/admin/backup?error=" + encodeURIComponent("请选择备份文件"));
    if (file.mimetype && !file.mimetype.toLowerCase().includes("json") && file.mimetype !== "application/octet-stream") {
      return reply.redirect("/admin/backup?error=" + encodeURIComponent("文件类型应为 JSON"));
    }
    const buf = await file.toBuffer();
    if (buf.length === 0) return reply.redirect("/admin/backup?error=" + encodeURIComponent("空文件"));
    if (buf.length > 100 * 1024 * 1024) return reply.redirect("/admin/backup?error=" + encodeURIComponent("文件过大（>100MB）"));

    let bundle: BackupBundle;
    try {
      bundle = JSON.parse(buf.toString("utf8")) as BackupBundle;
    } catch (err) {
      return reply.redirect("/admin/backup?error=" + encodeURIComponent("JSON 解析失败：" + (err instanceof Error ? err.message : "")));
    }
    try {
      const result = await importData(bundle);
      const summary = result.perTable
        .filter((r) => r.inserted > 0 || r.error)
        .map((r) => `${r.table}: ${r.inserted}${r.error ? ` (✗ ${r.error.slice(0, 50)})` : ""}`)
        .join("; ");
      await audit(req, u.id, "backup.restore", {
        details: { totalInserted: result.totalInserted, exportedAt: bundle.exportedAt, sizeBytes: buf.length },
      });
      return reply.redirect("/admin/backup?success=" + encodeURIComponent(
        `恢复完成 —— 共 ${result.totalInserted} 行（${summary}）。建议立即重启服务。`
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await audit(req, u.id, "backup.restore_failed", { details: { error: msg.slice(0, 500) } });
      return reply.redirect("/admin/backup?error=" + encodeURIComponent("恢复失败（已回滚）：" + msg));
    }
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
    // Active (non-revoked) APP device count for the「原生 APP 同步」card.
    const [devCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.devices)
      .where(isNull(schema.devices.revokedAt));
    return reply.view("admin/api", {
      title: "API · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/api",
      apiEnabled: settings.apiEnabled,
      appsEnabled: settings.appsEnabled,
      deviceCount: devCount?.c ?? 0,
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

  // Master switch for the native iOS / Android / desktop APP feature.
  // Flipping off doesn't physically delete `devices` rows — it just
  // makes the auth path refuse them. Re-enable to restore access for
  // every previously-paired device.
  app.post("/admin/apps/toggle", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!verifyCsrf(req, reply)) return;
    const enabled = (req.body as { enabled?: string } | undefined)?.enabled === "on";
    await updateSettings({ appsEnabled: enabled });
    await audit(req, u.id, enabled ? "apps.enable" : "apps.disable", { targetType: "site_settings" });
    return reply.redirect("/admin/api?success=" + encodeURIComponent(enabled ? "原生 APP 同步已启用" : "原生 APP 同步已关闭（已绑定的 APP 立即失效）") + "#apps");
  });

  app.post("/admin/api/tokens", {
    config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
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
    await audit(req, u.id, "api_token.create", {
      targetType: "api_token", targetId: issued.id,
      details: { label: body.data.label, scope: body.data.scope, actsAsUserId: body.data.userId, expiresInDays: body.data.expiresInDays },
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
    await audit(req, u.id, "api_token.revoke", { targetType: "api_token", targetId: id.data });
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
      publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
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
        forceAdminMfa: z.string().optional(),
        embedEnabled: z.string().optional(),
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
      forceAdminMfa: body.data.forceAdminMfa === "on",
      embedEnabled: body.data.embedEnabled === "on",
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
    // Read version from package.json at request time (cheap; ~10ms) so
    // it's accurate even if the process is running pre-restart code.
    let pkgVersion = "0.0.0";
    try {
      const fs = await import("node:fs/promises");
      const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
      pkgVersion = pkg.version || "0.0.0";
    } catch { /* fallthrough */ }
    const remotes = await listRemotes();
    // Detect by host (not just by remote name) — install.sh from Gitee
    // leaves the server with `origin` pointing to gitee.com, not github,
    // so checking `name === "gitee"` would miss it. We want to know
    // "is there any remote pointing at gitee.com / github.com?".
    const hasGitee = remotes.some((r) => r.url.includes("gitee.com"));
    const hasGithub = remotes.some((r) => r.url.includes("github.com"));
    return reply.view("admin/update", {
      title: "系统更新",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      activeNav: "/admin/update",
      remote: pickRemote(),
      remotes,
      hasGitee,
      hasGithub,
      branch: pickBranch(),
      pm2Name: process.env.PM2_PROCESS_NAME || "by-wave-calendar",
      pkgVersion,
      nodeVersion: process.versions.node,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  // Accept an optional `remote` body field on check + apply so the UI
  // can let admins pick GitHub origin vs Gitee mirror per-update. We
  // restrict to remotes that actually exist in the working tree so a
  // malicious admin can't smuggle in arbitrary URLs via this surface.
  async function resolveRemoteParam(req: FastifyRequest): Promise<string> {
    const want = String((req.body as { remote?: string } | undefined)?.remote || "").trim();
    if (!want) return pickRemote();
    const all = await listRemotes();
    if (!all.some((r) => r.name === want)) return pickRemote();
    return want;
  }

  app.post("/admin/update/check", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    try {
      const status = await checkForUpdates(await resolveRemoteParam(req));
      return reply.send({ ok: true, status });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : "未知错误" });
    }
  });

  // Add (or update URL of) a remote. The UI calls this with `name=gitee`
  // when the server doesn't yet have a `gitee` remote configured —
  // server uses the maintained default URL from self_update.ts. Custom
  // URLs are accepted too but locked down to https?:// schemes so we
  // can't be tricked into adding a `file://` remote that escapes the
  // working tree.
  app.post<{ Body: { name?: string; url?: string } }>("/admin/update/add-remote", {
    config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    const name = String(req.body?.name || "").trim();
    const url = String(req.body?.url || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
      return reply.code(400).send({ ok: false, error: "remote 名称不合法（只允许字母/数字/-/_，1-32 字符）" });
    }
    if (url && !/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ ok: false, error: "URL 必须以 http(s):// 开头" });
    }
    const result = await addRemote(name, url || undefined);
    if (!result.ok) {
      return reply.code(500).send({ ok: false, error: result.error || "git remote 操作失败" });
    }
    await audit(req, user.id, "update.add_remote", { details: { name, url: result.url } });
    return reply.send({ ok: true, name, url: result.url });
  });

  // In-memory lock: prevents two admin clicks from running concurrent
  // npm ci / build steps and corrupting the working tree. Released in the
  // finally block — survives crashes only on full process restart, which
  // is fine because pm2 will restart after a real failure.
  let updateInFlight: { startedAt: Date; actorEmail: string } | null = null;

  // Non-streaming fallback (kept for clients that don't support SSE)
  app.post("/admin/update/apply", {
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    if (updateInFlight) {
      return reply.code(409).send({ ok: false, error: `已有更新进行中（由 ${updateInFlight.actorEmail} 于 ${updateInFlight.startedAt.toISOString()} 启动）` });
    }
    updateInFlight = { startedAt: new Date(), actorEmail: user.email };
    const remote = await resolveRemoteParam(req);
    await audit(req, user.id, "update.apply_start", { details: { remote } });
    try {
      const result = await applyUpdate(remote);
      await audit(req, user.id, "update.apply_done", { details: { ok: result.ok, steps: result.logs.length, remote } });
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await audit(req, user.id, "update.apply_failed", { details: { error: msg.slice(0, 500) } });
      return reply.code(500).send({ ok: false, error: msg });
    } finally {
      updateInFlight = null;
    }
  });

  // Streaming variant with per-step progress (Server-Sent Events).
  app.post("/admin/update/apply-stream", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!verifyCsrf(req, reply)) return;
    if (updateInFlight) {
      reply.code(409).send({ ok: false, error: `已有更新进行中（由 ${updateInFlight.actorEmail} 启动）` });
      return;
    }
    updateInFlight = { startedAt: new Date(), actorEmail: user.email };
    const remote = await resolveRemoteParam(req);
    await audit(req, user.id, "update.apply_start_stream", { details: { remote } });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    let finalOk = false;
    try {
      for await (const ev of applyUpdateStream()) {
        write(ev);
        if (ev.type === "final") finalOk = ev.ok;
      }
    } catch (err) {
      write({ type: "final", ok: false, error: err instanceof Error ? err.message : "未知错误" });
    } finally {
      await audit(req, user.id, finalOk ? "update.apply_done" : "update.apply_failed");
      reply.raw.end();
      updateInFlight = null;
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

  // ---------- Outbound webhooks ----------
  // Admin manages a list of "when something happens, POST to this URL"
  // destinations. Delivery is best-effort; failures are logged so the
  // admin can debug from the same page.
  app.get("/admin/webhooks", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    const hooks = await db.select().from(schema.webhooks).orderBy(asc(schema.webhooks.createdAt));
    // Latest 50 deliveries across all hooks, joined with the hook label.
    const recent = await db
      .select({
        id: schema.webhookDeliveries.id,
        eventName: schema.webhookDeliveries.eventName,
        statusCode: schema.webhookDeliveries.statusCode,
        ok: schema.webhookDeliveries.ok,
        attemptCount: schema.webhookDeliveries.attemptCount,
        errorMessage: schema.webhookDeliveries.errorMessage,
        createdAt: schema.webhookDeliveries.createdAt,
        hookLabel: schema.webhooks.label,
      })
      .from(schema.webhookDeliveries)
      .leftJoin(schema.webhooks, eq(schema.webhooks.id, schema.webhookDeliveries.webhookId))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(50);
    return reply.view("admin/webhooks", {
      title: "Webhooks · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/webhooks",
      hooks: hooks.map((h) => ({ ...h, eventsList: Array.isArray(h.events) ? h.events : [] })),
      deliveries: recent.map((d) => ({
        ...d,
        createdAtLocal: localTimeIso(d.createdAt),
      })),
    });
  });

  app.post("/admin/webhooks", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      label: z.string().min(1).max(120),
      url: z.string().url().max(500),
      // Comma-separated list of event names from the form checkboxes.
      events: z.union([z.string(), z.array(z.string())]).optional(),
      secret: z.string().max(200).optional().transform((v) => v?.trim() || null),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/webhooks?error=" + encodeURIComponent("参数无效"));
    const events = Array.isArray(body.data.events)
      ? body.data.events
      : (body.data.events ? [body.data.events] : ["event.created", "event.updated", "event.deleted"]);
    await db.insert(schema.webhooks).values({
      label: body.data.label,
      url: body.data.url,
      events,
      secret: body.data.secret,
    });
    await audit(req, me.id, "webhook.create", { targetType: "webhook", details: { label: body.data.label, url: body.data.url } });
    return reply.redirect("/admin/webhooks?success=" + encodeURIComponent("已添加 Webhook"));
  });

  app.post("/admin/webhooks/:id/toggle", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/webhooks");
    const [hook] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id.data)).limit(1);
    if (!hook) return reply.redirect("/admin/webhooks");
    await db.update(schema.webhooks).set({ enabled: !hook.enabled }).where(eq(schema.webhooks.id, id.data));
    return reply.redirect("/admin/webhooks?success=" + encodeURIComponent(hook.enabled ? "已暂停" : "已启用"));
  });

  app.post("/admin/webhooks/:id/delete", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/webhooks");
    const [hook] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id.data)).limit(1);
    if (!hook) return reply.redirect("/admin/webhooks");
    await db.delete(schema.webhooks).where(eq(schema.webhooks.id, id.data));
    await audit(req, me.id, "webhook.delete", { targetType: "webhook", details: { label: hook.label } });
    return reply.redirect("/admin/webhooks?success=" + encodeURIComponent("已删除"));
  });

  app.post("/admin/webhooks/:id/test", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/webhooks");
    const [hook] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id.data)).limit(1);
    if (!hook) return reply.redirect("/admin/webhooks");
    // Mark not-enabled hooks as still test-able — admins want to verify
    // before turning them on. dispatchWebhook only fires on enabled hooks
    // so we directly enqueue a one-off delivery here instead.
    const { dispatchTestWebhook } = await import("../lib/webhooks.js");
    await dispatchTestWebhook(hook).catch(() => undefined);
    return reply.redirect("/admin/webhooks?success=" + encodeURIComponent("测试请求已发送，下方记录里看结果"));
  });

  // List deliveries for one webhook — full history with payload + response.
  // Admins use this to debug external integration failures.
  app.get("/admin/webhooks/:id/deliveries", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/webhooks");
    const [hook] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id.data)).limit(1);
    if (!hook) return reply.redirect("/admin/webhooks?error=" + encodeURIComponent("Webhook 不存在"));
    const deliveries = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.webhookId, id.data))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(200);
    return reply.view("admin/webhook-deliveries", {
      title: `${hook.label} · Webhook 投递记录 · 管理后台`,
      user: me,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      activeNav: "/admin/webhooks",
      hook,
      deliveries: deliveries.map((d) => ({
        ...d,
        createdAtLocal: d.createdAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
        // Truncate response body in the list view; full body shows in detail.
        responseShort: d.responseBody ? d.responseBody.slice(0, 200) : null,
      })),
    });
  });

  // Manual retry — admin clicks 重试 on a failed delivery after fixing
  // the receiver. Returns to the deliveries page with a flash.
  app.post("/admin/webhooks/:id/deliveries/:deliveryId/retry", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const params = req.params as { id: string; deliveryId: string };
    const dId = z.string().uuid().safeParse(params.deliveryId);
    const hId = z.string().uuid().safeParse(params.id);
    if (!dId.success || !hId.success) return reply.redirect("/admin/webhooks");
    const { retryDelivery } = await import("../lib/webhooks.js");
    const result = await retryDelivery(dId.data);
    const msg = result.ok ? "重试成功" : `重试失败 (HTTP ${result.statusCode ?? "?"})`;
    return reply.redirect(`/admin/webhooks/${hId.data}/deliveries?${result.ok ? "success" : "error"}=${encodeURIComponent(msg)}`);
  });

  // ---------- OAuth 应用管理 ----------
  // 管理员注册第三方应用，给它们一个 client_id + secret，用户授权后
  // 第三方应用可代表用户调用 /api/v1/* (受 scope 限制)。
  app.get("/admin/oauth-apps", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    const apps = await db.select({
      id: schema.oauthClients.id,
      clientId: schema.oauthClients.clientId,
      name: schema.oauthClients.name,
      description: schema.oauthClients.description,
      redirectUris: schema.oauthClients.redirectUris,
      allowedScopes: schema.oauthClients.allowedScopes,
      enabled: schema.oauthClients.enabled,
      createdAt: schema.oauthClients.createdAt,
    }).from(schema.oauthClients).orderBy(asc(schema.oauthClients.createdAt));
    const issuedSecret = typeof (req.query as { secret?: string }).secret === "string" ? (req.query as { secret: string }).secret : null;
    const issuedClientId = typeof (req.query as { cid?: string }).cid === "string" ? (req.query as { cid: string }).cid : null;
    return reply.view("admin/oauth-apps", {
      title: "OAuth 应用 · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/oauth-apps",
      apps: apps.map((a) => ({
        ...a,
        redirectUriList: a.redirectUris.split("\n").map((s) => s.trim()).filter(Boolean),
        scopesList: a.allowedScopes as string[],
        createdAtLocal: localTimeIso(a.createdAt),
      })),
      scopes: OAUTH_SCOPES,
      issuedSecret, issuedClientId,
      baseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
    });
  });

  app.post("/admin/oauth-apps", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(500).optional().transform((s) => s?.trim() || undefined),
      redirectUris: z.string().min(1).max(2000),
      scopes: z.union([z.string(), z.array(z.string())]).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/oauth-apps?error=" + encodeURIComponent("参数无效"));
    const uris = body.data.redirectUris.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    for (const u of uris) {
      try { new URL(u); } catch { return reply.redirect("/admin/oauth-apps?error=" + encodeURIComponent("redirect_uri 不是合法 URL：" + u)); }
    }
    const requestedScopes = Array.isArray(body.data.scopes) ? body.data.scopes : (body.data.scopes ? [body.data.scopes] : ["read:events"]);
    const allowed = requestedScopes.filter((s): s is OAuthScope => s in OAUTH_SCOPES);
    if (allowed.length === 0) return reply.redirect("/admin/oauth-apps?error=" + encodeURIComponent("至少要勾一个 scope"));
    const created = await createOAuthClient({
      name: body.data.name,
      description: body.data.description,
      redirectUris: uris,
      allowedScopes: allowed,
    });
    await audit(req, me.id, "oauth_app.create", { targetType: "oauth_client", targetId: created.id, details: { name: body.data.name } });
    return reply.redirect(`/admin/oauth-apps?secret=${encodeURIComponent(created.clientSecret)}&cid=${encodeURIComponent(created.clientId)}&success=${encodeURIComponent("应用已创建")}`);
  });

  app.post("/admin/oauth-apps/:id/toggle", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/oauth-apps");
    const [app] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, id.data)).limit(1);
    if (!app) return reply.redirect("/admin/oauth-apps");
    await db.update(schema.oauthClients).set({ enabled: !app.enabled }).where(eq(schema.oauthClients.id, id.data));
    await audit(req, me.id, app.enabled ? "oauth_app.disable" : "oauth_app.enable", { targetType: "oauth_client", targetId: id.data });
    return reply.redirect("/admin/oauth-apps?success=" + encodeURIComponent(app.enabled ? "已禁用" : "已启用"));
  });

  app.post("/admin/oauth-apps/:id/delete", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.redirect("/admin/oauth-apps");
    const [app] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, id.data)).limit(1);
    if (!app) return reply.redirect("/admin/oauth-apps");
    // Cascade will drop authorization_codes and access_tokens.
    await db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, id.data));
    await audit(req, me.id, "oauth_app.delete", { targetType: "oauth_client", details: { name: app.name } });
    return reply.redirect("/admin/oauth-apps?success=" + encodeURIComponent("应用已删除（已撤销所有访问令牌）"));
  });

  void asc;
}
