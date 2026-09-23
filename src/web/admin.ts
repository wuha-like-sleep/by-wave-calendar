import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { mkdir, writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { loadSession } from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { bumpCaldavSyncEpoch, getSettings, updateSettings } from "../lib/site_settings.js";
import { CAPTCHA_PROVIDERS, isCaptchaProvider, isBuiltinMode } from "../lib/captcha/index.js";
import { sendMail } from "../lib/mailer.js";
import {
  calendarInviteMail,
  inviteSignupMail,
  loginAlertMail,
  passwordResetMail,
  verificationCodeMail,
  welcomeMail,
  EMAIL_PREVIEW_TEMPLATES,
  renderPreviewHtml,
  normalizeHexColor,
} from "../lib/email_templates.js";
import { createInvite, listInvites, revokeInvite, validateInvite } from "../lib/signup_invite.js";
import { likeNeedle } from "../lib/search_query.js";
import { normalizeBimiSvg, bimiDnsRecord } from "../lib/bimi.js";
import { addRemote, applyUpdate, applyUpdateStream, applyUploadedUpdate, checkForUpdates, listRemotes, MAX_UPLOAD_BYTES, pickBranch, pickRemote, restartProcess } from "../lib/self_update.js";
import { createProvider, deleteProvider, getProviderById, listAllProviders, updateProvider } from "../lib/sso_providers.js";
import { createApiToken, listAllApiTokens, revokeApiTokenAdmin, rotateApiToken } from "../lib/api_token.js";
import { exportData, importData, BACKUP_VERSION, type BackupBundle } from "../lib/backup.js";
import { audit } from "../lib/audit.js";
import { listEnabledProvidersPublic } from "../lib/sso_providers.js";
import { revokeAllUserCredentials, countActiveAdmins } from "../lib/user_state.js";
import { invalidateCalDavAuthCache, getCalDavAuthCacheStats } from "../lib/caldav_auth.js";
import { getCalDavThrottleStats } from "../lib/caldav_throttle.js";
import { createOAuthClient, OAUTH_SCOPES, type OAuthScope } from "../lib/oauth_server.js";
import { tForRequest } from "../lib/i18n.js";
// 配额窗口的起点从建号收口函数里拿,不在这里重算。后台「今天已建 N 个」这个
// 数字必须跟真正拦人的那道闸门用同一个窗口,否则管理员看到的 N 和刹车实际
// 数的 N 不是一回事,他会以为闸门坏了。
import { startOfQuotaDay } from "../lib/account_provisioning.js";

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

// Lightweight <time data-tz> wrapper; the client-side local-time.js reformats
// to the visitor's browser TZ on load.
//
// 提到模块作用域:它原来声明在 adminRoutes 中段,后面的路由用着没事,
// 前面的路由用它就得靠「回调比声明晚执行」这个巧合成立 —— 一眼看不出来的雷。
const localTimeIso = (d: Date) => `<time data-tz datetime="${d.toISOString()}" data-style="datetime">${d.toISOString()}</time>`;

/** 请求内翻译,给 flash / 页面标题用。口径跟 web/sso.ts 的 tr() 一致。 */
function tr(req: FastifyRequest, key: string, vars?: Record<string, string | number>): string {
  return tForRequest(req)(key, vars);
}

// ---------------------------------------------------------------------------
// CalDAV 同步纪元(site_settings.caldav_sync_epoch)的人话版本
// ---------------------------------------------------------------------------

export type CaldavEpochView = {
  /** 库里那一列的原样取值。页面上照原样显示,不做任何美化。 */
  raw: string;
  /** none = 从来没被 bump 过;manual = 后台按钮写的;release = 随版本更新写的。 */
  kind: "none" | "manual" | "release";
  /** 只有 manual 能解析出时间;其余为 null。 */
  atIso: string | null;
};

/**
 * 把纪元那一列翻译成「谁、什么时候动的」。
 *
 * 为什么要有这个:按钮按下去以后**唯一**能证明它真的生效的东西,就是这一列
 * 变了。页面上不摆出来的话,站长按完看到一句「已发出」就走了,而真出问题时
 * (库没写进去 / 写了个和原来一样的值)他这边一模一样,什么都看不出来 ——
 * 这个仓库最常见的失效形态就是这种。
 *
 * 取值的两种来源见 src/lib/site_settings.ts 的 bumpCaldavSyncEpoch(手动,
 * `manual:<ISO>:<随机十六进制>`)和 drizzle/migrations 里的迁移(版本字面量,
 * 如 `2026-09-21-alarm-vevent`)。这里只认得出手动那一种的时间,别的来源
 * 一律当「随版本更新写的」——猜错来源比不猜更糟。
 */
export function describeCaldavEpoch(raw: string): CaldavEpochView {
  if (raw === "") return { raw, kind: "none", atIso: null };
  // ISO 串自己带冒号,所以不能按 ":" 切 —— 贪婪匹配吃到最后一个冒号为止。
  const m = raw.match(/^manual:(.+):([0-9a-f]+)$/);
  if (!m) return { raw, kind: "release", atIso: null };
  const at = new Date(m[1]!);
  // 时间解析不出来不代表这不是手动写的:来源判断和时间显示是两件事,
  // 混在一起的话一个坏时间戳会把「这是谁按的」也一起弄丢。
  return { raw, kind: "manual", atIso: Number.isNaN(at.getTime()) ? null : at.toISOString() };
}

// ---------------------------------------------------------------------------
// 账号来源(users.signup_source)
// ---------------------------------------------------------------------------

/**
 * 这一列只有建号收口函数(src/lib/account_provisioning.ts)写,取值是
 * self / invite / sso:<slug> / idp:<client> / apple / admin。
 *
 * **NULL 是「未知」,绝不是 self。** 这一列是这一版才加的,存量行全是 NULL 且
 * 明确不回填猜测值。把 NULL 归进 self 那一桶的话,管理员在筛选里选「自己注册」
 * 再点批量停用,一下就把升级之前的所有老用户全停了 —— 那正是他最不想发生的事。
 * 所以未知在筛选下拉里是独立选项,在汇总表里是独立一行。
 */
export type SignupSourceKind = "unknown" | "self" | "invite" | "sso" | "idp" | "apple" | "admin" | "other";

export type SignupSourceView = {
  /** 原始列值;未知来源是 null。 */
  raw: string | null;
  /** 筛选下拉 / URL 里的取值。未知来源固定 "unknown" —— 它不是 signup_source
   *  的合法取值,所以不会跟任何真实来源撞。 */
  key: string;
  kind: SignupSourceKind;
  /** sso 的 slug、idp 的 client_id;其余为 null。 */
  detail: string | null;
  /** 徽章配色。整串写死在 .ts 里(admin.ts 在 tailwind content globs 内),
   *  拼出来的 class 会被 purge 掉 —— 审计页那段注释踩过同一个坑。 */
  badge: string;
};

export function signupSourceView(raw: string | null | undefined): SignupSourceView {
  const v = (raw ?? "").trim();
  if (!v) return { raw: null, key: "unknown", kind: "unknown", detail: null, badge: "bg-slate-100 text-slate-600" };
  const sep = v.indexOf(":");
  const head = sep >= 0 ? v.slice(0, sep) : v;
  const detail = sep >= 0 ? v.slice(sep + 1).trim() || null : null;
  switch (head) {
    case "self": return { raw: v, key: v, kind: "self", detail: null, badge: "bg-slate-100 text-slate-700" };
    case "invite": return { raw: v, key: v, kind: "invite", detail: null, badge: "bg-teal-100 text-teal-700" };
    case "sso": return { raw: v, key: v, kind: "sso", detail, badge: "bg-violet-100 text-violet-700" };
    case "idp": return { raw: v, key: v, kind: "idp", detail, badge: "bg-amber-100 text-amber-700" };
    case "apple": return { raw: v, key: v, kind: "apple", detail: null, badge: "bg-sky-100 text-sky-700" };
    case "admin": return { raw: v, key: v, kind: "admin", detail: null, badge: "bg-indigo-100 text-indigo-700" };
    // 不认识的取值原样显示,**不当成 self**。以后新增一种来源而后台还没跟上时,
    // 它至少还是自己独立的一桶,不会被针对 self 的批量操作顺手扫掉。
    default: return { raw: v, key: v, kind: "other", detail: null, badge: "bg-slate-100 text-slate-600" };
  }
}

export type SignupSourceFilter =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "exact"; value: string };

/** URL 上的 ?source= 解析成筛选条件。 */
export function signupSourceFilter(raw: string | null | undefined): SignupSourceFilter {
  const v = (raw ?? "").trim().slice(0, 120);
  if (!v) return { kind: "none" };
  // "unknown" 必须变成「这一列是空的」,**不能**变成按字面量 'unknown' 相等比较:
  // 没有任何一行是这个值,结果会是一张空表,而管理员读到的意思是
  // 「升级之前的老账号一个都没有」—— 一条不报错的假消息。
  if (v === "unknown") return { kind: "unknown" };
  return { kind: "exact", value: v };
}

// ---------------------------------------------------------------------------
// 批量停用的名单计算
// ---------------------------------------------------------------------------

export type BulkDisableRow = { id: string; email: string; isAdmin: boolean; disabled: boolean };
export type BulkDisableSkipReason = "not_found" | "self" | "already_disabled" | "last_admin";
export type BulkDisableSkip = { id: string; email: string; reason: BulkDisableSkipReason };
export type BulkDisablePlan = { disable: BulkDisableRow[]; skipped: BulkDisableSkip[] };

/**
 * 算出这一批里哪些真的会被停用、哪些跳过以及为什么。
 *
 * 单独拎成纯函数,是因为它是这次唯一一处「一个动作作用在多行上」的地方,
 * 而所有守卫(不能停自己、不能把最后一个管理员停掉)原来都是照着单行写的。
 */
export function planBulkDisable(input: {
  requestedIds: string[];
  rows: BulkDisableRow[];
  actorId: string;
  activeAdminCount: number;
}): BulkDisablePlan {
  const byId = new Map(input.rows.map((r) => [r.id, r]));
  const disable: BulkDisableRow[] = [];
  const skipped: BulkDisableSkip[] = [];
  // 这一批里最多还能停掉几个管理员。系统至少要留一个能用的管理员,留不住就
  // 只能上数据库手改 is_admin 才能救回来。
  //
  // 为什么要按整批扣额度,而不是逐行问一次「这是不是最后一个管理员」:一次
  // 勾中两个管理员、系统正好只有这两个,逐行看**每一行都不是**最后一个,
  // 于是两行都放行,做完就是零个管理员。单行那条守卫在批量语境里天然是错的。
  let adminBudget = Math.max(0, input.activeAdminCount - 1);
  const seen = new Set<string>();
  for (const id of input.requestedIds) {
    // 同一个 id 在表单里出现两次(勾选框被复制、或者手工构造的请求)不该
    // 在结果里算两次,更不该把管理员额度扣两次。
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (!row) { skipped.push({ id, email: "", reason: "not_found" }); continue; }
    if (id === input.actorId) { skipped.push({ id, email: row.email, reason: "self" }); continue; }
    // 已经停用的不重复停:重复停会把 disabled_at 刷成今天,管理员再也查不到
    // 这个号当初是什么时候被停的。
    if (row.disabled) { skipped.push({ id, email: row.email, reason: "already_disabled" }); continue; }
    if (row.isAdmin) {
      if (adminBudget <= 0) { skipped.push({ id, email: row.email, reason: "last_admin" }); continue; }
      adminBudget -= 1;
    }
    disable.push(row);
  }
  return { disable, skipped };
}

/**
 * 停用一个账号。**整个后台只有这一份停用实现** —— 单个停用和批量停用都走它。
 *
 * 这个仓库在封禁上吃过亏:判定和动作散在多处,就一定有某一处漏掉其中一步
 * (会话删了但 API Token 还在、CalDAV 缓存没清)。多一条路径就多一次漏的机会。
 * 新增任何「停用」入口都必须调这里,不要把下面这几行复制过去。
 */
async function disableUserAccount(
  req: FastifyRequest,
  actorId: string,
  target: { id: string; email: string },
  auditDetails: Record<string, unknown> = {},
): Promise<void> {
  await db.update(schema.users).set({ disabledAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, target.id));
  // 会话是不透明 blob,没法标记撤销,只能直接删。
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, target.id));
  // API Token(n8n / Zapier)和应用密码(Apple 日历里的 CalDAV)活得比会话长,
  // 不撤的话人被停用了、机器还在照常同步。
  await revokeAllUserCredentials(target.id);
  // CalDAV 鉴权有 60s 缓存,不清的话在外面那台 iPhone 还能再同步一分钟。
  invalidateCalDavAuthCache(target.id);
  await audit(req, actorId, "user.disable", {
    targetType: "user", targetId: target.id, details: { email: target.email, ...auditDetails },
  });
}

/**
 * 批量操作做完回到哪里 —— 带上原来的筛选条件,别把人甩回没筛过的全量列表。
 *
 * 只认 q 和 source 两个字段,自己重新拼 query string:直接把表单回传的
 * 整串 query 接到 Location 上的话,那串是浏览器交回来的,里面的 & # ? 会
 * 改变这条 URL 的结构。重拼一遍,回来的东西就只能是这两个参数。
 */
function bulkBackTo(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const q = typeof body.q === "string" ? body.q.trim().slice(0, 100) : "";
  const source = typeof body.source === "string" ? body.source.trim().slice(0, 120) : "";
  if (q) params.set("q", q);
  if (source) params.set("source", source);
  const qs = params.toString();
  return "/admin/users?" + (qs ? `${qs}&` : "");
}

/** 表单里重复的 name 可能是单值也可能是数组;统一成去重后的 uuid 列表。 */
function normalizeUserIds(raw: unknown, cap = 500): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!z.string().uuid().safeParse(id).success) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 导入备份的大小上限。
 *
 * 为什么不是 100MB(路由里原来写的那个数字):这条路要把整份 JSON
 * **读进内存**(toBuffer,峰值 2× 文件),再 JSON.parse 成 JS 对象
 * (又是几倍的内存)。而 deploy 的 PM2 配置是 max_memory_restart 512M、
 * 单进程 —— 100MB 的备份在 parse 那一步就会把进程打掉,表现是
 * 「导到一半站挂了」,比干脆拒绝还糟。
 *
 * 64MB 是能活下来的量级。真有人撞到这个上限,正确的解法是把导入改成
 * 流式解析(落临时文件 + 逐表读),而不是把这个数字调大。
 */
export const MAX_BACKUP_IMPORT_BYTES = 64 * 1024 * 1024;

export async function adminRoutes(app: FastifyInstance) {
  // Overview / settings dashboard
  app.get("/admin", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
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
      // CalDAV 认证失败节流。修之前「正在被撞库」这件事在服务端是完全
      // 不可见的 —— 没有失败计数、没有锁定、没有审计,只有缓存命中率
      // 会莫名变低。这两个数就是拿来看这件事的。
      caldavThrottle: getCalDavThrottleStats(),
    });
  });

  // Section pages
  app.get("/admin/site", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    const settings = await getSettings();
    return reply.view("admin/site", {
      title: "站点设置 · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req), settings,
    });
  });

  app.get("/admin/logo", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    const settings = await getSettings();
    return reply.view("admin/logo", {
      title: "Logo · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req), settings,
    });
  });

  app.get("/admin/smtp", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    const settings = await getSettings();
    // BIMI section: resolve the active logo (admin-uploaded → bundled default),
    // build the absolute URL the DNS record must point at (stable, no cache-bust),
    // and a separate preview URL (cache-busted so the admin sees fresh uploads).
    const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const hasCustomBimi = Boolean(settings.bimiSvgUrl);
    const bimiPath = settings.bimiSvgUrl || "/static/bimi/logo.svg";
    const bimiSvgUrl = `${base}${bimiPath}`;
    const bimi = {
      hasCustom: hasCustomBimi,
      svgUrl: bimiSvgUrl,
      previewUrl: hasCustomBimi ? `${bimiPath}?v=${Date.now()}` : bimiPath,
      vmcUrl: settings.bimiVmcUrl,
      record: bimiDnsRecord({ fromAddress: settings.mailFromAddress, svgUrl: bimiSvgUrl, vmcUrl: settings.bimiVmcUrl }),
      // Storage transparency: the bundled default ships with the install; an
      // admin-uploaded SVG is written to the server's local uploads dir.
      defaultUrl: `${base}/static/bimi/logo.svg`,
      uploadDiskPath: "src/public/uploads/bimi.svg",
    };
    return reply.view("admin/smtp", {
      title: "SMTP 邮件 · 管理后台",
      user, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req), settings, bimi,
    });
  });

  // ---------- BIMI inbox-avatar logo ----------
  // Upload a BIMI-compliant SVG. multipart → no reliable CSRF cookie; gate on admin.
  app.post("/admin/bimi/logo", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    const file = await req.file();
    if (!file) return reply.redirect("/admin/smtp?error=" + encodeURIComponent("请选择 SVG 文件") + "#bimi");
    const isSvg = file.mimetype.toLowerCase().includes("svg") || /\.svg$/i.test(file.filename || "");
    if (!isSvg) {
      return reply.redirect("/admin/smtp?error=" + encodeURIComponent("BIMI logo 必须是 SVG（矢量）文件，位图无法用于 BIMI") + "#bimi");
    }
    const buf = await file.toBuffer();
    if (buf.length > 64 * 1024) {
      return reply.redirect("/admin/smtp?error=" + encodeURIComponent("文件过大") + "#bimi");
    }
    const settings = await getSettings();
    const result = normalizeBimiSvg(buf.toString("utf8"), { title: settings.siteName });
    if (!result.ok) {
      return reply.redirect("/admin/smtp?error=" + encodeURIComponent("SVG 不符合 BIMI 规范：" + result.errors.join("；")) + "#bimi");
    }
    const uploadsDir = path.join(process.cwd(), "src", "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, "bimi.svg"), result.svg, "utf8");
    await updateSettings({ bimiSvgUrl: "/static/uploads/bimi.svg" });
    const note = result.normalized ? `（已自动补全 ${result.notes.join("、")}）` : "";
    return reply.redirect("/admin/smtp?success=" + encodeURIComponent("BIMI logo 已上传" + note) + "#bimi");
  });

  app.post("/admin/bimi/logo/delete", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    const p = path.join(process.cwd(), "src", "public", "uploads", "bimi.svg");
    await unlink(p).catch(() => undefined);
    await updateSettings({ bimiSvgUrl: null });
    return reply.redirect("/admin/smtp?success=" + encodeURIComponent("已恢复为内置默认 logo") + "#bimi");
  });

  app.post("/admin/bimi/vmc", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({ vmcUrl: z.string().max(500).optional() }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/smtp?error=" + encodeURIComponent("参数无效") + "#bimi");
    const raw = (body.data.vmcUrl || "").trim();
    if (raw && !/^https:\/\//i.test(raw)) {
      return reply.redirect("/admin/smtp?error=" + encodeURIComponent("VMC 证书 URL 必须以 https:// 开头") + "#bimi");
    }
    await updateSettings({ bimiVmcUrl: raw || null });
    return reply.redirect("/admin/smtp?success=" + encodeURIComponent("已保存证书地址") + "#bimi");
  });

  // SSO management. Dual-registered at /admin/sso and /admin/idp because
  // 宝塔 WAF blocks the "sso" substring outright (returns 444). /admin/idp
  // is the working path; /admin/sso kept around for users who whitelist
  // the original. All internal redirects target /admin/idp so the post-
  // submit URL never hits the WAF.
  const ssoIndex = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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

  // -------- 网站默认语言 -------- (site-wide; user-level overrides)
  // "auto" = resolve from browser Accept-Language. Any locale code
  // must be in SITE_LOCALE_OPTIONS (= "auto" plus every entry in
  // LOCALES). Surfaces in install.sh too via .env seed.
  app.post("/admin/site/locale", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const { isValidSiteLocale } = await import("../lib/i18n.js");
    const body = z.object({ defaultLocale: z.string().max(20) }).safeParse(req.body);
    if (!body.success || !isValidSiteLocale(body.data.defaultLocale)) {
      return reply.redirect("/admin/site?error=" + encodeURIComponent("不支持的语言"));
    }
    await updateSettings({ defaultLocale: body.data.defaultLocale });
    await audit(req, u.id, "site.locale.update", { targetType: "site_settings", details: { locale: body.data.defaultLocale } });
    return reply.redirect("/admin/site#language");
  });

  app.post("/admin/smtp", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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

  // ---------- Merge duplicate accounts ----------
  // Dry-run preview: resolve both refs and show what would move. Read-only.
  app.get<{ Querystring: { source?: string; target?: string } }>("/admin/users/merge", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    const { resolveUserRef, mergeSummary, mergeDeleteCounts } = await import("../lib/account_merge.js");
    const source = await resolveUserRef(req.query.source || "");
    const target = await resolveUserRef(req.query.target || "");
    let summary: Awaited<ReturnType<typeof mergeSummary>> | null = null;
    let deleteCounts: Awaited<ReturnType<typeof mergeDeleteCounts>> | null = null;
    let error: string | null = null;
    if (!req.query.source && !req.query.target) {
      error = null; // initial blank form
    } else if (!source || !target) {
      error = "源账号或目标账号未找到（用邮箱或用户 ID）";
    } else if (source.id === target.id) {
      error = "源账号和目标账号相同";
    } else if (source.isAdmin) {
      error = "源账号是管理员，不允许被合并（请先取消其管理员身份）";
    } else {
      summary = await mergeSummary(source.id);
      deleteCounts = await mergeDeleteCounts(source.id);
    }
    return reply.view("admin/merge", {
      title: "合并账号 · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/users",
      sourceInput: req.query.source || "",
      targetInput: req.query.target || "",
      source, target, summary, deleteCounts, error,
    });
  });

  app.post("/admin/users/merge", {
    config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/users?error=" + encodeURIComponent("参数无效"));
    const { mergeAccounts } = await import("../lib/account_merge.js");
    const res = await mergeAccounts(body.data.sourceId, body.data.targetId);
    if (!res.ok) return reply.redirect("/admin/users/merge?error=" + encodeURIComponent(res.error));
    await audit(req, u.id, "account.merge", {
      targetType: "user", targetId: body.data.targetId,
      details: { source: body.data.sourceId, ...res.summary },
    });
    return reply.redirect("/admin/users?success=" + encodeURIComponent("账号已合并，源账号已删除"));
  });

  app.get<{ Querystring: { q?: string; source?: string } }>("/admin/users", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    // Read-only filter: find a user by email / display name. Escaped + capped.
    const q = (typeof req.query?.q === "string" ? req.query.q : "").trim().slice(0, 100);
    const qClause = q
      ? or(ilike(schema.users.email, likeNeedle(q)), ilike(schema.users.displayName, likeNeedle(q)))
      : undefined;
    const srcFilter = signupSourceFilter(req.query?.source);
    const srcClause =
      srcFilter.kind === "unknown"
        // 未知 = 这一列没有值。存量行是 NULL,但真要有人手工写进去一个空串,
        // 他在后台看到的也是「未知」那一行,筛选就得能把它一起捞出来。
        ? sql`coalesce(${schema.users.signupSource}, '') = ''`
        : srcFilter.kind === "exact"
          ? eq(schema.users.signupSource, srcFilter.value)
          : undefined;
    // and() 会自己丢掉 undefined,两个都没有时返回 undefined。
    const whereClause = and(qClause, srcClause);
    // Totals for the header summary (reflect the whole base, not the filter).
    const countRows = await db
      .select({
        total: sql<number>`count(*)::int`,
        admins: sql<number>`count(*) filter (where ${schema.users.isAdmin})::int`,
        disabled: sql<number>`count(*) filter (where ${schema.users.disabledAt} is not null)::int`,
      })
      .from(schema.users);
    const stats = {
      total: Number(countRows[0]?.total ?? 0),
      admins: Number(countRows[0]?.admins ?? 0),
      disabled: Number(countRows[0]?.disabled ?? 0),
    };
    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        isAdmin: schema.users.isAdmin,
        emailVerified: schema.users.emailVerified,
        mfaEnabled: schema.users.mfaEnabled,
        ssoProviderSlug: schema.users.ssoProviderSlug,
        signupSource: schema.users.signupSource,
        disabledAt: schema.users.disabledAt,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(whereClause)
      .orderBy(desc(schema.users.createdAt));
    // 筛选下拉的选项:库里真实出现过的来源 + 各自多少个。统计的是**全量**,
    // 不跟着当前筛选走 —— 下拉自己被自己筛过之后就只剩当前那一项,人就出不去了。
    const srcCountRows = await db
      .select({ src: schema.users.signupSource, c: sql<number>`count(*)::int` })
      .from(schema.users)
      .groupBy(schema.users.signupSource);
    const srcOptionMap = new Map<string, { key: string; kind: SignupSourceKind; detail: string | null; raw: string | null; count: number }>();
    for (const row of srcCountRows) {
      const v = signupSourceView(row.src);
      const prev = srcOptionMap.get(v.key);
      // NULL 和空串在 group by 里是两行,在界面上是同一个「未知」桶,这里合并。
      if (prev) prev.count += Number(row.c);
      else srcOptionMap.set(v.key, { key: v.key, kind: v.kind, detail: v.detail, raw: v.raw, count: Number(row.c) });
    }
    const sourceOptions = [...srcOptionMap.values()].sort((a, b) => b.count - a.count);
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
      activeNav: "/admin/users",
      users: rows.map((r) => ({
        ...r,
        passkeyCount: passkeyMap.get(r.id) ?? 0,
        lastLoginMethod: methodMap.get(r.id) ?? null,
        source: signupSourceView(r.signupSource),
      })),
      query: q,
      sourceFilter: srcFilter.kind === "none" ? "" : srcFilter.kind === "unknown" ? "unknown" : srcFilter.value,
      sourceOptions,
      stats,
    });
  });

  app.post("/admin/users/:id/toggle-admin", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return reply;
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
    if (!me) return reply;
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
    await disableUserAccount(req, me.id, { id: id.data, email: target.email });
    return reply.redirect("/admin/users?success=" + encodeURIComponent(`已停用 ${target.email}（所有设备已下线，API Token 和应用密码已撤销）`));
  });

  // ---------- 批量停用 ----------
  // 两步:先 POST 到这里出一张确认页(列清楚谁会被停、谁被跳过和为什么),
  // 确认页再 POST 到 /apply 真的执行。
  //
  // 为什么不做成「点一下 + 前端弹窗」:弹窗是 JS 的事,CSP 挡掉脚本、脚本 404、
  // 或者有人直接构造一个 POST,都能绕过去 —— 而这个动作会把一批人锁在门外。
  // 服务端多一页,确认这一步就不依赖任何前端。
  //
  // 另外:两步都只接受**显式勾选的 id**,不接受「把当前筛选的全停掉」。
  // 筛选条件写错是看不出来的,按 id 停最多错几个人,按筛选停能一次清空全站。
  const bulkDisablePlanFor = async (requestedIds: string[], actorId: string) => {
    const rows = requestedIds.length === 0 ? [] : await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        isAdmin: schema.users.isAdmin,
        disabledAt: schema.users.disabledAt,
        signupSource: schema.users.signupSource,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, requestedIds));
    const sourceById = new Map(rows.map((r) => [r.id, signupSourceView(r.signupSource)]));
    const plan = planBulkDisable({
      requestedIds,
      rows: rows.map((r) => ({ id: r.id, email: r.email, isAdmin: r.isAdmin, disabled: r.disabledAt !== null })),
      actorId,
      activeAdminCount: await countActiveAdmins(),
    });
    return { plan, sourceById };
  };

  app.post("/admin/users/bulk-disable", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = normalizeUserIds(body.userIds);
    const back = bulkBackTo(body);
    if (ids.length === 0) {
      return reply.redirect(back + "error=" + encodeURIComponent(tr(req, "adminUsers.bulk.nothingSelected")));
    }
    const { plan, sourceById } = await bulkDisablePlanFor(ids, me.id);
    return reply.view("admin/users-bulk-disable", {
      title: tr(req, "adminUsers.bulk.confirmTitle"),
      user: me, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/users",
      plan,
      sourceById,
      backQ: typeof body.q === "string" ? body.q.slice(0, 100) : "",
      backSource: typeof body.source === "string" ? body.source.slice(0, 120) : "",
    });
  });

  app.post("/admin/users/bulk-disable/apply", {
    config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = normalizeUserIds(body.userIds);
    const back = bulkBackTo(body);
    if (ids.length === 0) {
      return reply.redirect(back + "error=" + encodeURIComponent(tr(req, "adminUsers.bulk.nothingSelected")));
    }
    // 名单在这里**重算一遍**,不采信确认页传回来的任何判定结果。确认页上
    // 那些隐藏字段是浏览器交回来的,只能当「他想停这几个 id」用;
    // 「能不能停」必须现在这一刻按库里的状态重新判 —— 中间可能已经有别的
    // 管理员被停用了,最后一个管理员那条守卫是会变的。
    const { plan } = await bulkDisablePlanFor(ids, me.id);
    if (plan.disable.length === 0) {
      return reply.redirect(back + "error=" + encodeURIComponent(tr(req, "adminUsers.bulk.noneEligible")));
    }
    for (const row of plan.disable) {
      // 逐个走同一个停用函数:每个人都会各自留一条 user.disable 审计行,
      // 跟单个停用长得一模一样 —— 审计页按 targetId 查一个人的时候,不会因为
      // 「当时是批量做的」就查不到。
      await disableUserAccount(req, me.id, row, { bulk: true });
    }
    // 再补一条汇总行,回答「这一批是谁、什么时候、一次点了多少个」。
    // 邮箱只留前 50 个:这条 details 是 jsonb,一次勾几百人会把审计页撑爆。
    await audit(req, me.id, "user.bulk_disable", {
      targetType: "user",
      details: {
        disabled: plan.disable.length,
        skipped: plan.skipped.length,
        emails: plan.disable.slice(0, 50).map((r) => r.email),
        truncated: plan.disable.length > 50,
        skippedReasons: plan.skipped.map((s) => s.reason),
      },
    });
    return reply.redirect(back + "success=" + encodeURIComponent(
      tr(req, "adminUsers.bulk.done", { n: plan.disable.length, skipped: plan.skipped.length }),
    ));
  });

  app.post("/admin/users/:id/revoke-sessions", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return reply;
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

  // ---------- 开通记录(账号是从哪条路进来的) ----------
  //
  // 这一页回答的就是那个最初的问题:后台多出一堆不认识的账号,是谁建的。
  // 在这之前只能一行一行点开审计详情看,而懒建号根本不经过后台操作、
  // 审计里压根没有对应的行。
  app.get("/admin/signups", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    const settings = await getSettings();

    // 「从未登录过」的判据:login_events 里一条都没有。
    //
    // users 上没有 last_login_at 这种列,登录是往 login_events 记一行
    // (src/lib/login_history.ts)。用 distinct 子查询左连接,而不是在
    // count(*) filter 里塞相关子查询 —— 后者的可用性在不同 PG 版本上不好保证。
    const loggedIn = db
      .selectDistinct({ userId: schema.loginEvents.userId })
      .from(schema.loginEvents)
      .as("logged_in");

    const rows = await db
      .select({
        src: schema.users.signupSource,
        total: sql<number>`count(*)::int`,
        firstAt: sql<Date>`min(${schema.users.createdAt})`,
        lastAt: sql<Date>`max(${schema.users.createdAt})`,
        neverLoggedIn: sql<number>`count(*) filter (where ${loggedIn.userId} is null)::int`,
        disabled: sql<number>`count(*) filter (where ${schema.users.disabledAt} is not null)::int`,
      })
      .from(schema.users)
      .leftJoin(loggedIn, eq(loggedIn.userId, schema.users.id))
      .groupBy(schema.users.signupSource);

    type Group = {
      view: SignupSourceView;
      total: number;
      firstAt: Date | null;
      lastAt: Date | null;
      neverLoggedIn: number;
      disabled: number;
    };
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const view = signupSourceView(r.src);
      const first = r.firstAt ? new Date(r.firstAt) : null;
      const last = r.lastAt ? new Date(r.lastAt) : null;
      const prev = groups.get(view.key);
      if (!prev) {
        groups.set(view.key, {
          view, total: Number(r.total), firstAt: first, lastAt: last,
          neverLoggedIn: Number(r.neverLoggedIn), disabled: Number(r.disabled),
        });
        continue;
      }
      // NULL 和空串在 group by 里是两行,在这一页上是同一个「未知」桶。
      prev.total += Number(r.total);
      prev.neverLoggedIn += Number(r.neverLoggedIn);
      prev.disabled += Number(r.disabled);
      if (first && (!prev.firstAt || first < prev.firstAt)) prev.firstAt = first;
      if (last && (!prev.lastAt || last > prev.lastAt)) prev.lastAt = last;
    }
    const list = [...groups.values()].sort((a, b) => b.total - a.total);

    // 今天已经建了几个 —— 跟每日配额那道闸门用的是同一个窗口函数。
    const [todayRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(gte(schema.users.createdAt, startOfQuotaDay(new Date())));

    return reply.view("admin/signups", {
      title: tr(req, "adminSignups.title"),
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/signups",
      groups: list.map((g) => ({
        ...g,
        firstAtIso: g.firstAt ? localTimeIso(g.firstAt) : null,
        lastAtIso: g.lastAt ? localTimeIso(g.lastAt) : null,
      })),
      gates: {
        registrationMode: settings.registrationMode,
        domainAllowlist: settings.signupDomainAllowlist,
        dailyQuota: settings.signupDailyQuota,
        createdToday: Number(todayRow?.c ?? 0),
      },
    });
  });

  // 注册闸门(邮箱域名白名单 + 每日建号上限)。表单在 /admin/site。
  // 这两项跟注册模式一样,对**所有**建号入口生效 —— 网页表单、JSON 接口、
  // SSO、外部 IdP 懒建号、苹果登录,全都从同一个收口函数过。
  app.post("/admin/signup-gates", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      signupDomainAllowlist: z.string().max(4000).optional(),
      signupDailyQuota: z.string().max(12).optional(),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.redirect("/admin/site?error=" + encodeURIComponent(tr(req, "adminSite.gates.invalid")) + "#signup-gates");
    }
    // 切分口径跟 external_idp 的 parseClientList / 收口函数的 emailDomainAllowed
    // 一致(逗号 / 空白 / 换行)。存进去之前就归一化成小写、去掉粘邮箱时带上的
    // @,这样管理员看到的那一行,跟真正拿去比对的那一行是同一个东西。
    // `.example.com` / `*.example.com` 的点和星是有含义的,不能顺手削掉。
    const seen = new Set<string>();
    const domains: string[] = [];
    for (const piece of (body.data.signupDomainAllowlist ?? "").split(/[,\s]+/)) {
      const d = piece.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
      if (!d || seen.has(d)) continue;
      seen.add(d);
      domains.push(d);
    }
    const quotaRaw = (body.data.signupDailyQuota ?? "").trim();
    const quota = quotaRaw === "" ? 0 : Number(quotaRaw);
    if (!Number.isInteger(quota) || quota < 0 || quota > 100000) {
      return reply.redirect("/admin/site?error=" + encodeURIComponent(tr(req, "adminSite.gates.quotaInvalid")) + "#signup-gates");
    }
    await updateSettings({ signupDomainAllowlist: domains.join(", "), signupDailyQuota: quota });
    await audit(req, u.id, "signup_gates.update", {
      targetType: "site_settings",
      details: { domainCount: domains.length, dailyQuota: quota },
    });
    return reply.redirect("/admin/site?success=" + encodeURIComponent(tr(req, "adminSite.gates.saved")) + "#signup-gates");
  });

  // ---------- Admin audit log ----------
  app.get("/admin/audit", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;

    // Map an action's first segment to a coloured category badge. The full
    // Tailwind class strings live here (admin.ts is in tailwind.config's
    // content globs) so they survive purge — don't build them dynamically
    // in the EJS or the colours won't be generated.
    const catMeta = (prefix: string): { label: string; badge: string } => {
      switch (prefix) {
        case "site": case "settings": case "signup_gates": return { label: "配置", badge: "bg-slate-100 text-slate-700" };
        case "api_token": case "api": case "oauth": return { label: "API", badge: "bg-violet-100 text-violet-700" };
        case "backup": return { label: "数据", badge: "bg-amber-100 text-amber-700" };
        // signup.* 是建号收口函数写的(目前只有 signup.quota_blocked ——
        // 撞上每日配额被挡下来的那一条)。不认领的话它会掉进「其它」,
        // 而这正是管理员来查「谁注册不了」时要找的那一行。
        case "user": case "users": case "signup": return { label: "用户", badge: "bg-sky-100 text-sky-700" };
        case "sso": case "idp": return { label: "SSO", badge: "bg-emerald-100 text-emerald-700" };
        case "update": case "self_update": return { label: "更新", badge: "bg-indigo-100 text-indigo-700" };
        case "invite": return { label: "邀请", badge: "bg-teal-100 text-teal-700" };
        case "mfa": case "passkey": case "password": case "session": case "login": return { label: "安全", badge: "bg-rose-100 text-rose-700" };
        default: return { label: prefix || "其它", badge: "bg-slate-100 text-slate-600" };
      }
    };

    const qp = (req.query ?? {}) as { cat?: string; actor?: string; q?: string; page?: string };
    const PER_PAGE = 50;
    const page = Math.max(1, Math.min(100000, Number(qp.page) || 1));
    const cat = (qp.cat ?? "").trim().slice(0, 40);
    const actor = (qp.actor ?? "").trim().slice(0, 254);
    const term = (qp.q ?? "").trim().slice(0, 200);

    const conds = [];
    if (cat) conds.push(like(schema.adminAuditLog.action, `${cat}.%`));
    if (actor) conds.push(ilike(schema.users.email, `%${actor}%`));
    if (term) {
      const t = `%${term}%`;
      conds.push(or(
        ilike(schema.adminAuditLog.action, t),
        ilike(schema.adminAuditLog.targetType, t),
        ilike(schema.adminAuditLog.targetId, t),
      ));
    }
    const where = conds.length ? and(...conds) : undefined;

    const baseSelect = db
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
      // LEFT JOIN — actorUserId is SET NULL on user delete; still show the row.
      .leftJoin(schema.users, eq(schema.users.id, schema.adminAuditLog.actorUserId));

    const rows = await (where ? baseSelect.where(where) : baseSelect)
      .orderBy(desc(schema.adminAuditLog.createdAt))
      .limit(PER_PAGE)
      .offset((page - 1) * PER_PAGE);

    const countSelect = db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.adminAuditLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.adminAuditLog.actorUserId));
    const countRows = await (where ? countSelect.where(where) : countSelect);
    const total = countRows[0]?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

    // Category dropdown — distinct action prefixes present, with counts.
    const prefRows = await db
      .select({
        p: sql<string>`split_part(${schema.adminAuditLog.action}, '.', 1)`,
        c: sql<number>`count(*)::int`,
      })
      .from(schema.adminAuditLog)
      .groupBy(sql`split_part(${schema.adminAuditLog.action}, '.', 1)`)
      .orderBy(desc(sql`count(*)`));
    const categories = prefRows.map((r) => ({ key: r.p, count: r.c, label: catMeta(r.p).label }));

    return reply.view("admin/audit", {
      title: "审计日志 · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/audit",
      filter: { cat, actor, q: term },
      page, totalPages, total: total ?? 0, perPage: PER_PAGE,
      categories,
      entries: rows.map((r) => ({
        ...r,
        cat: catMeta((r.action.split(".")[0] ?? "")),
        createdAtIso: `<time data-tz datetime="${r.createdAt.toISOString()}" data-style="datetime">${r.createdAt.toISOString()}</time>`,
        detailsJson: r.details ? JSON.stringify(r.details, null, 2) : null,
      })),
    });
  });

  // ---------- Backup / restore ----------
  app.get("/admin/backup", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    return reply.view("admin/backup", {
      title: "数据备份 · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/backup",
      bundleVersion: BACKUP_VERSION,
    });
  });

  app.get("/admin/backup/export", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
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
    if (!u) return reply;
    const back = (msg: string) => reply.redirect("/admin/backup?error=" + encodeURIComponent(msg));
    // multipart 的 req.body 是 undefined（解析器只 done() 不塞 body），
    // 所以 _csrf 字段读不到 —— 这条路靠 requireAdmin + cookie 的 sameSite=lax。
    //
    // **limits 必须显式写。** 不写的话继承全局的 2MB，而下面那句
    // 「文件过大」写的是另一个数字 —— 于是真实的备份（任何有内容的站点
    // 导出来都远不止 2MB）在 toBuffer() 处就抛 RequestFileTooLargeError，
    // 站长收到的是 Fastify 默认的英文 413，而不是任何能看懂的提示。
    // 代码里写着一个上限、实际生效的是另一个：两个数字各自看都合理，
    // 只有放在一起看才会发现前一个是死的。
    let file: Awaited<ReturnType<typeof req.file>>;
    try {
      file = await req.file({ limits: { fileSize: MAX_BACKUP_IMPORT_BYTES } });
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "FST_REQ_FILE_TOO_LARGE") {
        return back(`文件过大（上限 ${Math.round(MAX_BACKUP_IMPORT_BYTES / 1048576)}MB）`);
      }
      throw err;
    }
    if (!file) return back("请选择备份文件");
    if (file.mimetype && !file.mimetype.toLowerCase().includes("json") && file.mimetype !== "application/octet-stream") {
      return back("文件类型应为 JSON");
    }
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch (err) {
      // toBuffer() 才是真正触顶的地方 —— 上面的 req.file() 只是拿到 part。
      const e = err as { code?: string };
      if (e.code === "FST_REQ_FILE_TOO_LARGE") {
        return back(`文件过大（上限 ${Math.round(MAX_BACKUP_IMPORT_BYTES / 1048576)}MB）`);
      }
      throw err;
    }
    if (buf.length === 0) return back("空文件");

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

  // ---------- CalDAV:让所有设备重新同步 ----------
  //
  // 这一页只有一个动作:bump 一次同步纪元(site_settings.caldav_sync_epoch)。
  // 纪元掺在每个日历的 ctag 里(见 src/web/caldav.ts 的 calendarCtags),改一次
  // = 所有 CalDAV 客户端下一轮轮询会发现 ctag 变了,各自把事件清单重新列一遍。
  //
  // 为什么非要有这个按钮:ctag 的另外两个信号(max(updated_at) / 活行数)都是
  // **数据**信号。发版只改了导出格式、事件一行没动的时候,这两个信号都不变,
  // 客户端手上那份旧副本在它眼里永远是最新的 —— 站长怎么重启、用户怎么下拉
  // 刷新都没有任何变化,而且一条错都不报。迁移里能 bump 一次,但那只覆盖发版
  // 当天;事后发现漏了、或者手工改过库,就只剩这条路。
  app.get("/admin/caldav", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    const settings = await getSettings();
    return reply.view("admin/caldav", {
      title: `${tr(req, "adminCaldav.heading")} · 管理后台`,
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/caldav",
      epoch: describeCaldavEpoch(settings.caldavSyncEpoch),
    });
  });

  // 确认页。单独一页而不是一个勾选框:这个动作没有「撤销」可言 —— 按下去的
  // 那一刻,所有设备都已经被排进各自的下一轮重列,再改回来也只是再排一轮。
  // 所以它值一次完整的「你知道会发生什么吗」。
  app.get("/admin/caldav/resync", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    return reply.view("admin/caldav-resync-confirm", {
      title: `${tr(req, "adminCaldav.confirm.heading")} · 管理后台`,
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/caldav",
    });
  });

  // 限频:6 次 / 5 分钟。
  //
  // 判据不是「保护服务器」—— 一次 bump 就是一条 UPDATE,连着按十次也还是十条
  // UPDATE;而客户端是按分钟级轮询的,同一个轮询周期内 bump 几次,设备那边只
  // 会看见一次 ctag 变化,额外代价是零。真正要兜的是**无意识的重复提交**:
  // 确认页提交完刷新、回退再提交、手滑双击。这类重复每一次都会给全站设备
  // 排一轮重列,而站长以为自己只按了一次。
  // 6 次比任何真实用途都宽(发版后按一次就够),比连点窄。
  app.post("/admin/caldav/resync", {
    config: { rateLimit: { max: 6, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // 确认这一步是**服务端**要求的,不是模板上一个 required 的勾选框。
    // 浏览器那边的 required 只是提示:谁把这个地址直接当表单提交、或者手上
    // 有个旧标签页回退重发,都绕得过去,而那正是「我没按啊」的来源。
    if (body.confirm !== "yes") {
      return reply.redirect("/admin/caldav?error=" + encodeURIComponent(tr(req, "adminCaldav.needConfirm")));
    }
    const before = (await getSettings()).caldavSyncEpoch;
    const after = await bumpCaldavSyncEpoch();
    // 审计里前后两个值都留:事后要回答的问题是「那天到底有没有真的变过」,
    // 只记一个「按过按钮」答不了 —— 写进去的值和原来一样同样会留下这条记录。
    // (ip 那一列是 NOT NULL,audit() 里已经从 req.ip 取,这里不用管。)
    await audit(req, u.id, "caldav.resync_all", {
      targetType: "site",
      details: { epochBefore: before, epochAfter: after, changed: before !== after },
    });
    return reply.redirect("/admin/caldav?success=" + encodeURIComponent(tr(req, "adminCaldav.done")));
  });

  // ---------- Third-party API ----------

  app.get("/admin/api", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
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
      qrLoginEnabled: settings.qrLoginEnabled,
      deviceCount: devCount?.c ?? 0,
      ssoEnabled: providers.length > 0,
      tokens: tokens.map((t) => {
        // Days-until-expiry surfaces in the UI as a color-coded badge so
        // admins notice approaching expiries during routine dashboard
        // glances. Negative means "expired already (but not yet revoked —
        // typically a rotation grace period that the cron job hasn't
        // cleaned up). null = no expiry set.
        const daysUntilExpiry = t.expiresAt
          ? Math.floor((t.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
          : null;
        return {
          ...t,
          createdAtLocal: localTimeIso(t.createdAt),
          lastUsedAtLocal: t.lastUsedAt ? localTimeIso(t.lastUsedAt) : null,
          expiresAtLocal: t.expiresAt ? localTimeIso(t.expiresAt) : null,
          daysUntilExpiry,
        };
      }),
      allUsers,
      issuedToken,
      issuedLabel,
      baseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
      idpApi: {
        enabled: settings.idpApiEnabled,
        serviceClients: settings.idpApiServiceClients,
        autoProvision: settings.idpApiAutoProvision,
        ssoConfigured: providers.length > 0,
      },
    });
  });

  // External IdP (Keycloak) resource-server API config. See src/lib/external_idp.ts.
  app.post("/admin/api/idp", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      enabled: z.string().optional(),
      serviceClients: z.string().max(2000).optional(),
      autoProvision: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.redirect("/admin/api?error=" + encodeURIComponent("参数无效") + "#idp");
    // Normalize the client list to a clean comma-separated string.
    const clients = (body.data.serviceClients || "")
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).join(", ");
    await updateSettings({
      idpApiEnabled: body.data.enabled === "on",
      idpApiServiceClients: clients,
      idpApiAutoProvision: body.data.autoProvision === "on",
    });
    await audit(req, u.id, "idp_api.update", { targetType: "site_settings" });
    return reply.redirect("/admin/api?success=" + encodeURIComponent("外部 IdP API 设置已保存") + "#idp");
  });

  app.post("/admin/api/toggle", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const enabled = (req.body as { enabled?: string } | undefined)?.enabled === "on";
    await updateSettings({ apiEnabled: enabled });
    // 这是止血阀:出事时它被按下的时刻,是事后复盘里最要紧的一条时间线。
    // 隔壁 apps.toggle / qr-login.toggle 都记,只有它漏了。
    await audit(req, u.id, enabled ? "api.enable" : "api.disable", { targetType: "site_settings" });
    return reply.redirect("/admin/api?success=" + encodeURIComponent(enabled ? "API 已启用" : "API 已关闭（现存 token 暂停工作）"));
  });

  // Master switch for the native iOS / Android / desktop APP feature.
  // Flipping off doesn't physically delete `devices` rows — it just
  // makes the auth path refuse them. Re-enable to restore access for
  // every previously-paired device.
  app.post("/admin/apps/toggle", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const enabled = (req.body as { enabled?: string } | undefined)?.enabled === "on";
    await updateSettings({ appsEnabled: enabled });
    await audit(req, u.id, enabled ? "apps.enable" : "apps.disable", { targetType: "site_settings" });
    return reply.redirect("/admin/api?success=" + encodeURIComponent(enabled ? "原生 APP 同步已启用" : "原生 APP 同步已关闭（已绑定的 APP 立即失效）") + "#apps");
  });

  // Master switch for the web 扫码登录 feature on the /login page. When
  // off, the「扫码登录」tab disappears and the /api/v1/devices/web-pair-*
  // endpoints all 403. Independent of appsEnabled so admins can keep
  // native APPs working while hiding the cross-device QR flow.
  app.post("/admin/qr-login/toggle", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const enabled = (req.body as { enabled?: string } | undefined)?.enabled === "on";
    await updateSettings({ qrLoginEnabled: enabled });
    await audit(req, u.id, enabled ? "qr_login.enable" : "qr_login.disable", { targetType: "site_settings" });
    return reply.redirect("/admin/api?success=" + encodeURIComponent(enabled ? "网页扫码登录已启用" : "网页扫码登录已关闭（/login 不再显示扫码标签）") + "#qr-login");
  });

  app.post("/admin/api/tokens", {
    config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
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
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.redirect("/admin/api");
    await revokeApiTokenAdmin(id.data);
    await audit(req, u.id, "api_token.revoke", { targetType: "api_token", targetId: id.data });
    return reply.redirect("/admin/api?success=" + encodeURIComponent("Token 已撤销"));
  });

  // Rotate a token: mint a fresh secret, keep the old one valid for `graceDays`
  // so external integrations have a window to roll over without an outage.
  // The new token shows up in the issued-banner same as /tokens POST — admin
  // copies it ONCE, then it's gone. Both old + new appear in the list with
  // their respective expiry timestamps until grace elapses.
  app.post<{ Params: { id: string }; Body: { graceDays?: string | number } }>(
    "/admin/api/tokens/:id/rotate",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (req, reply) => {
      const u = await requireAdmin(req, reply);
      if (!u) return reply;
      if (!verifyCsrf(req, reply)) return;
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) return reply.redirect("/admin/api?error=" + encodeURIComponent("Token id 无效"));
      // Optional override; default 7 days. Capped at 30 to prevent admins
      // accidentally setting "rotate but never expire" — that defeats the
      // point of rotation. Min 0 = revoke-immediately if the new key has
      // already been deployed and we want to cut the old one off.
      const graceRaw = (req.body?.graceDays ?? 7).toString();
      const grace = z.coerce.number().int().min(0).max(30).safeParse(graceRaw);
      if (!grace.success) return reply.redirect("/admin/api?error=" + encodeURIComponent("grace 天数无效（0–30）"));
      try {
        const issued = await rotateApiToken({ oldTokenId: id.data, graceDays: grace.data });
        await audit(req, u.id, "api_token.rotate", {
          targetType: "api_token",
          targetId: id.data,
          details: { newTokenId: issued.id, graceDays: grace.data, oldExpiresAt: issued.oldExpiresAt.toISOString() },
        });
        const params = new URLSearchParams({
          issued: issued.plain,
          issuedLabel: "Rotated token",
          success: `Token 已轮换，旧 token 还有 ${grace.data} 天有效期。立即复制新 token，仅显示一次。`,
        });
        return reply.redirect("/admin/api?" + params.toString());
      } catch (e) {
        const msg = e instanceof Error ? e.message : "rotate failed";
        return reply.redirect("/admin/api?error=" + encodeURIComponent(`轮换失败：${msg}`));
      }
    },
  );

  // ---------- Security knobs (risk-login + lockout) ----------
  app.get("/admin/security", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    const settings = await getSettings();
    return reply.view("admin/security", {
      title: "安全设置",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      activeNav: "/admin/security",
      settings,
      captchaProviders: CAPTCHA_PROVIDERS,
      publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
    });
  });

  // CAPTCHA provider config — separate form (its own secret-keep logic).
  app.post("/admin/security/captcha", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      captchaProvider: z.string(),
      captchaSiteKey: z.string().max(500).optional(),
      captchaSecret: z.string().max(2000).optional(),
      captchaBuiltinMode: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success || !isCaptchaProvider(body.data.captchaProvider)) {
      return reply.redirect("/admin/security?error=" + encodeURIComponent("无效的人机验证配置") + "#captcha");
    }
    const patch: { captchaProvider: string; captchaSiteKey: string | null; captchaSecret?: string | null; captchaBuiltinMode: string } = {
      captchaProvider: body.data.captchaProvider,
      captchaSiteKey: body.data.captchaSiteKey?.trim() || null,
      // Builtin UX mode (radio). Default to "invisible" for any unexpected value.
      captchaBuiltinMode: isBuiltinMode(body.data.captchaBuiltinMode) ? body.data.captchaBuiltinMode : "invisible",
    };
    // Blank secret on save = keep the stored one (like the SSO client secret);
    // only overwrite when a non-empty value is submitted.
    const secret = body.data.captchaSecret?.trim();
    if (secret) patch.captchaSecret = secret;
    await updateSettings(patch);
    await audit(req, u.id, "site.captcha.update", { targetType: "site_settings", details: { provider: body.data.captchaProvider } });
    return reply.redirect("/admin/security?success=" + encodeURIComponent("人机验证设置已保存") + "#captcha");
  });

  app.post("/admin/security", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z
      .object({
        riskLoginEnabled: z.string().optional(),
        lockoutEnabled: z.string().optional(),
        lockoutThreshold: z.coerce.number().int().min(1).max(100),
        lockoutMinutes: z.coerce.number().int().min(1).max(10080),
        forceAdminMfa: z.string().optional(),
        requirePasskeyUv: z.string().optional(),
        ssoSatisfiesMfa: z.string().optional(),
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
      requirePasskeyUv: body.data.requirePasskeyUv === "on",
      ssoSatisfiesMfa: body.data.ssoSatisfiesMfa === "on",
      embedEnabled: body.data.embedEnabled === "on",
    });
    return reply.redirect("/admin/security?success=" + encodeURIComponent("安全设置已保存"));
  });

  // ---------- Invite-based registration (registrationMode === "invite") ----------
  const inviteBaseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");

  app.get("/admin/invites", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    const settings = await getSettings();
    const invites = await listInvites();
    return reply.view("admin/invites", {
      title: "邀请注册 · 管理后台",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      activeNav: "/admin/invites",
      settings,
      invites,
      baseUrl: inviteBaseUrl,
    });
  });

  app.post("/admin/invites", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      email: z.string().max(254).optional(),
      note: z.string().max(200).optional(),
      maxUses: z.coerce.number().int().min(1).max(1000).optional(),
      expiresInDays: z.coerce.number().int().min(0).max(365).optional(),
      sendEmail: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.redirect("/admin/invites?error=" + encodeURIComponent("参数无效") + "#list");
    }
    const rawEmail = body.data.email?.trim().toLowerCase() || "";
    // An email is optional, but if present it must be valid (it then binds the invite).
    if (rawEmail && !z.string().email().safeParse(rawEmail).success) {
      return reply.redirect("/admin/invites?error=" + encodeURIComponent("收件邮箱格式不正确") + "#list");
    }
    const email = rawEmail || null;
    const wantsEmail = body.data.sendEmail === "on";
    if (wantsEmail && !email) {
      return reply.redirect("/admin/invites?error=" + encodeURIComponent("勾选「立即发送邮件」时必须填写收件邮箱") + "#list");
    }
    const invite = await createInvite({
      createdBy: user.id,
      email,
      note: body.data.note || null,
      maxUses: body.data.maxUses ?? 1,
      expiresInDays: body.data.expiresInDays && body.data.expiresInDays > 0 ? body.data.expiresInDays : null,
    });
    await audit(req, user.id, "invite.create", {
      targetType: "signup_invite", targetId: invite.token,
      details: { email, maxUses: invite.maxUses },
    });
    if (wantsEmail && email) {
      const settings = await getSettings();
      const inviteUrl = `${inviteBaseUrl}/register?invite=${encodeURIComponent(invite.token)}`;
      try {
        await sendMail(inviteSignupMail({ to: email, inviteUrl, siteName: settings.siteName, inviterName: user.displayName ?? undefined }));
        await audit(req, user.id, "invite.email", { targetType: "signup_invite", targetId: invite.token, details: { to: email } });
        return reply.redirect("/admin/invites?success=" + encodeURIComponent(`邀请已创建并发送到 ${email}`) + "#list");
      } catch (err) {
        req.log.warn({ err }, "invite_email_send_failed");
        return reply.redirect("/admin/invites?error=" + encodeURIComponent("邀请已创建，但邮件发送失败（请检查 SMTP 设置）") + "#list");
      }
    }
    return reply.redirect("/admin/invites?success=" + encodeURIComponent("邀请链接已生成") + "#list");
  });

  app.post<{ Params: { token: string } }>("/admin/invites/:token/revoke", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    await revokeInvite(req.params.token);
    await audit(req, user.id, "invite.revoke", { targetType: "signup_invite", targetId: req.params.token });
    return reply.redirect("/admin/invites?success=" + encodeURIComponent("邀请已撤销") + "#list");
  });

  app.post<{ Params: { token: string } }>("/admin/invites/:token/email", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({ to: z.string().max(254).optional() }).safeParse(req.body);
    const v = await validateInvite(req.params.token);
    if (!v.ok) {
      return reply.redirect("/admin/invites?error=" + encodeURIComponent("该邀请已失效，无法发送") + "#list");
    }
    const to = ((body.success && body.data.to?.trim().toLowerCase()) || v.invite.email || "").trim();
    if (!to || !z.string().email().safeParse(to).success) {
      return reply.redirect("/admin/invites?error=" + encodeURIComponent("请填写合法的收件邮箱") + "#list");
    }
    // If the invite is email-bound, only send to that address.
    if (v.invite.email && to !== v.invite.email) {
      return reply.redirect("/admin/invites?error=" + encodeURIComponent("该邀请仅限指定邮箱，不能发往其他地址") + "#list");
    }
    const settings = await getSettings();
    const inviteUrl = `${inviteBaseUrl}/register?invite=${encodeURIComponent(req.params.token)}`;
    try {
      await sendMail(inviteSignupMail({ to, inviteUrl, siteName: settings.siteName, inviterName: user.displayName ?? undefined }));
      await audit(req, user.id, "invite.email", { targetType: "signup_invite", targetId: req.params.token, details: { to } });
      return reply.redirect("/admin/invites?success=" + encodeURIComponent(`邀请已发送到 ${to}`) + "#list");
    } catch (err) {
      req.log.warn({ err }, "invite_email_send_failed");
      return reply.redirect("/admin/invites?error=" + encodeURIComponent("邮件发送失败（请检查 SMTP 设置）") + "#list");
    }
  });

  // ---------- Email template preview (admin only) ----------
  app.post("/admin/smtp/preview", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
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

  // ---------- Email templates: see + edit brand details + live preview ----------
  app.get("/admin/email-templates", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    const settings = await getSettings();
    const now = new Date();
    // Render each template once with the CURRENTLY SAVED branding for the
    // initial server-side preview (iframe srcdoc). Live edits re-render via the
    // /preview endpoint below.
    const previews = EMAIL_PREVIEW_TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      html: renderPreviewHtml(t.key, "you@example.com", now, {}) ?? "",
    }));
    return reply.view("admin/email-templates", {
      title: "邮件模板 · 管理后台",
      user,
      csrfToken: csrfTokenFor(req),
      flash: flashFromQuery(req),
      activeNav: "/admin/email-templates",
      settings,
      previews,
    });
  });

  // Live preview: render ONE template with DRAFT branding overrides (not saved).
  // Returns raw HTML; the page fetches this and writes it into the iframe srcdoc.
  app.get<{ Querystring: { key?: string; name?: string; color?: string; footer?: string } }>(
    "/admin/email-templates/preview",
    async (req, reply) => {
      const user = await requireAdmin(req, reply);
      if (!user) return reply;
      const q = req.query ?? {};
      const key = typeof q.key === "string" ? q.key : "";
      const html = renderPreviewHtml(key, "you@example.com", new Date(), {
        brand: typeof q.name === "string" ? q.name.slice(0, 100) : undefined,
        brandColor: typeof q.color === "string" ? q.color.slice(0, 16) : undefined,
        footerNote: typeof q.footer === "string" ? q.footer.slice(0, 100) : undefined,
      });
      if (html == null) return reply.code(404).type("text/plain").send("unknown template");
      // Same-origin HTML for the iframe; no inline scripts so the page CSP is fine.
      return reply.type("text/html; charset=utf-8").send(html);
    },
  );

  app.post("/admin/email-templates", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      siteName: z.string().max(100).optional(),
      emailBrandColor: z.string().max(16).optional(),
      emailFooterNote: z.string().max(100).optional(),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.redirect("/admin/email-templates?error=" + encodeURIComponent("参数无效"));
    }
    const color = normalizeHexColor(body.data.emailBrandColor);
    if (body.data.emailBrandColor && !color) {
      return reply.redirect("/admin/email-templates?error=" + encodeURIComponent("主题色必须是合法的十六进制颜色，例如 #4f46e5"));
    }
    const patch: { siteName?: string; emailBrandColor?: string; emailFooterNote?: string } = {};
    if (body.data.siteName?.trim()) patch.siteName = body.data.siteName.trim();
    if (color) patch.emailBrandColor = color;
    if (body.data.emailFooterNote != null) patch.emailFooterNote = body.data.emailFooterNote.trim() || "日历共享平台";
    await updateSettings(patch);
    await audit(req, user.id, "site.email_branding.update", {
      targetType: "site_settings",
      details: { brandColor: patch.emailBrandColor ?? null, footerNote: patch.emailFooterNote ?? null },
    });
    return reply.redirect("/admin/email-templates?success=" + encodeURIComponent("邮件品牌已保存，下一封邮件即生效"));
  });

  app.post("/admin/email-templates/send", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({
      to: z.string().email(),
      // Checkboxes named "templates": one value → string, many → string[].
      templates: z.union([z.string(), z.array(z.string())]).optional(),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.redirect("/admin/email-templates?error=" + encodeURIComponent("请输入合法的邮箱地址"));
    }
    const to = body.data.to;
    // Selective send: only the checked templates. No selection = nothing to do.
    const wanted = new Set(
      Array.isArray(body.data.templates) ? body.data.templates : body.data.templates ? [body.data.templates] : [],
    );
    const chosen = EMAIL_PREVIEW_TEMPLATES.filter((t) => wanted.has(t.key));
    if (chosen.length === 0) {
      return reply.redirect("/admin/email-templates?error=" + encodeURIComponent("请至少勾选一种要发送的模板"));
    }
    const now = new Date();
    let sent = 0;
    const failed: string[] = [];
    for (const t of chosen) {
      try {
        await sendMail(t.build(to, now));
        sent++;
      } catch (err) {
        req.log.warn({ err, key: t.key }, "email_template_send_failed");
        failed.push(t.label);
      }
    }
    const msg = failed.length
      ? `已发 ${sent} 封，失败 ${failed.length} 封（${failed.join("、")}）—— 检查 SMTP 设置`
      : `已把 ${sent} 种模板邮件发送到 ${to}，请查收`;
    return reply.redirect("/admin/email-templates?success=" + encodeURIComponent(msg));
  });

  // ---------- Theme / appearance ----------
  app.get("/admin/theme", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
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
    if (!user) return reply;
    if (!verifyCsrf(req, reply)) return;
    // Reply first; queue the restart so the response can flush.
    reply.send({ ok: true, scheduled: true });
    setTimeout(() => {
      void restartProcess().catch(() => undefined);
    }, 800);
    return reply;
  });

  // ---------- 离线 / 手动更新：上传已签名的 release tarball ----------
  // 管理员上传 scripts/release.sh 产出的 <tarball>.tar.gz + <tarball>.sig。
  // 服务器先 ed25519 验签（安全闸门），通过才解压 → 体检 → 覆盖已知文件 →
  // npm ci → db migrate，全程 SSE 流式回传进度。任何失败都不会留下半应用的树。
  //
  // 安全：multipart 请求不带可靠 CSRF cookie，因此和 BIMI / 备份导入一样，靠
  // requireAdmin（登录 + 管理员 + 同源 CORS）做闸。体积上限 100MB 在 parts()
  // 的 per-request limits + 落盘时的硬字节计数双重设防。
  app.post("/admin/update/upload", {
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return reply;

    if (!req.isMultipart()) {
      return reply.code(400).send({ ok: false, error: "请求必须是 multipart/form-data" });
    }
    if (updateInFlight) {
      return reply.code(409).send({ ok: false, error: `已有更新进行中（由 ${updateInFlight.actorEmail} 启动）` });
    }

    // 落盘到临时目录：tarball 直接流式写盘（大文件不进内存），sig 作为第二个文件
    // 或 `signature` 字段读入。size 上限双保险：parts() 的 fileSize + 我们自己计数。
    let stagingDir: string | null = null;
    let tarballPath: string | null = null;
    let sigBase64: string | null = null;
    let tarballName = "";
    let aborted: string | null = null;

    try {
      stagingDir = await mkdtemp(path.join(tmpdir(), "bwc-upload-"));
      tarballPath = path.join(stagingDir, "update.tar.gz");

      // per-request 覆盖全局 2MB 限制：允许 tarball 到 100MB，最多 2 个文件
      // （tarball + 可选的 .sig），少量字段（signature）。
      const parts = req.parts({
        limits: {
          fileSize: MAX_UPLOAD_BYTES,
          files: 2,
          fields: 5,
          fieldSize: 1024 * 1024, // signature base64 很小，1MB 绰绰有余
        },
      });

      let sawTarball = false;
      for await (const part of parts) {
        if (aborted) break;
        if (part.type === "file") {
          const fname = part.filename || "";
          const isSig = /\.sig$/i.test(fname) || part.fieldname === "signature";
          if (isSig) {
            // .sig 作为文件上传：读成 base64 文本（内容本身就是 base64）。
            const buf = await part.toBuffer();
            sigBase64 = buf.toString("utf8").trim();
          } else {
            // 视为 tarball：流式写盘，硬计数字节，超限即中止。
            sawTarball = true;
            tarballName = fname;
            let bytes = 0;
            const ws = createWriteStream(tarballPath);
            try {
              await new Promise<void>((resolve, reject) => {
                part.file.on("data", (chunk: Buffer) => {
                  bytes += chunk.length;
                  if (bytes > MAX_UPLOAD_BYTES) {
                    reject(new Error("文件过大（>100MB）"));
                  }
                });
                part.file.on("limit", () => reject(new Error("文件过大（>100MB）")));
                part.file.on("error", reject);
                ws.on("error", reject);
                ws.on("finish", () => resolve());
                part.file.pipe(ws);
              });
            } catch (err) {
              ws.destroy();
              aborted = err instanceof Error ? err.message : String(err);
              // 继续 drain 掉 part.file 以免连接挂死
              part.file.resume();
            }
            // @fastify/multipart：若 fileSize 触顶，part.file.truncated 会是 true
            if (!aborted && (part.file as unknown as { truncated?: boolean }).truncated) {
              aborted = "文件过大（>100MB）";
            }
          }
        } else if (part.type === "field") {
          if (part.fieldname === "signature" && typeof part.value === "string") {
            sigBase64 = String(part.value).trim();
          }
          // 其它字段（如 _csrf）忽略
        }
      }

      if (aborted) {
        await audit(req, user.id, "update.upload_rejected", { details: { reason: aborted, file: tarballName.slice(0, 200) } });
        return reply.code(413).send({ ok: false, error: aborted });
      }
      if (!sawTarball || !tarballPath) {
        return reply.code(400).send({ ok: false, error: "缺少更新包文件（.tar.gz）" });
      }
      if (!sigBase64) {
        await audit(req, user.id, "update.upload_rejected", { details: { reason: "missing_signature", file: tarballName.slice(0, 200) } });
        return reply.code(400).send({ ok: false, error: "缺少签名（请上传对应的 .sig 文件，或填入 signature 字段）" });
      }

      // 拿到锁，开始应用。SSE 流式回传每一步进度。
      updateInFlight = { startedAt: new Date(), actorEmail: user.email };
      await audit(req, user.id, "update.upload_apply_start", { details: { file: tarballName.slice(0, 200) } });

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const write = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

      let finalOk = false;
      let sigVerifyFailed = false;
      try {
        for await (const ev of applyUploadedUpdate(tarballPath, sigBase64)) {
          write(ev);
          // 单独识别「验签失败」以便打专门的审计条目（安全事件）。
          if (ev.type === "done" && ev.step === "verify signature" && !ev.ok) {
            sigVerifyFailed = true;
          }
          if (ev.type === "final") finalOk = ev.ok;
        }
      } catch (err) {
        write({ type: "final", ok: false, error: err instanceof Error ? err.message : "未知错误" });
      } finally {
        if (sigVerifyFailed) {
          await audit(req, user.id, "update.upload_signature_rejected", { details: { file: tarballName.slice(0, 200) } });
        } else {
          await audit(req, user.id, finalOk ? "update.upload_apply_done" : "update.upload_apply_failed", { details: { file: tarballName.slice(0, 200) } });
        }
        reply.raw.end();
        updateInFlight = null;
      }
      return reply;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 若还没开始 SSE（headers 未发），返回 JSON 错误；否则连接已被上面接管。
      updateInFlight = null;
      await audit(req, user.id, "update.upload_apply_failed", { details: { error: msg.slice(0, 500) } });
      if (!reply.raw.headersSent) {
        return reply.code(500).send({ ok: false, error: msg });
      }
      try { reply.raw.end(); } catch { /* ignore */ }
      return reply;
    } finally {
      // 清理临时上传目录（tarball + sig）。解压出来的 staging 由 applyUploadedUpdate 自己清。
      if (stagingDir) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  // ---------- Outbound webhooks ----------
  // Admin manages a list of "when something happens, POST to this URL"
  // destinations. Delivery is best-effort; failures are logged so the
  // admin can debug from the same page.
  app.get("/admin/webhooks", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
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
    if (!me) return reply;
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
    if (!me) return reply;
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
    if (!me) return reply;
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
    if (!me) return reply;
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
    if (!me) return reply;
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
    if (!me) return reply;
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
    if (!u) return reply;
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
    // One-time client secret comes from a short-lived signed cookie (set on
    // create), never the URL. Read once, then clear.
    let issuedSecret: string | null = null;
    let issuedClientId: string | null = null;
    const rawSecretCookie = req.cookies["bwc_oauth_secret"];
    if (rawSecretCookie) {
      const unsigned = req.unsignCookie(rawSecretCookie);
      if (unsigned.valid && unsigned.value) {
        try {
          const j = JSON.parse(unsigned.value) as { s?: unknown; c?: unknown };
          issuedSecret = typeof j.s === "string" ? j.s : null;
          issuedClientId = typeof j.c === "string" ? j.c : null;
        } catch { /* malformed — ignore */ }
      }
      reply.clearCookie("bwc_oauth_secret", { path: "/admin/oauth-apps" });
    }
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
      // 总闸默认是**关**的(schema.ts 的 api_enabled default false),而总闸
      // 关着时授权流程整条回 503。新装的站点在这儿建完应用会直接撞墙,
      // 而这一页以前完全没提过总闸 —— 隔壁 api.ejs 给签发 token 的按钮做了
      // disabled + 提示,OAuth 这页漏了。
      apiEnabled: (await getSettings()).apiEnabled,
    });
  });

  app.post("/admin/oauth-apps", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return reply;
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
    // Hand the one-time secret back via a short-lived signed cookie, NOT the URL
    // query — a query param lands in browser history, server access logs, and the
    // Referer header. The GET below reads it once and clears it.
    reply.setCookie("bwc_oauth_secret", JSON.stringify({ s: created.clientSecret, c: created.clientId }), {
      httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/admin/oauth-apps", maxAge: 120, signed: true,
    });
    return reply.redirect("/admin/oauth-apps?success=" + encodeURIComponent("应用已创建，密钥仅显示一次，请立即复制"));
  });

  app.post("/admin/oauth-apps/:id/toggle", async (req, reply) => {
    const me = await requireAdmin(req, reply);
    if (!me) return reply;
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
    if (!me) return reply;
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


  // ---------- 客户端更新清单 ----------
  //
  // 服务端读清单的顺序是:先 data/app-{android,desktop}-manifest.json(运行期
  // 覆盖),再 apps/{android,desktop}/releases/latest.json(随代码走)。
  // 后者现在会随发版包到服务器(见 scripts/release.sh + self_update 的
  // APPLY_FILES),所以「什么都不做」的站长自动拿到上游的版本。
  //
  // 这一页管的是另一半:站长想**自己决定**推哪一版的时候 —— 他自己编译了
  // 客户端分发给自己的用户,或者想把版本钉住不跟上游走。以前唯一的办法是
  // SSH 上去往 data/ 里丢文件。
  //
  // 为什么覆盖文件放在 data/:那是两条更新路径都不碰的地方 —— 不在 git 里
  // (git 更新路径的 reset --hard 冲不掉),也不在 tarball 的应用白名单里
  // (上传更新路径不碰)。所以放进去的东西对随便怎么升级都是持久的。
  const CLIENT_MANIFEST_RUNTIME = {
    android: path.join(process.cwd(), "data", "app-android-manifest.json"),
    desktop: path.join(process.cwd(), "data", "app-desktop-manifest.json"),
  } as const;
  const CLIENT_MANIFEST_COMMITTED = {
    android: path.join(process.cwd(), "apps", "android", "releases", "latest.json"),
    desktop: path.join(process.cwd(), "apps", "desktop", "releases", "latest.json"),
  } as const;
  type ClientPlatform = keyof typeof CLIENT_MANIFEST_RUNTIME;

  /** 这个平台现在**实际生效**的是哪一份、长什么样、从哪儿来。
   *  站长最需要知道的就是这个,而以前后台完全看不到。 */
  async function describeClientRelease(platform: ClientPlatform) {
    const fs = await import("node:fs/promises");
    const live = platform === "android"
      ? await (await import("../lib/android_release.js")).getLatestRelease()
      : await (await import("../lib/desktop_release.js")).getLatestRelease();
    const overrideRaw = await fs.readFile(CLIENT_MANIFEST_RUNTIME[platform], "utf8").catch(() => null);
    const committedExists = await fs.stat(CLIENT_MANIFEST_COMMITTED[platform]).then(() => true).catch(() => false);
    return {
      platform,
      label: platform === "android" ? "安卓" : "桌面端",
      // 「没数据」也要有骨架:整块消失的话,「还没发布过」和「这一页坏了」
      // 看起来一模一样。
      versionName: live?.versionName ?? null,
      versionCode: live?.versionCode ?? null,
      releasedAt: live?.releasedAt ?? null,
      source: overrideRaw ? "override" : committedExists ? "committed" : "none",
      overrideRaw,
      committedExists,
    };
  }

  app.get("/admin/client-release", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    return reply.view("admin/client-release", {
      title: "客户端更新 · 管理后台",
      user: u, csrfToken: csrfTokenFor(req), flash: flashFromQuery(req),
      activeNav: "/admin/client-release",
      platforms: [await describeClientRelease("android"), await describeClientRelease("desktop")],
      binaries: {
        android: await listBinaries("android"),
        desktop: await listBinaries("desktop"),
      },
      disk: await diskFree(process.cwd()),
      maxBinaryBytes: MAX_BINARY_BYTES,
    });
  });

  app.post<{ Params: { platform: string } }>("/admin/client-release/:platform", {
    config: { oauthScope: "deny", rateLimit: { max: 10, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const back = (msg: string, ok = false) =>
      reply.redirect("/admin/client-release?" + (ok ? "success=" : "error=") + encodeURIComponent(msg));

    const p = z.enum(["android", "desktop"]).safeParse(req.params.platform);
    if (!p.success) return reply.code(400).send("bad_platform");
    const body = z.object({ manifest: z.string().min(2).max(200_000) }).safeParse(req.body);
    if (!body.success) return back("内容是空的 —— 没有保存");

    let parsed: unknown;
    try { parsed = JSON.parse(body.data.manifest); }
    catch { return back("这不是合法的 JSON —— 没有保存"); }

    // **校验复用读取侧那一份。** 自己写一套「看起来差不多」的,就会出现
    // 「页面说保存成功、而 /api/app/*/latest 直接 404」—— 因为真正决定成败
    // 的是读取侧,而它对解析失败和形状不符一律静默 return null。
    const now = new Date().toISOString();
    const ok = p.data === "android"
      ? (await import("../lib/android_release.js")).parseAndroidManifest(parsed, now)
      : (await import("../lib/desktop_release.js")).parseDesktopManifest(parsed, now);
    if (!ok) {
      return back("这份清单读取侧认不出来（缺 versionCode / versionName，或者没有任何可下载的资产）—— 没有保存");
    }

    // 下载地址只许 https。这个地址会被推给所有装了本站 App 的用户 ——
    // 管理员会话一旦被盗,这就是一条「向全站用户推送任意下载地址」的路。
    // 安卓那边还有系统的安装包签名校验兜底,桌面端 DMG/MSI 没有等价闸门。
    const urls = p.data === "android"
      ? [(ok as { downloadUrl: string }).downloadUrl]
      : Object.values((ok as { assets: Record<string, { downloadUrl: string }> }).assets).map((a) => a.downloadUrl);
    const bad = urls.filter((x) => x && !x.startsWith("https://"));
    if (bad.length) return back("下载地址必须是 https:// —— 没有保存：" + bad.join("、"));

    await mkdir(path.dirname(CLIENT_MANIFEST_RUNTIME[p.data]), { recursive: true });
    // 存**规范化之后**那份,不是原文 —— 存原文的话,页面上显示的和接口实际
    // 返回的可能不是一回事。
    await writeFile(CLIENT_MANIFEST_RUNTIME[p.data], JSON.stringify(ok, null, 2) + "\n", "utf8");
    await audit(req, u.id, "app_manifest.override_set", {
      targetType: "client_release", targetId: p.data,
      details: { versionCode: ok.versionCode, versionName: ok.versionName },
    });
    return back(`已保存${p.data === "android" ? "安卓" : "桌面端"}清单：${ok.versionName}（${ok.versionCode}）`, true);
  });

  app.post<{ Params: { platform: string } }>("/admin/client-release/:platform/clear", {
    config: { oauthScope: "deny", rateLimit: { max: 10, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    if (!verifyCsrf(req, reply)) return;
    const p = z.enum(["android", "desktop"]).safeParse(req.params.platform);
    if (!p.success) return reply.code(400).send("bad_platform");
    await unlink(CLIENT_MANIFEST_RUNTIME[p.data]).catch(() => undefined);
    await audit(req, u.id, "app_manifest.override_cleared", {
      targetType: "client_release", targetId: p.data,
    });
    return reply.redirect("/admin/client-release?success=" + encodeURIComponent("已清除覆盖，恢复成随代码走的那一份"));
  });


  // ---------- 上传安装包 ----------
  //
  // 目标很具体:**做完这件事,站长就不用再开宝塔的文件管理器了。**
  // 所以这一页必须能做完整闭环:看见服务器上有什么 → 传新的 → 删旧的 →
  // 知道还剩多少磁盘。只能传不能删的话,盘迟早满,他还是得回宝塔。
  //
  // ── 这条路上每一个「照抄现成写法」都会踩到的坑 ────────────────────
  //
  // 1. **临时文件不能放 os.tmpdir()**。Linux 上 /tmp 常是独立分区甚至 tmpfs,
  //    跨设备 rename 直接 EXDEV;tmpfs 的话 109MB 先吃进内存。
  //    落在目标目录旁边的 .part,同目录 rename 是原子的。
  // 2. **一个字节都不许进内存**。part.toBuffer() 峰值是 2× 文件大小,而
  //    deploy 的 PM2 配置写着 max_memory_restart: 512M、单进程 —— 一次
  //    buffer 就是整站重启。边写边算 sha256,内存常数级。
  // 3. **同名重传会当场把线上那份打成 0 字节**:createWriteStream 默认
  //    flags 'w',打开的瞬间就 truncate。站长发现包传错了重传的那三分钟里,
  //    正在下载的人拿到的是逐渐增长的垃圾。所以必须 .part → 校验 → rename,
  //    线上那份在新包校验通过之前一个字节都不动。
  // 4. **超限的判据只有 part.file.truncated 是真的**。隔壁那条上传路写了
  //    三道闸,实测只有这一道会响:另外两道一个恒不成立(busboy 最多吐
  //    fileSize 字节)、一个是空放(ws 的 finish 先 resolve)。
  //    而且超大文件如果是表单最后一个 part,插件的错误会从 for-await 里
  //    抛出来 —— 不单独 catch 的话变成 500 + 英文原文。
  // 5. **反向代理会先把你拦了**。deploy 的 nginx 示例写的是
  //    client_max_body_size 10m,109MB 的包连 Node 都到不了,浏览器只看到
  //    一个没头没尾的失败,服务端日志干干净净。页面上必须写明这件事。
  //
  // ── 这个功能最值钱的一步 ──────────────────────────────────────────
  //
  // 落盘之后、rename 之前,把边写边算出来的 sha256 跟清单里的比一比。
  // 对不上的话:桌面端 UpdateDownloader / 安卓 ApkDownloader 下载完会校验,
  // 不匹配就删掉重下 —— 用户陷入无限重试,而站长完全不知道为什么。
  // 上传时就拦掉,把两个值并排摆给他看。

  /** 单个安装包的上限。比现有「系统更新」那条(100MB)大 ——
   *  DMG 已经 109MB,MSI 99.5MB 离 100MB 只剩 0.5% 余量,下一版必炸。 */
  const MAX_BINARY_BYTES = 300 * 1024 * 1024;

  const BIN_DIRS = {
    android: path.join(process.cwd(), "data", "android-apks"),
    desktop: path.join(process.cwd(), "data", "desktop-binaries"),
  } as const;
  type BinPlatform = keyof typeof BIN_DIRS;

  /** 同一个目标文件名同时只允许一个人在传。两个管理员同时传同名文件的话,
   *  临时名不同、rename 有先后,结果是「后到的赢」而**没有任何人被告知** ——
   *  那比报错更糟。 */
  const binaryUploadsInFlight = new Set<string>();

  /** 列出一个目录里的安装包 + 它和清单的关系。
   *  「清单引用了它吗」和「sha256 对得上吗」是站长唯一需要知道的两件事。 */
  async function listBinaries(platform: BinPlatform) {
    const fs = await import("node:fs/promises");
    const dir = BIN_DIRS[platform];
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const desktop = await import("../lib/desktop_release.js");
    const android = await import("../lib/android_release.js");
    const rel = platform === "android"
      ? await android.getLatestRelease()
      : await desktop.getLatestRelease();
    /** 清单里提到的文件名 → 它声明的 sha256 / 大小。 */
    const wanted = new Map<string, { sha256: string; sizeBytes: number }>();
    if (rel) {
      if (platform === "android") {
        const r = rel as { filename: string; sha256: string; sizeBytes: number };
        if (r.filename) wanted.set(r.filename, { sha256: r.sha256, sizeBytes: r.sizeBytes });
      } else {
        for (const a of Object.values((rel as { assets: Record<string, { filename: string; sha256: string; sizeBytes: number }> }).assets)) {
          if (a?.filename) wanted.set(a.filename, { sha256: a.sha256, sizeBytes: a.sizeBytes });
        }
      }
    }
    const out: Array<{
      name: string; size: number; referenced: boolean; sizeMatches: boolean | null;
      servable: boolean; partial: boolean;
    }> = [];
    let total = 0;
    for (const name of names.sort()) {
      // .part 是上传中途的临时文件 —— 单独标出来,别让人以为那是个可用的包。
      const partial = name.endsWith(".part");
      const st = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!st || !st.isFile()) continue;
      total += st.size;
      const w = wanted.get(name);
      out.push({
        name, size: st.size, partial,
        referenced: !!w,
        // 只比大小,不在列表页重算 109MB 的 sha256(那会卡住整个后台)。
        sizeMatches: w ? (w.sizeBytes > 0 ? st.size === w.sizeBytes : null) : null,
        servable: platform === "android"
          ? android.isServableApkName(name)
          : desktop.isServableBinaryName(name),
      });
    }
    return { dir, files: out, totalBytes: total };
  }

  /** 磁盘还剩多少。全仓以前一处检查都没有 —— 而 data/ 和 Postgres 通常在
   *  同一个文件系统上,写满之后不是「上传失败」这么干净,是数据库拒绝写入。 */
  async function diskFree(dir: string): Promise<{ freeBytes: number; totalBytes: number } | null> {
    try {
      const fs = await import("node:fs");
      const st = fs.statfsSync(dir);
      return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
    } catch { return null; }
  }

  app.post<{ Params: { platform: string } }>("/admin/client-release/:platform/binary", {
    config: { oauthScope: "deny", rateLimit: { max: 10, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return reply;
    // multipart 的 req.body 是 undefined(解析器只 done() 不塞 body),
    // 所以 _csrf 字段读不到 —— 客户端改用 x-csrf-token 头,这里照常验。
    // (隔壁那条上传路干脆不验 CSRF,注释里的理由是错的:cookie 照常发,
    //  而 CORS 从不拦跨站的 multipart 表单 POST。真正挡住的是 sameSite=lax。)
    if (!verifyCsrf(req, reply)) return;

    const p = z.enum(["android", "desktop"]).safeParse(req.params.platform);
    if (!p.success) return reply.code(400).send({ ok: false, error: "bad_platform" });
    const platform = p.data;
    const dir = BIN_DIRS[platform];

    const desktop = await import("../lib/desktop_release.js");
    const android = await import("../lib/android_release.js");
    const nameOk = (n: string) => platform === "android"
      ? android.isServableApkName(n) : desktop.isServableBinaryName(n);

    const fs = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });

    let saved: { name: string; size: number; sha256: string } | null = null;
    let rejected: { code: number; msg: string } | null = null;
    let tmpPath: string | null = null;
    let lockedName: string | null = null;

    try {
      const parts = req.parts({
        limits: {
          fileSize: MAX_BINARY_BYTES,
          files: 1,
          fields: 5,
          fieldSize: 64 * 1024,
          // 显式写:不写会 deepmerge 继承插件默认的 1000。
          parts: 20,
        },
      });

      for await (const part of parts) {
        if (rejected) { if (part.type === "file") part.file.resume(); continue; }
        if (part.type !== "file") continue;

        const fname = (part.filename || "").trim();
        if (!nameOk(fname)) {
          rejected = { code: 400, msg: `文件名不合规：${fname.slice(0, 80)}。只能用英文字母、数字、点、下划线和连字符，扩展名必须是 ${platform === "android" ? ".apk" : ".dmg / .msi / .deb"}。` };
          part.file.resume();
          continue;
        }
        if (binaryUploadsInFlight.has(`${platform}/${fname}`)) {
          rejected = { code: 409, msg: `${fname} 正在被另一个上传占用，请稍候再试。` };
          part.file.resume();
          continue;
        }
        lockedName = `${platform}/${fname}`;
        binaryUploadsInFlight.add(lockedName);

        // 临时文件落在**目标目录旁边**:同目录 rename 才是原子的,也不跨设备。
        const rand = randomBytes(6).toString("hex");
        tmpPath = path.join(dir, `.upload-${rand}.part`);
        const hash = createHash("sha256");
        let bytes = 0;
        const ws = createWriteStream(tmpPath);
        await new Promise<void>((resolve, reject) => {
          part.file.on("data", (c: Buffer) => { bytes += c.length; hash.update(c); });
          part.file.on("error", reject);
          ws.on("error", reject);
          ws.on("finish", () => resolve());
          part.file.pipe(ws);
        });
        // **唯一真正生效的超限判据。** 别在旁边再写「双保险」——
        // 那两道实测都不响,留着只会让人以为有冗余而把这一道删掉。
        if ((part.file as unknown as { truncated?: boolean }).truncated) {
          rejected = { code: 413, msg: `文件超过上限（${Math.round(MAX_BINARY_BYTES / 1048576)} MB）。` };
          continue;
        }
        saved = { name: fname, size: bytes, sha256: hash.digest("hex") };
      }
    } catch (err) {
      // 超大文件排在最后一个 part 时,插件的 RequestFileTooLargeError 是从
      // for-await 里抛出来的,不 catch 的话变成 500 + 英文原文。
      const e = err as { code?: string; statusCode?: number; message?: string };
      rejected = (e.code === "FST_REQ_FILE_TOO_LARGE" || e.statusCode === 413)
        ? { code: 413, msg: `文件超过上限（${Math.round(MAX_BINARY_BYTES / 1048576)} MB）。` }
        : { code: 500, msg: e.message || "上传失败" };
    } finally {
      if (lockedName) binaryUploadsInFlight.delete(lockedName);
    }

    const cleanup = async () => { if (tmpPath) await fs.unlink(tmpPath).catch(() => undefined); };

    if (rejected || !saved) {
      await cleanup();
      const r = rejected ?? { code: 400, msg: "没有收到文件。" };
      await audit(req, u.id, "app_binary.upload_rejected", {
        targetType: "client_release", targetId: platform, details: { reason: r.msg.slice(0, 200) },
      });
      return reply.code(r.code).send({ ok: false, error: r.msg });
    }

    // ── 最值钱的一步:和清单比对 ──
    const rel = platform === "android"
      ? await android.getLatestRelease()
      : await desktop.getLatestRelease();
    let declared: { sha256: string; sizeBytes: number } | null = null;
    if (rel) {
      if (platform === "android") {
        const r = rel as { filename: string; sha256: string; sizeBytes: number };
        if (r.filename === saved.name) declared = { sha256: r.sha256, sizeBytes: r.sizeBytes };
      } else {
        for (const a of Object.values((rel as { assets: Record<string, { filename: string; sha256: string; sizeBytes: number }> }).assets)) {
          if (a?.filename === saved.name) declared = { sha256: a.sha256, sizeBytes: a.sizeBytes };
        }
      }
    }
    if (declared && declared.sha256 && declared.sha256.toLowerCase() !== saved.sha256) {
      await cleanup();
      await audit(req, u.id, "app_binary.upload_rejected", {
        targetType: "client_release", targetId: platform,
        details: { reason: "sha256_mismatch", file: saved.name },
      });
      return reply.code(409).send({
        ok: false,
        error: "这个包和清单里写的对不上 —— 没有保存。\n"
          + `清单里写的：${declared.sha256}\n`
          + `你传上来的：${saved.sha256}\n`
          + "客户端下载完会校验这个值，不匹配就会一直重试而且不告诉用户为什么。"
          + "要么重传正确的包，要么先把清单里的 sha256 改成上面这个值。",
      });
    }

    // 校验过了才原子落位。线上那份在这之前一个字节都没动过。
    const finalPath = path.join(dir, saved.name);
    await fs.rename(tmpPath!, finalPath);
    tmpPath = null;

    await audit(req, u.id, "app_binary.upload", {
      targetType: "client_release", targetId: platform,
      details: { file: saved.name, sizeBytes: saved.size, sha256: saved.sha256 },
    });
    return reply.send({
      ok: true,
      file: saved.name,
      sizeBytes: saved.size,
      sha256: saved.sha256,
      // 清单里没写 sha256 的话要**明确告诉他**,别默默通过 ——
      // 那意味着这一版发出去不会有任何客户端校验。
      unverified: !declared || !declared.sha256,
      referenced: !!declared,
    });
  });

  app.post<{ Params: { platform: string; filename: string } }>(
    "/admin/client-release/:platform/binary/:filename/delete", {
      config: { oauthScope: "deny", rateLimit: { max: 20, timeWindow: "10 minutes" } },
    }, async (req, reply) => {
      const u = await requireAdmin(req, reply);
      if (!u) return reply;
      if (!verifyCsrf(req, reply)) return;
      const p = z.enum(["android", "desktop"]).safeParse(req.params.platform);
      if (!p.success) return reply.code(400).send("bad_platform");
      const name = req.params.filename;
      // 删除也要过文件名判据 —— 它同时挡住了目录穿越。
      const desktop = await import("../lib/desktop_release.js");
      const android = await import("../lib/android_release.js");
      const ok = p.data === "android" ? android.isServableApkName(name)
        : desktop.isServableBinaryName(name);
      // .part 是上传残留,也允许删(它不满足上面的判据)。
      const isPart = /^\.upload-[0-9a-f]{12}\.part$/.test(name);
      if (!ok && !isPart) return reply.code(400).send("invalid_filename");
      const full = path.join(BIN_DIRS[p.data], name);
      // 二次确认没跑出目录:path.join 对 .. 不设防,判据在上面,这里兜底。
      if (!full.startsWith(BIN_DIRS[p.data] + path.sep)) return reply.code(400).send("invalid_filename");
      await unlink(full).catch(() => undefined);
      await audit(req, u.id, "app_binary.delete", {
        targetType: "client_release", targetId: p.data, details: { file: name },
      });
      return reply.redirect("/admin/client-release?success=" + encodeURIComponent(`已删除 ${name}`));
    },
  );

  void asc;
}
