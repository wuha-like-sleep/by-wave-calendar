import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { getProviderBySlug } from "./sso_providers.js";

export type OidcConfig = {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
};

const TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 10_000;
// Keyed by provider slug so multiple IdPs don't fight over a single cache slot.
const discoveryCache = new Map<string, { url: string; conf: OidcConfig; ts: number }>();
const jwksCache = new Map<string, { url: string; keys: ReturnType<typeof createRemoteJWKSet> }>();
const OIDC_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];
const endpointSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, "OIDC endpoint must be an HTTP(S) URL without credentials or a fragment");
const discoverySchema = z.object({
  issuer: endpointSchema,
  jwks_uri: endpointSchema,
  authorization_endpoint: endpointSchema,
  token_endpoint: endpointSchema,
  userinfo_endpoint: endpointSchema,
  end_session_endpoint: endpointSchema.optional(),
});

export async function discoverOidc(providerSlug: string): Promise<OidcConfig> {
  const prov = await getProviderBySlug(providerSlug);
  if (!prov || !prov.enabled || !prov.issuerUrl) throw new Error(`SSO 提供方 "${providerSlug}" 未启用`);
  const issuer = prov.issuerUrl.replace(/\/$/, "");
  const hit = discoveryCache.get(providerSlug);
  if (hit && hit.url === issuer && Date.now() - hit.ts < TTL_MS) return hit.conf;
  const url = `${issuer}/.well-known/openid-configuration`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`OIDC 发现失败：HTTP ${resp.status}`);
  }
  const conf = discoverySchema.parse(await resp.json());
  if (conf.issuer !== prov.issuerUrl && conf.issuer !== issuer) {
    throw new Error("OIDC discovery issuer does not match the configured provider");
  }
  discoveryCache.set(providerSlug, { url: issuer, conf, ts: Date.now() });
  return conf;
}

export function resetOidcCache(providerSlug?: string): void {
  if (providerSlug) {
    discoveryCache.delete(providerSlug);
    jwksCache.delete(providerSlug);
  } else {
    discoveryCache.clear();
    jwksCache.clear();
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return base64UrlEncode(randomBytes(24));
}

export async function buildAuthorizeUrl(opts: {
  providerSlug: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): Promise<string> {
  const prov = await getProviderBySlug(opts.providerSlug);
  if (!prov) throw new Error(`SSO 提供方 "${opts.providerSlug}" 不存在`);
  const conf = await discoverOidc(opts.providerSlug);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: prov.clientId,
    redirect_uri: opts.redirectUri,
    scope: "openid profile email",
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  const url = new URL(conf.authorization_endpoint);
  for (const [name, value] of params) url.searchParams.set(name, value);
  return url.toString();
}

export type TokenResult = {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

export async function exchangeCode(opts: {
  providerSlug: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResult> {
  const prov = await getProviderBySlug(opts.providerSlug);
  if (!prov || !prov.clientId || !prov.clientSecret) throw new Error("SSO 凭据未完整");
  const conf = await discoverOidc(opts.providerSlug);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: prov.clientId,
    client_secret: prov.clientSecret,
    code_verifier: opts.codeVerifier,
  });
  const resp = await fetch(conf.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`token exchange failed: HTTP ${resp.status}`);
  }
  return z.object({
    access_token: z.string().min(1), id_token: z.string().min(1).max(32_768),
    refresh_token: z.string().optional(), expires_in: z.number().optional(), token_type: z.string().optional(),
  }).parse(await resp.json());
}

export type UserInfo = {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  preferred_username?: string;
};

export async function fetchUserinfo(providerSlug: string, accessToken: string): Promise<UserInfo> {
  const conf = await discoverOidc(providerSlug);
  const resp = await fetch(conf.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`userinfo failed: HTTP ${resp.status}`);
  }
  return z.object({
    sub: z.string().min(1), email: z.string().optional(),
    // Existing providers may emit the boolean claim as a string.
    email_verified: z.union([z.boolean(), z.string()]).optional(),
    name: z.string().optional(), preferred_username: z.string().optional(),
  }).parse(await resp.json());
}

/** Authenticate the ID token before trusting userinfo or linking an account. */
export async function fetchVerifiedUserinfo(providerSlug: string, tokens: TokenResult, nonce: string): Promise<UserInfo> {
  const prov = await getProviderBySlug(providerSlug);
  if (!prov || !prov.enabled) throw new Error("SSO provider is disabled");
  const conf = await discoverOidc(providerSlug);
  let cached = jwksCache.get(providerSlug);
  if (!cached || cached.url !== conf.jwks_uri) {
    cached = { url: conf.jwks_uri, keys: createRemoteJWKSet(new URL(conf.jwks_uri), { timeoutDuration: REQUEST_TIMEOUT_MS }) };
    jwksCache.set(providerSlug, cached);
  }
  const { payload } = await jwtVerify(tokens.id_token, cached.keys, {
    algorithms: OIDC_ALGORITHMS, issuer: conf.issuer, audience: prov.clientId,
    requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"], clockTolerance: 30,
  });
  if (!payload.sub || !nonce || payload.nonce !== nonce
      || typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + 30
      || (payload.azp !== undefined && payload.azp !== prov.clientId)
      || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== prov.clientId)) {
    throw new Error("OIDC identity claims do not match this login");
  }
  const info = await fetchUserinfo(providerSlug, tokens.access_token);
  if (info.sub !== payload.sub) throw new Error("OIDC userinfo subject does not match the ID token");
  return info;
}
