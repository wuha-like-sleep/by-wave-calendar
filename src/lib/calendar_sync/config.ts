import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../../db/client.js";
import { env } from "../../env.js";
import { reloadSettings } from "../site_settings.js";

export const microsoftClientIdSchema = z.string().trim().toLowerCase().pipe(z.union([z.literal(""), z.string().uuid()]));

/** Read directly so every worker sees admin changes on its next request. */
export async function getMicrosoftCalendarConfig() {
  const [row] = await db.select({ clientId: schema.siteSettings.microsoftCalendarClientId })
    .from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
  // NULL inherits the existing deployment; an explicit empty value disables
  // new connections, even when the environment still contains an application ID.
  const stored = row?.clientId ?? null;
  const parsed = microsoftClientIdSchema.safeParse(stored ?? env.MICROSOFT_CALENDAR_CLIENT_ID ?? "");
  const clientId = parsed.success ? parsed.data : "";
  return { clientId, configured: Boolean(clientId), source: stored === null ? "environment" : clientId ? "admin" : "disabled" } as const;
}

export async function setMicrosoftCalendarClientId(value: string | null) {
  const clientId = value === null ? null : microsoftClientIdSchema.parse(value);
  await db.insert(schema.siteSettings).values({
    id: 1, siteName: env.SITE_NAME, icpNumber: env.ICP_NUMBER ?? null, icpUrl: env.ICP_URL,
    microsoftCalendarClientId: clientId,
  }).onConflictDoUpdate({ target: schema.siteSettings.id, set: { microsoftCalendarClientId: clientId, updatedAt: new Date() } });
  reloadSettings();
}
