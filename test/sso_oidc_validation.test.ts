import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

vi.mock("../src/lib/sso_providers.js", () => ({
  getProviderBySlug: vi.fn(async () => ({ enabled: true, issuerUrl: "https://idp.example.com", clientId: "client", clientSecret: "secret" })),
}));
import { buildAuthorizeUrl, discoverOidc, fetchVerifiedUserinfo, resetOidcCache } from "../src/lib/sso.js";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
let info: { sub: string; email: string; email_verified: boolean };
let issuer: string;

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  otherKeys = await generateKeyPair("RS256", { extractable: true });
  jwk = { ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig" };
});
beforeEach(() => {
  resetOidcCache();
  issuer = "https://idp.example.com";
  info = { sub: "subject", email: "user@example.com", email_verified: true };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    const body = path.endsWith("openid-configuration") ? {
      issuer, jwks_uri: "https://idp.example.com/jwks", authorization_endpoint: "https://idp.example.com/auth?tenant=example",
      token_endpoint: "https://idp.example.com/token", userinfo_endpoint: "https://idp.example.com/userinfo",
    } : path === "/jwks" ? { keys: [jwk] } : info;
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function token(patch: JWTPayload = {}, signingKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: "client", sub: "subject", nonce: "login-nonce", iat: now, exp: now + 300, ...patch })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).sign(signingKey);
}

it("accepts a signed identity bound to this issuer, client and nonce", async () => {
  expect(await fetchVerifiedUserinfo("test", { access_token: "access", id_token: await token() }, "login-nonce")).toEqual(info);
});

it.each([
  { nonce: "another-login" }, { nonce: undefined }, { iss: "https://wrong.example.com" },
  { aud: "another-client" }, { sub: undefined }, { exp: 1 }, { exp: undefined },
  { iat: undefined }, { iat: 99_999_999_999 }, { azp: "another-client" },
  { aud: ["client", "another-client"] },
])("rejects invalid identity claims %j before requesting userinfo", async (patch) => {
  await expect(fetchVerifiedUserinfo("test", { access_token: "access", id_token: await token(patch) }, "login-nonce")).rejects.toThrow();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/userinfo"))).toBe(false);
});

it("rejects a signature made with a different key", async () => {
  await expect(fetchVerifiedUserinfo("test", { access_token: "access", id_token: await token({}, otherKeys.privateKey) }, "login-nonce")).rejects.toThrow();
});

it("rejects userinfo belonging to a different identity", async () => {
  info.sub = "different-subject";
  await expect(fetchVerifiedUserinfo("test", { access_token: "access", id_token: await token() }, "login-nonce")).rejects.toThrow(/subject/);
});

it("rejects mismatched discovery issuers", async () => {
  issuer = "https://wrong.example.com";
  await expect(discoverOidc("test")).rejects.toThrow(/issuer/);
});

it("preserves authorization endpoint parameters when building the login URL", async () => {
  const url = new URL(await buildAuthorizeUrl({ providerSlug: "test", redirectUri: "https://app.example.com/callback", state: "state", nonce: "nonce", codeChallenge: "challenge" }));
  expect(url.searchParams.get("tenant")).toBe("example");
  expect(url.searchParams.get("client_id")).toBe("client");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});
