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
  | { matched: true; user: schema.User; provider: string; serviceClient: string | null; provisioned: boolean }
  | { matched: true; user: null; provider: string | null; code: number; error: string };

// Shared token verification: decode → match enabled provider by iss → feature
// gate → JWKS signature/iss/exp/alg → reject ID tokens → authorized-party. The
// SINGLE source of truth used by both the per-user resolver and the
// service-client (platform) path, so those security checks can never drift.
type IdpVerified =
  | { state: "not_idp" }
  | { state: "rejected"; provider: string | null; code: number; error: string }
  | { state: "ok"; provider: string; payload: Record<string, unknown>; serviceClient: string | null; isLoginClient: boolean };

async function verifyIdpToken(token: string): Promise<IdpVerified> {
  let unverified: ReturnType<typeof decodeJwt>;
  try {
    unverified = decodeJwt(token);
  } catch {
    return { state: "not_idp" };
  }
  const iss = typeof unverified.iss === "string" ? stripSlash(unverified.iss) : null;
  if (!iss) return { state: "not_idp" };

  const provs = await enabledProviders();
  const prov = provs.find((p) => p.issuer === iss);
  if (!prov) return { state: "not_idp" }; // not one of our IdPs → caller falls through

  // Feature gate — master「API」switch + the external-IdP sub-toggle.
  const settings = await getSettings();
  if (!settings.apiEnabled || !settings.idpApiEnabled) {
    return { state: "rejected", provider: prov.slug, code: 403, error: "idp_api_disabled" };
  }

  // Verify signature + iss + exp via the provider's JWKS.
  let jwks = jwksByIssuer.get(iss);
  if (!jwks) {
    let jwksUri: string | undefined;
    try {
      const conf = (await discoverOidc(prov.slug)) as { jwks_uri?: string };
      jwksUri = conf.jwks_uri;
    } catch {
      return { state: "rejected", provider: prov.slug, code: 503, error: "idp_discovery_failed" };
    }
    if (!jwksUri) return { state: "rejected", provider: prov.slug, code: 503, error: "idp_no_jwks" };
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksByIssuer.set(iss, jwks);
  }

  let payload: Record<string, unknown>;
  try {
    // clockTolerance absorbs small skew between Keycloak and this server.
    const res = await jwtVerify(token, jwks, { issuer: iss, algorithms: IDP_ALGS, clockTolerance: 30 });
    payload = res.payload as Record<string, unknown>;
  } catch {
    return { state: "rejected", provider: prov.slug, code: 401, error: "idp_token_invalid" };
  }
  // Only ACCESS tokens are valid API credentials — reject ID tokens (typ:"ID").
  if (payload.typ === "ID") {
    return { state: "rejected", provider: prov.slug, code: 401, error: "idp_id_token_rejected" };
  }

  // Authorized-party check: login client (ordinary user) or a configured
  // service client. Anything else from the same realm is rejected.
  const serviceClients = parseClientList(settings.idpApiServiceClients);
  const clientIds = tokenClientIds(payload);
  const serviceClient = clientIds.find((c) => serviceClients.has(c)) ?? null;
  const isLoginClient = clientIds.includes(prov.clientId);
  if (!serviceClient && !isLoginClient) {
    return { state: "rejected", provider: prov.slug, code: 403, error: "idp_audience_rejected" };
  }
  return { state: "ok", provider: prov.slug, payload, serviceClient, isLoginClient };
}

export async function resolveExternalIdpUser(token: string, req: FastifyRequest): Promise<ExternalResolve> {
  const v = await verifyIdpToken(token);
  if (v.state === "not_idp") return { matched: false };
  if (v.state === "rejected") return { matched: true, user: null, provider: v.provider, code: v.code, error: v.error };

  const { provider, payload, serviceClient } = v;
  const isServiceClient = serviceClient !== null;
  const settings = await getSettings();

  // Resolve the target account under the security model.
  const emailClaim = typeof payload.email === "string" ? payload.email : null;
  const accountHeader = typeof req.headers["x-account"] === "string" ? (req.headers["x-account"] as string) : null;
  const decided = decideTarget({ isServiceClient, emailClaim, accountHeader });
  if ("error" in decided) {
    return { matched: true, user: null, provider, code: 400, error: decided.error };
  }

  let user = await lookupUser(decided.target);
  let provisioned = false;
  if (!user && isServiceClient && settings.idpApiAutoProvision && decided.target.includes("@")) {
    // Bulk-provision: create a ByWave account for this email on first access.
    const r = await provisionAccountByEmail(decided.target.toLowerCase(), typeof payload.name === "string" ? payload.name : null);
    user = r.user;
    provisioned = r.created;
  }
  if (!user) return { matched: true, user: null, provider, code: 404, error: "account_not_found" };
  if (!userIsActive(user)) return { matched: true, user: null, provider, code: 403, error: "account_disabled" };
  return { matched: true, user, provider, serviceClient, provisioned };
}

// Platform (service-client) authentication: verify a Keycloak service token
// WITHOUT requiring an X-Account / user resolution. Used by the account
// management endpoints (list / bulk-provision). Only tokens whose azp/aud is a
// configured service client pass — ordinary user (login-client) tokens are
// rejected, so a regular user can never list or provision accounts.
export type ServiceClientAuth = { provider: string; client: string };
export async function verifyServiceClient(
  token: string,
): Promise<{ ok: true; auth: ServiceClientAuth } | { ok: false; code: number; error: string }> {
  const v = await verifyIdpToken(token);
  if (v.state === "not_idp") return { ok: false, code: 401, error: "not_an_idp_token" };
  if (v.state === "rejected") return { ok: false, code: v.code, error: v.error };
  if (!v.serviceClient) return { ok: false, code: 403, error: "service_client_required" };
  return { ok: true, auth: { provider: v.provider, client: v.serviceClient } };
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

export async function provisionAccountByEmail(email: string, displayName: string | null): Promise<{ user: schema.User | undefined; created: boolean }> {
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
    return { user: created, created: true };
  }
  // Lost a race — re-read (the account exists, but WE didn't create it).
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return { user: existing, created: false };
}
