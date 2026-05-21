import { createHash, randomBytes } from "node:crypto";
import { getSsoConfig } from "./site_settings.js";

export type OidcConfig = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
};

const TTL_MS = 60 * 60 * 1000; // 1 hour
let cached: { url: string; conf: OidcConfig; ts: number } | null = null;

export async function discoverOidc(): Promise<OidcConfig> {
  const sso = await getSsoConfig();
  if (!sso.enabled || !sso.issuerUrl) throw new Error("SSO 未启用");
  const issuer = sso.issuerUrl.replace(/\/$/, "");
  if (cached && cached.url === issuer && Date.now() - cached.ts < TTL_MS) return cached.conf;
  const url = `${issuer}/.well-known/openid-configuration`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`OIDC 发现失败：HTTP ${resp.status}`);
  const conf = (await resp.json()) as OidcConfig;
  cached = { url: issuer, conf, ts: Date.now() };
  return conf;
}

export function resetOidcCache(): void { cached = null; }

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
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): Promise<string> {
  const sso = await getSsoConfig();
  const conf = await discoverOidc();
  if (!sso.clientId) throw new Error("SSO clientId 未设置");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: sso.clientId,
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
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResult> {
  const sso = await getSsoConfig();
  const conf = await discoverOidc();
  if (!sso.clientId || !sso.clientSecret) throw new Error("SSO 凭据未完整");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: sso.clientId,
    client_secret: sso.clientSecret,
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

export async function fetchUserinfo(accessToken: string): Promise<UserInfo> {
  const conf = await discoverOidc();
  const resp = await fetch(conf.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`userinfo failed: HTTP ${resp.status}`);
  return (await resp.json()) as UserInfo;
}
