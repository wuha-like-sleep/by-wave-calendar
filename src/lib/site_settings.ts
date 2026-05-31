import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { updateBrandForEmails, updateEmailBranding } from "./email_templates.js";
import { isCaptchaProvider, isBuiltinMode, type CaptchaConfig, type CaptchaProvider, type BuiltinMode } from "./captcha/index.js";

export type SettingsView = {
  siteName: string;
  logoUrl: string | null;
  registrationMode: "closed" | "public" | "invite";
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
  embedEnabled: boolean;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string | null;
  // CAPTCHA — provider + public site key are safe for the wide-read view.
  // The secret is NOT here; read it only via getCaptchaConfig().
  captchaProvider: CaptchaProvider;
  captchaSiteKey: string | null;
  captchaBuiltinMode: BuiltinMode;
  // Email branding (editable in /admin/email-templates).
  emailBrandColor: string;
  emailFooterNote: string;
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

function toView(r: schema.SiteSettings): SettingsView {
  const mode = (r.registrationMode === "closed" || r.registrationMode === "public" || r.registrationMode === "invite")
    ? r.registrationMode : "public";
  return {
    siteName: r.siteName || env.SITE_NAME,
    logoUrl: r.logoUrl,
    registrationMode: mode,
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
    embedEnabled: r.embedEnabled,
    vapidPublicKey: r.vapidPublicKey,
    vapidPrivateKey: r.vapidPrivateKey,
    vapidSubject: r.vapidSubject,
    captchaProvider: isCaptchaProvider(r.captchaProvider) ? r.captchaProvider : "builtin",
    captchaSiteKey: r.captchaSiteKey ?? null,
    captchaBuiltinMode: isBuiltinMode(r.captchaBuiltinMode) ? r.captchaBuiltinMode : "invisible",
    emailBrandColor: r.emailBrandColor || "#4f46e5",
    emailFooterNote: r.emailFooterNote || "日历共享平台",
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
    updateEmailBranding({ brandColor: cached.emailBrandColor, footerNote: cached.emailFooterNote });
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
  embedEnabled: boolean;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string | null;
  captchaProvider: string;
  captchaSiteKey: string | null;
  captchaSecret: string | null;
  captchaBuiltinMode: string;
  emailBrandColor: string;
  emailFooterNote: string;
}>): Promise<void> {
  await db
    .update(schema.siteSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.siteSettings.id, 1));
  reloadSettings();
}
