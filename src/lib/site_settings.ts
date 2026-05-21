import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";

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
  };
}

export async function getSettings(): Promise<SettingsView> {
  if (!cached) cached = await loadFromDb();
  return cached;
}

export function reloadSettings(): void { cached = null; }

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
}>): Promise<void> {
  await db
    .update(schema.siteSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.siteSettings.id, 1));
  reloadSettings();
}
