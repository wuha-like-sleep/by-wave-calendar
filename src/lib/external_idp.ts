// ByWave as an OAuth 2.0 *resource server* for an external IdP (Keycloak).
//
// When `idpApiEnabled` is on, /api/v1 accepts access tokens issued by an
// enabled SSO provider. The token is validated against the provider's JWKS
// (via OIDC discovery, reusing src/lib/sso.ts), then mapped to a ByWave
// account. Security model:
//
//   • Ordinary user token  → may ONLY act as the account matching the token's
//                            own `email` claim. An X-Account header that names
//                            a different account is rejected.
//   • Trusted service token → a client whose `azp`/`aud` is listed in
//                            idpApiServiceClients (e.g. the meeting platform's
//                            Keycloak client) MAY pass `X-Account: <email|uuid>`
//                            to act on behalf of any account. With autoProvision
//                            on, a missing account is created on first use.
//
// Keycloak access tokens are RS256 JWTs that also start with "eyJ", so they
// look identical to our device JWTs to a regexp. This resolver returns
// { matched:false } when the token's `iss` doesn't equal a configured
// provider issuer, so the caller can fall through to the device-token path.

import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { listAllProviders } from "./sso_providers.js";
import { discoverOidc } from "./sso.js";
import { getSettings } from "./site_settings.js";
import { userIsActive } from "./user_state.js";
import { hashPassword } from "./password.js";

// Asymmetric algorithms only — Keycloak signs access tokens with RS256 by
// default. Pinning this (vs letting jose accept whatever the JWK advertises)
// blocks any algorithm-confusion shenanigans (e.g. a forged HS* token).
const IDP_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];

type RemoteJWKS = ReturnType<typeof createRemoteJWKSet>;
const jwksByIssuer = new Map<string, RemoteJWKS>();

// Short cache of enabled providers (issuer → slug/clientId) so we don't hit
// the DB on every API request. Invalidated by resetExternalIdpCache().
type ProvLite = { slug: string; issuer: string; clientId: string };
let provCache: { ts: number; list: ProvLite[] } | null = null;
const PROV_TTL_MS = 60_000;

export function resetExternalIdpCache(): void {
  provCache = null;
  jwksByIssuer.clear();
}

async function enabledProviders(): Promise<ProvLite[]> {
  if (provCache && Date.now() - provCache.ts < PROV_TTL_MS) return provCache.list;
  const all = await listAllProviders();
  const list = all
    .filter((p) => p.enabled && p.issuerUrl)
    .map((p) => ({ slug: p.slug, issuer: stripSlash(p.issuerUrl as string), clientId: p.clientId }));
  provCache = { ts: Date.now(), list };
  return list;
}

// ---- pure helpers (unit-tested) -------------------------------------------

export function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function parseClientList(csv: string | null | undefined): Set<string> {
  return new Set(
    (csv ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

/** Which client IDs does this token speak for? azp + every aud entry. */
export function tokenClientIds(payload: { aud?: unknown; azp?: unknown }): string[] {
  const out: string[] = [];
  if (typeof payload.azp === "string") out.push(payload.azp);
  if (Array.isArray(payload.aud)) out.push(...payload.aud.filter((a): a is string => typeof a === "string"));
  else if (typeof payload.aud === "string") out.push(payload.aud);
  return out;
}

/**
 * Decide which account a verified token may act as.
 *  - service client → X-Account header (any account) or fall back to email claim
 *  - user token     → its own email only; a mismatched X-Account is rejected
 * Returns the target selector (email or uuid) or an error code.
 */
export function decideTarget(opts: {
  isServiceClient: boolean;
  emailClaim: string | null;
  accountHeader: string | null;
}): { target: string } | { error: string } {
  const header = opts.accountHeader?.trim() || null;
  const email = opts.emailClaim?.trim().toLowerCase() || null;
  if (opts.isServiceClient) {
    const target = header || email;
    if (!target) return { error: "x_account_required" };
    return { target };
  }
  // Ordinary user token: bound to its own email.
  if (!email) return { error: "no_email_claim" };
  if (header && header.toLowerCase() !== email && !isUuid(header)) return { error: "x_account_not_allowed" };
  if (header && isUuid(header)) return { error: "x_account_not_allowed" };
  return { target: email };
}

// ---- main resolver --------------------------------------------------------

export type ExternalResolve =
  | { matched: false }
  | { matched: true; user: schema.User; provider: string }
  | { matched: true; user: null; provider: string | null; code: number; error: string };

export async function resolveExternalIdpUser(token: string, req: FastifyRequest): Promise<ExternalResolve> {
  // 1. Cheap unverified decode to read `iss` — no trust extended yet.
  let unverified: ReturnType<typeof decodeJwt>;
  try {
    unverified = decodeJwt(token);
  } catch {
    return { matched: false };
  }
  const iss = typeof unverified.iss === "string" ? stripSlash(unverified.iss) : null;
  if (!iss) return { matched: false };

  const provs = await enabledProviders();
  const prov = provs.find((p) => p.issuer === iss);
  if (!prov) return { matched: false }; // not one of our IdPs → let device path try

  // 2. Feature gate. Require BOTH the master third-party-API switch and the
  //    external-IdP sub-toggle, so the「API」master switch is a single kill
  //    switch for every Bearer integration.
  const settings = await getSettings();
  if (!settings.apiEnabled || !settings.idpApiEnabled) {
    return { matched: true, user: null, provider: prov.slug, code: 403, error: "idp_api_disabled" };
  }

  // 3. Verify signature + iss + exp via the provider's JWKS.
  let jwks = jwksByIssuer.get(iss);
  if (!jwks) {
    let jwksUri: string | undefined;
    try {
      const conf = (await discoverOidc(prov.slug)) as { jwks_uri?: string };
      jwksUri = conf.jwks_uri;
    } catch {
      return { matched: true, user: null, provider: prov.slug, code: 503, error: "idp_discovery_failed" };
    }
    if (!jwksUri) return { matched: true, user: null, provider: prov.slug, code: 503, error: "idp_no_jwks" };
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksByIssuer.set(iss, jwks);
  }

  let payload: Record<string, unknown>;
  try {
    const res = await jwtVerify(token, jwks, { issuer: iss, algorithms: IDP_ALGS });
    payload = res.payload as Record<string, unknown>;
  } catch {
    return { matched: true, user: null, provider: prov.slug, code: 401, error: "idp_token_invalid" };
  }

  // 4. Authorized-party check. The token must speak for either the provider's
  //    own login client (ordinary user token) or a configured service client.
  const serviceClients = parseClientList(settings.idpApiServiceClients);
  const clientIds = tokenClientIds(payload);
  const isServiceClient = clientIds.some((c) => serviceClients.has(c));
  const isLoginClient = clientIds.includes(prov.clientId);
  if (!isServiceClient && !isLoginClient) {
    return { matched: true, user: null, provider: prov.slug, code: 403, error: "idp_audience_rejected" };
  }

  // 5. Resolve the target account under the security model.
  const emailClaim = typeof payload.email === "string" ? payload.email : null;
  const accountHeader = typeof req.headers["x-account"] === "string" ? (req.headers["x-account"] as string) : null;
  const decided = decideTarget({ isServiceClient, emailClaim, accountHeader });
  if ("error" in decided) {
    return { matched: true, user: null, provider: prov.slug, code: 400, error: decided.error };
  }

  let user = await lookupUser(decided.target);
  if (!user && isServiceClient && settings.idpApiAutoProvision && decided.target.includes("@")) {
    // Bulk-provision: create a ByWave account for this email on first access.
    user = await provisionAccount(decided.target.toLowerCase(), typeof payload.name === "string" ? payload.name : null);
  }
  if (!user) return { matched: true, user: null, provider: prov.slug, code: 404, error: "account_not_found" };
  if (!userIsActive(user)) return { matched: true, user: null, provider: prov.slug, code: 403, error: "account_disabled" };
  return { matched: true, user, provider: prov.slug };
}

async function lookupUser(idOrEmail: string): Promise<schema.User | undefined> {
  const v = idOrEmail.trim();
  if (isUuid(v)) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, v)).limit(1);
    if (u) return u;
  }
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, v.toLowerCase())).limit(1);
  return u;
}

async function provisionAccount(email: string, displayName: string | null): Promise<schema.User | undefined> {
  // No local password — the IdP is the source of truth. passwordHash is NOT
  // NULL, so (like the SSO signup path) store a REAL bcrypt hash of a random
  // ~256-bit value: valid bcrypt, unguessable, and safe even if some future
  // code path ever compares against it. (Never store a non-bcrypt sentinel.)
  const stubPassword = await hashPassword(randomBytes(32).toString("base64"));
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      emailVerified: true,
      passwordHash: stubPassword,
      displayName: displayName || email.split("@")[0] || email,
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    await db.insert(schema.calendars).values({
      ownerId: created.id,
      name: "My Calendar",
      color: "#6366f1",
      timezone: "Asia/Shanghai",
    });
    return created;
  }
  // Lost a race — re-read.
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return existing;
}
