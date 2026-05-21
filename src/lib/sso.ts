import { createHash, randomBytes } from "node:crypto";
import { getProviderBySlug } from "./sso_providers.js";

export type OidcConfig = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
};

const TTL_MS = 60 * 60 * 1000; // 1 hour
// Keyed by provider slug so multiple IdPs don't fight over a single cache slot.
const discoveryCache = new Map<string, { url: string; conf: OidcConfig; ts: number }>();

export async function discoverOidc(providerSlug: string): Promise<OidcConfig> {
  const prov = await getProviderBySlug(providerSlug);
  if (!prov || !prov.enabled || !prov.issuerUrl) throw new Error(`SSO 提供方 "${providerSlug}" 未启用`);
  const issuer = prov.issuerUrl.replace(/\/$/, "");
  const hit = discoveryCache.get(providerSlug);
  if (hit && hit.url === issuer && Date.now() - hit.ts < TTL_MS) return hit.conf;
  const url = `${issuer}/.well-known/openid-configuration`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`OIDC 发现失败：HTTP ${resp.status}`);
  const conf = (await resp.json()) as OidcConfig;
  discoveryCache.set(providerSlug, { url: issuer, conf, ts: Date.now() });
  return conf;
}

export function resetOidcCache(providerSlug?: string): void {
  if (providerSlug) discoveryCache.delete(providerSlug);
  else discoveryCache.clear();
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
  return `${conf.authorization_endpoint}?${params.toString()}`;
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
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`token exchange failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as TokenResult;
}

export type UserInfo = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
};

export async function fetchUserinfo(providerSlug: string, accessToken: string): Promise<UserInfo> {
  const conf = await discoverOidc(providerSlug);
  const resp = await fetch(conf.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`userinfo failed: HTTP ${resp.status}`);
  return (await resp.json()) as UserInfo;
}
