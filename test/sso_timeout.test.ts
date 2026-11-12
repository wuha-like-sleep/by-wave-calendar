import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/sso_providers.js", () => ({
  getProviderBySlug: vi.fn(async () => ({ enabled: true, issuerUrl: "https://idp.example.com", clientId: "client", clientSecret: "secret" })),
}));

import { discoverOidc, exchangeCode, fetchUserinfo, resetOidcCache } from "../src/lib/sso.js";

const discovery = {
  issuer: "https://idp.example.com", jwks_uri: "https://idp.example.com/jwks", authorization_endpoint: "https://idp.example.com/auth",
  token_endpoint: "https://idp.example.com/token", userinfo_endpoint: "https://idp.example.com/userinfo",
};
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
beforeEach(() => {
  resetOidcCache();
  // Shorten the real abort deadline, not the behaviour being tested.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(10));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["discovery", "token", "userinfo"])("aborts a stalled SSO %s request", async (stage) => {
  if (stage !== "discovery") {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(discovery))));
    await discoverOidc("test");
  }
  vi.stubGlobal("fetch", vi.fn((_url, init?: RequestInit) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  })));
  const request = stage === "discovery" ? discoverOidc("test")
    : stage === "token" ? exchangeCode({ providerSlug: "test", code: "code", redirectUri: "https://app.example.com/callback", codeVerifier: "verifier" })
      : fetchUserinfo("test", "token");
  let timer: ReturnType<typeof setTimeout>;
  const result = await Promise.race([
    request.then(() => "completed", (error) => error.name),
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting"), 100); }),
  ]);
  clearTimeout(timer!);
  expect(result).toBe("TimeoutError");
});

it("accepts normal discovery, token and userinfo responses", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(discovery)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", id_token: "id" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "subject", email: "user@example.com" }))));
  expect(await discoverOidc("test")).toEqual(discovery);
  expect(await exchangeCode({ providerSlug: "test", code: "code", redirectUri: "https://app.example.com/callback", codeVerifier: "verifier" })).toMatchObject({ access_token: "access" });
  expect(await fetchUserinfo("test", "access")).toMatchObject({ sub: "subject" });
});
