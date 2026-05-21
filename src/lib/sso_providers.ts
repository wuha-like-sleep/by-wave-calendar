import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { resetOidcCache } from "./sso.js";

export type SsoProvider = schema.SsoProvider;

export type PublicSsoProvider = {
  id: string;
  slug: string;
  label: string;
};

// Public-facing list (no client_secret) for login.ejs to render a button per.
export async function listEnabledProvidersPublic(): Promise<PublicSsoProvider[]> {
  const rows = await db
    .select({ id: schema.ssoProviders.id, slug: schema.ssoProviders.slug, label: schema.ssoProviders.label })
    .from(schema.ssoProviders)
    .where(eq(schema.ssoProviders.enabled, true))
    .orderBy(asc(schema.ssoProviders.sortOrder), asc(schema.ssoProviders.label));
  return rows;
}

// Full list (secret included) for the admin page.
export async function listAllProviders(): Promise<SsoProvider[]> {
  return db
    .select()
    .from(schema.ssoProviders)
    .orderBy(asc(schema.ssoProviders.sortOrder), asc(schema.ssoProviders.label));
}

export async function getProviderBySlug(slug: string): Promise<SsoProvider | null> {
  const [row] = await db.select().from(schema.ssoProviders).where(eq(schema.ssoProviders.slug, slug)).limit(1);
  return row ?? null;
}

export async function getProviderById(id: string): Promise<SsoProvider | null> {
  const [row] = await db.select().from(schema.ssoProviders).where(eq(schema.ssoProviders.id, id)).limit(1);
  return row ?? null;
}

export async function createProvider(input: {
  slug: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  label: string;
  enabled?: boolean;
  sortOrder?: number;
}): Promise<SsoProvider> {
  const [row] = await db.insert(schema.ssoProviders).values({
    slug: input.slug,
    issuerUrl: input.issuerUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    label: input.label,
    enabled: input.enabled ?? true,
    sortOrder: input.sortOrder ?? 0,
  }).returning();
  if (!row) throw new Error("provider insert failed");
  resetOidcCache(input.slug);
  return row;
}

export async function updateProvider(id: string, patch: Partial<{
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  label: string;
  sortOrder: number;
}>): Promise<void> {
  // If client_secret is omitted from a form, don't clobber the existing one.
  const set: Record<string, unknown> = { ...patch, updatedAt: new Date() };
  for (const k of Object.keys(set)) if (set[k] === undefined) delete set[k];
  if (Object.keys(set).length === 1) return; // only updatedAt — no real change
  const [row] = await db.update(schema.ssoProviders).set(set).where(eq(schema.ssoProviders.id, id)).returning({ slug: schema.ssoProviders.slug });
  if (row) resetOidcCache(row.slug);
}

export async function deleteProvider(id: string): Promise<void> {
  const [row] = await db.delete(schema.ssoProviders).where(eq(schema.ssoProviders.id, id)).returning({ slug: schema.ssoProviders.slug });
  if (row) resetOidcCache(row.slug);
}
