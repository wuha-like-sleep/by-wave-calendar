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
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { listAllProviders } from "./sso_providers.js";
import { discoverOidc } from "./sso.js";
import { getSettings } from "./site_settings.js";
import { userIsActive } from "./user_state.js";
import { isUnprovenSelfSignup, provisionAccount, type ProvisionDenial } from "./account_provisioning.js";

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

  // ---- 普通用户令牌按邮箱认到一行账号:这也是一次「认领」 -------------------
  //
  // 走到这里说明令牌**说**自己是这个邮箱。如果那一行是本站自助注册出来的、
  // 而且它自己从没证明过这个邮箱(email_verified=false + signup_source 是
  // self/invite),那就正是抢注留下的形状 —— 谁先在 /auth/register 占了这个
  // 邮箱,谁就能被后来的 IdP 用户并进同一个号里。
  //
  // 这条路**只拒绝,不作废任何凭据**。作废是一次真人登录才该做的动作(浏览器
  // SSO / 苹果登录,见 decideEmailClaim 的 adopt_after_eviction),不能由一个
  // 后台 API 调用顺手把别人的密码、会话、设备全掀掉 —— 调用方甚至不是人。
  // 真正的本人先从浏览器 SSO 或苹果登录进来一次,那边会把号理清楚,之后这条
  // 路自然就通了。
  //
  // 服务客户端不在这条判定里:X-Account 是管理员配置出来的受信任能力,它本来
  // 就可以替任何账号说话。
  // signup_source 为 null 的存量行也不在里面(见 isUnprovenSelfSignup)——
  // 那一列是后加的、明确不回填,把「不知道」当成「自助注册」会误伤一整批老账号。
  if (user && !isServiceClient && isUnprovenSelfSignup(user)) {
    // 403 不是 401:401 在 App 的 api.dart 里的意思是「会话没了」,会把已登录
    // 的人直接登出。「这次不认你是这个号」跟「你是谁我不认」是两回事。
    return { matched: true, user: null, provider, code: 403, error: "account_claim_unproven" };
  }

  let provisioned = false;
  if (!user && isServiceClient && settings.idpApiAutoProvision && decided.target.includes("@")) {
    // Bulk-provision: create a ByWave account for this email on first access.
    // 令牌里的 email_verified 说的是**令牌主体自己**那个邮箱。服务客户端用
    // X-Account 替别人开号时,那个 claim 跟目标邮箱一点关系都没有 —— 只有
    // 目标就是令牌自己的邮箱时才能拿来用。其余一律 false:宁可标成「没验过」,
    // 也不能凭一句说的是别人的断言,把一个邮箱写成已验证。
    const selfTarget =
      emailClaim !== null && emailClaim.trim().toLowerCase() === decided.target.toLowerCase();
    const r = await provisionAccountByEmail(
      decided.target.toLowerCase(),
      typeof payload.name === "string" ? payload.name : null,
      { client: serviceClient as string, emailVerified: selfTarget && payload.email_verified === true },
    );
    if (!r.ok) {
      const m = idpProvisionDenial(r.denial);
      return { matched: true, user: null, provider, code: m.code, error: m.error };
    }
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

export type IdpProvisionResult =
  | { ok: true; user: schema.User; created: boolean }
  | { ok: false; denial: ProvisionDenial };

/**
 * 建号被拒 → 这一层的 { code, error } 形态。
 *
 * 这里刻意不掺用户可见文案:调用它的两条路(懒建号走 ExternalResolve、
 * /accounts 走 err())都是给机器看的,error 这个 snake_case 串就是契约。
 *
 * 全部走 4xx/5xx,**没有一条是 401**:401 在 App 那边的意思是「会话没了」,
 * 会把已登录的人踢出去。「这次没让你开号」跟「你是谁我不认」是两回事。
 */
export function idpProvisionDenial(d: ProvisionDenial): { code: number; error: string } {
  switch (d.code) {
    case "invalid_email": return { code: 400, error: "invalid_email" };
    case "registration_closed": return { code: 403, error: "signup_closed" };
    // 邀请制下服务客户端天生带不出邀请码,所以这两条对它是同一件事:
    // 「本站现在只认邀请码开号」。分开报也没有任何它能做的补救动作。
    case "invite_required":
    case "invite_invalid": return { code: 403, error: "signup_invite_only" };
    case "domain_not_allowed": return { code: 403, error: "signup_domain_not_allowed" };
    case "daily_quota_reached": return { code: 403, error: "signup_quota_reached" };
    case "email_taken": return { code: 409, error: "email_taken" };
    case "create_failed": return { code: 500, error: "provision_failed" };
  }
}

/**
 * 受信任服务客户端替某个邮箱开号。**自己不 insert**,一律过建号收口函数 ——
 * 正是这条路在 45 天里建了 30 个号,而注册策略开关对它完全无效。
 *
 * emailVerified 必须由调用方给出真实值。以前这里硬写 true,于是「这个邮箱
 * 到底验没验过」这个事实在库里被抹掉了,后面没有任何一层还能知道。
 */
export async function provisionAccountByEmail(
  email: string,
  displayName: string | null,
  opts: { client: string; emailVerified: boolean },
): Promise<IdpProvisionResult> {
  const r = await provisionAccount({
    email,
    origin: { kind: "idp", client: opts.client },
    emailVerified: opts.emailVerified,
    // 显示名的回落留在这一层。收口函数不替调用方想这个 —— 搬走的话这批号的
    // 显示名会从「张三」变成 null,而且是悄悄变。
    displayName: displayName || email.split("@")[0] || email,
    // 懒建号是登录类路径:邮箱已有账号就认回同一个人,不是「邮箱被占用」。
    //
    // 这个 adopt 只在**并发**下才会真的发生:调用方走到这里之前已经
    // lookupUser 过一次,邮箱有主的话根本不会进来。抢注那条路是在上面
    // isUnprovenSelfSignup 那道判定里挡的,不在这儿 —— 挪到这里的话,
    // 服务客户端(受信任、可以替任何账号说话)会跟着一起被挡。
    onExistingEmail: "adopt",
  });
  if (!r.ok) return { ok: false, denial: r.reason };
  return { ok: true, user: r.user, created: r.created };
}
