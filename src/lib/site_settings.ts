import path from "node:path";
import crypto from "node:crypto";
import { existsSync as fsExistsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { updateBrandForEmails, updateEmailBranding, updateEmailLocale } from "./email_templates.js";
import { isCaptchaProvider, isBuiltinMode, type CaptchaConfig, type CaptchaProvider, type BuiltinMode } from "./captcha/index.js";

export type SettingsView = {
  siteName: string;
  logoUrl: string | null;
  registrationMode: "closed" | "public" | "invite";
  // 建号闸门。空串 = 域名不限制;0 = 每日建号数不限制。见 schema.ts 的说明。
  signupDomainAllowlist: string;
  signupDailyQuota: number;
  icpNumber: string | null;
  icpUrl: string;
  ssoKeycloakEnabled: boolean;
  ssoKeycloakIssuerUrl: string | null;
  ssoKeycloakClientId: string | null;
  ssoKeycloakLabel: string;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPass: string | null;
  mailFromAddress: string | null;
  mailFromName: string;
  themePalette: string;
  themeDensity: string;
  riskLoginEnabled: boolean;
  lockoutEnabled: boolean;
  lockoutThreshold: number;
  lockoutMinutes: number;
  apiEnabled: boolean;
  appsEnabled: boolean;
  qrLoginEnabled: boolean;
  defaultLocale: string;
  forceAdminMfa: boolean;
  requirePasskeyUv: boolean;
  ssoSatisfiesMfa: boolean;
  embedEnabled: boolean;
  embedFrameAncestors: string;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string | null;
  // CalDAV 集合的同步纪元。掺进每个日历的 ctag,bump 一次 = 所有 CalDAV
  // 客户端下一轮轮询时会重新列一遍事件清单。见 schema.ts 上的说明。
  caldavSyncEpoch: string;
  // CAPTCHA — provider + public site key are safe for the wide-read view.
  // The secret is NOT here; read it only via getCaptchaConfig().
  captchaProvider: CaptchaProvider;
  captchaSiteKey: string | null;
  captchaBuiltinMode: BuiltinMode;
  // Email branding (editable in /admin/email-templates).
  emailBrandColor: string;
  emailFooterNote: string;
  // BIMI inbox-avatar SVG (editable in /admin/smtp). bimiSvgUrl null = bundled default.
  bimiSvgUrl: string | null;
  bimiVmcUrl: string | null;
  // External IdP (Keycloak) API auth — see schema.ts.
  idpApiEnabled: boolean;
  idpApiServiceClients: string;
  idpApiAutoProvision: boolean;
};

// In-memory cache. Reset via reload() after admin updates.
let cached: SettingsView | null = null;

async function loadFromDb(): Promise<SettingsView> {
  const [row] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
  if (!row) {
    // Bootstrap: insert defaults sourced from env, then re-read.
    await db.insert(schema.siteSettings).values({
      id: 1,
      siteName: env.SITE_NAME,
      icpNumber: env.ICP_NUMBER ?? null,
      icpUrl: env.ICP_URL,
    }).onConflictDoNothing();
    const [seeded] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
    if (!seeded) throw new Error("site_settings seed failed");
    return toView(seeded);
  }
  return toView(row);
}

// 上传的 Logo 文件是否还在磁盘上。
//
// 为什么要查:logoUrl 存在数据库里,但文件躺在 src/public/uploads/。
// 迁移服务器、重装、或者手滑删掉 uploads 之后,数据库记录还在,于是
// 页面 <img> 裂图、更糟的是 manifest 的第一个 icon 指向 404,浏览器
// 认这个图标 → PWA「安装到桌面」的图标就是坏的(rl.lz-ss.com 上实际
// 发生过)。文件不在就当没配过 Logo,回落到内置图标。
//
// 结果缓存在 settings 缓存的生命周期内,不会每次请求都打磁盘。
function logoFileExists(logoUrl: string | null): boolean {
  if (!logoUrl) return false;
  // 外链 Logo(http/https)不归我们管,原样放行。
  if (/^https?:\/\//i.test(logoUrl)) return true;
  if (!logoUrl.startsWith("/static/")) return false;
  const rel = logoUrl.replace(/^\/static\//, "").split("?")[0]!;
  try {
    return fsExistsSync(path.join(process.cwd(), "src", "public", rel));
  } catch {
    return false;
  }
}

// 老库里的 site_settings 行。
//
// 为什么不用 schema.SiteSettings 直接当参数:这个产品的迁移是开机自动跑的,
// 而迁移器状态和真实 schema 对不上是本仓库出过的事(见 auto_migrate.ts 顶上
// 那段)。真发生时,读回来的行**根本没有**新列这个属性 —— 是 undefined,
// 不是 null。行类型里它是 `string`/`number`,TS 看不出这种情况,于是
// 「忘了写回落」这个错误能一路编译通过、部署成功,直到升级当天注册全挂。
// 把新列在参数类型里标成可选,TS 就会逼着每一处写回落。
// 以后每加一个新列,先加进这个 Partial 里,等它在所有存量库上都落地了再摘掉。
type SettingsRow =
  Omit<schema.SiteSettings, "signupDomainAllowlist" | "signupDailyQuota" | "caldavSyncEpoch">
  & Partial<Pick<schema.SiteSettings, "signupDomainAllowlist" | "signupDailyQuota" | "caldavSyncEpoch">>;

// 导出只是为了测试能直接喂一行进来 —— 纯逻辑测试档里没有 Postgres,
// 走 getSettings() 就得起一个真数据库。这是「行 → 视图」的唯一回落口径。
export function toView(r: SettingsRow): SettingsView {
  const mode = (r.registrationMode === "closed" || r.registrationMode === "public" || r.registrationMode === "invite")
    ? r.registrationMode : "public";
  return {
    siteName: r.siteName || env.SITE_NAME,
    logoUrl: logoFileExists(r.logoUrl) ? r.logoUrl : null,
    registrationMode: mode,
    // 列不存在(老库)一律回落到「不限制」,不是回落到「全拒」。
    // 升级不能让一台本来能注册的服务器当天开始拒绝建号 —— 管理员没改过
    // 任何设置,不会想到去翻这两项,只会看到「注册坏了」。
    // 用 ?? 不用 ||:管理员真把配额填成 0 就是「不限」,|| 也是 0,巧合而已;
    // 但域名白名单那边 "" 和 undefined 语义相同,写 ?? 是为了两行口径一致。
    signupDomainAllowlist: r.signupDomainAllowlist ?? "",
    signupDailyQuota: r.signupDailyQuota ?? 0,
    icpNumber: r.icpNumber || env.ICP_NUMBER || null,
    icpUrl: r.icpUrl || env.ICP_URL,
    ssoKeycloakEnabled: r.ssoKeycloakEnabled,
    ssoKeycloakIssuerUrl: r.ssoKeycloakIssuerUrl,
    ssoKeycloakClientId: r.ssoKeycloakClientId,
    ssoKeycloakLabel: r.ssoKeycloakLabel || "使用 SSO 登录",
    smtpHost: r.smtpHost || env.SMTP_HOST || null,
    smtpPort: r.smtpPort ?? env.SMTP_PORT,
    smtpSecure: r.smtpSecure,
    smtpUser: r.smtpUser || env.SMTP_USER || null,
    smtpPass: r.smtpPass || env.SMTP_PASS || null,
    mailFromAddress: r.mailFromAddress || env.MAIL_FROM_ADDRESS || null,
    mailFromName: r.mailFromName || env.MAIL_FROM_NAME,
    themePalette: r.themePalette || "indigo",
    themeDensity: r.themeDensity || "comfortable",
    riskLoginEnabled: r.riskLoginEnabled,
    lockoutEnabled: r.lockoutEnabled,
    lockoutThreshold: r.lockoutThreshold || 5,
    lockoutMinutes: r.lockoutMinutes || 15,
    apiEnabled: r.apiEnabled,
    appsEnabled: r.appsEnabled,
    qrLoginEnabled: r.qrLoginEnabled,
    defaultLocale: r.defaultLocale || "zh-CN",
    forceAdminMfa: r.forceAdminMfa,
    // 列不存在(老库、或者迁移器记账脱节)时回落到**保持现状**那一侧,
    // 和列默认值一致 —— 三处写别的,「补上了」反而是改了行为。
    requirePasskeyUv: r.requirePasskeyUv ?? true,
    ssoSatisfiesMfa: r.ssoSatisfiesMfa ?? true,
    embedEnabled: r.embedEnabled,
    embedFrameAncestors: r.embedFrameAncestors ?? "",
    vapidPublicKey: r.vapidPublicKey,
    vapidPrivateKey: r.vapidPrivateKey,
    vapidSubject: r.vapidSubject,
    // 列不存在(老库、或者迁移器记账脱节)回落到空串 —— 和这一列的默认值一致。
    // 回落到空串的代价是「这台机器上的 bump 暂时不生效」,不是「ctag 乱跳」:
    // 空串本身是个稳定取值,ctag 对同一份数据照样稳定,客户端不会无限重同步。
    // 这个窗口到下一次开机为止 —— auto_migrate.ts 的兜底补丁会把列补回来。
    caldavSyncEpoch: r.caldavSyncEpoch ?? "",
    captchaProvider: isCaptchaProvider(r.captchaProvider) ? r.captchaProvider : "builtin",
    captchaSiteKey: r.captchaSiteKey ?? null,
    captchaBuiltinMode: isBuiltinMode(r.captchaBuiltinMode) ? r.captchaBuiltinMode : "invisible",
    emailBrandColor: r.emailBrandColor || "#4f46e5",
    emailFooterNote: r.emailFooterNote || "日历共享平台",
    bimiSvgUrl: r.bimiSvgUrl ?? null,
    bimiVmcUrl: r.bimiVmcUrl ?? null,
    idpApiEnabled: r.idpApiEnabled,
    idpApiServiceClients: r.idpApiServiceClients || "",
    idpApiAutoProvision: r.idpApiAutoProvision,
  };
}

/** CAPTCHA config incl. the secret — read narrowly (never goes to templates). */
export async function getCaptchaConfig(): Promise<CaptchaConfig> {
  const [row] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
  const provider: CaptchaProvider = isCaptchaProvider(row?.captchaProvider) ? row!.captchaProvider : "builtin";
  const builtinMode: BuiltinMode = isBuiltinMode(row?.captchaBuiltinMode) ? row!.captchaBuiltinMode : "invisible";
  return { provider, siteKey: row?.captchaSiteKey ?? null, secret: row?.captchaSecret ?? null, builtinMode };
}

export async function getSettings(): Promise<SettingsView> {
  if (!cached) {
    cached = await loadFromDb();
    updateBrandForEmails(cached.siteName);
    updateEmailBranding({ brandColor: cached.emailBrandColor, footerNote: cached.emailFooterNote, logoUrl: cached.logoUrl });
    updateEmailLocale(cached.defaultLocale);
  }
  return cached;
}

export function reloadSettings(): void { cached = null; }

export type SsoSecret = {
  enabled: boolean;
  issuerUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
};

export async function getSsoConfig(): Promise<SsoSecret> {
  const [row] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
  if (!row) return { enabled: false, issuerUrl: null, clientId: null, clientSecret: null };
  return {
    enabled: row.ssoKeycloakEnabled,
    issuerUrl: row.ssoKeycloakIssuerUrl,
    clientId: row.ssoKeycloakClientId,
    clientSecret: row.ssoKeycloakClientSecret,
  };
}

export async function updateSettings(patch: Partial<{
  siteName: string;
  logoUrl: string | null;
  registrationMode: "closed" | "public" | "invite";
  signupDomainAllowlist: string;
  signupDailyQuota: number;
  icpNumber: string | null;
  icpUrl: string;
  ssoKeycloakEnabled: boolean;
  ssoKeycloakIssuerUrl: string | null;
  ssoKeycloakClientId: string | null;
  ssoKeycloakClientSecret: string | null;
  ssoKeycloakLabel: string;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPass: string | null;
  mailFromAddress: string | null;
  mailFromName: string;
  themePalette: string;
  themeDensity: string;
  riskLoginEnabled: boolean;
  lockoutEnabled: boolean;
  lockoutThreshold: number;
  lockoutMinutes: number;
  apiEnabled: boolean;
  appsEnabled: boolean;
  qrLoginEnabled: boolean;
  defaultLocale: string;
  forceAdminMfa: boolean;
  requirePasskeyUv: boolean;
  ssoSatisfiesMfa: boolean;
  embedEnabled: boolean;
  embedFrameAncestors: string;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string | null;
  captchaProvider: string;
  captchaSiteKey: string | null;
  captchaSecret: string | null;
  captchaBuiltinMode: string;
  emailBrandColor: string;
  emailFooterNote: string;
  bimiSvgUrl: string | null;
  bimiVmcUrl: string | null;
  idpApiEnabled: boolean;
  idpApiServiceClients: string;
  idpApiAutoProvision: boolean;
  caldavSyncEpoch: string;
}>): Promise<void> {
  await db
    .update(schema.siteSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.siteSettings.id, 1));
  reloadSettings();
}

/**
 * 手动 bump 一次 CalDAV 同步纪元。
 *
 * 效果:所有 CalDAV 客户端在下一轮轮询里会发现 ctag 变了,于是各自做**一次**
 * Depth:1 PROPFIND 把事件清单重新列一遍。清单里每条的 etag 不受纪元影响
 * (见 src/web/caldav.ts 的 calendarCtags / etagOf),所以正文一条都不会重下 ——
 * 这是「让客户端重新看一眼」,不是「让客户端重下整个日历」。
 *
 * 什么时候用:发版改了序列化口径、而数据一行没动的时候(合成 VEVENT 开始带
 * VALARM 就是这种)。常规发版用不着 —— 正常的增删改本来就会动 updated_at,
 * ctag 自己会变。
 *
 * 写一个随机串而不是 now():两次 bump 之间如果在同一秒,时间戳会一模一样,
 * 于是第二次 bump 什么都没发生、也不报错 —— 正是这个仓库最常见的那种失效形态。
 * 随机串没有这个窗口。
 *
 * **进程内缓存的边界**:这里 reload 的只有当前进程。多进程(pm2 cluster)
 * 部署下,别的 worker 要到下一次重启才读到新值,期间它们发的 ctag 还是旧的。
 * 迁移里的 bump 不受影响(每个 worker 开机时都重新读一遍),所以这条只影响
 * 「以后加的后台按钮」——真加按钮的时候要么单进程、要么另做一次跨进程失效。
 */
export async function bumpCaldavSyncEpoch(): Promise<string> {
  const value = `manual:${new Date().toISOString()}:${crypto.randomBytes(6).toString("hex")}`;
  await updateSettings({ caldavSyncEpoch: value });
  return value;
}
