import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { asc, desc, eq, sql } from "drizzle-orm";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { loadSession } from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { getSettings, updateSettings } from "../lib/site_settings.js";

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
    const settings = await getSettings();
    return reply.view("admin/sso", {
      title: "SSO · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req), settings,
    });
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

    const allowed = new Map<string, string>([
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/jpg", "jpg"],
      ["image/svg+xml", "svg"],
      ["image/webp", "webp"],
    ]);
    const ext = allowed.get(file.mimetype.toLowerCase());
    if (!ext) return reply.redirect("/admin/logo?error=" + encodeURIComponent("仅支持 PNG / JPG / SVG / WEBP"));

    const uploadsDir = path.join(process.cwd(), "src", "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const buf = await file.toBuffer();
    if (buf.length > 2 * 1024 * 1024) {
      return reply.redirect("/admin/logo?error=" + encodeURIComponent("文件超过 2MB"));
    }

    const filename = `logo.${ext}`;
    await writeFile(path.join(uploadsDir, filename), buf);

    // Cache-bust by appending mtime stamp
    const url = `/static/uploads/${filename}?v=${Date.now()}`;
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
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt));
    return reply.view("admin/users", {
      title: "用户管理",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      users: rows,
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

  void asc;
}
