import { redirectFlash } from "./flash_helpers.js";
import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
// Only the remote IdP is replaced. Cookie signatures, sessions, routes, and
// identity writes remain real; the IdP supplies a fixed authenticated identity.
vi.mock("../../src/lib/sso.js", async (original) => ({
  ...await original<typeof import("../../src/lib/sso.js")>(),
  buildAuthorizeUrl: vi.fn(async (o: { state: string }) => `https://idp.example.com/auth?state=${o.state}`),
  exchangeCode: vi.fn(async () => ({ access_token: "test-access-token", id_token: "test-id-token" })),
  fetchVerifiedUserinfo: vi.fn(async () => ({ sub: "idp-subject", email: "sso-owner@example.com", email_verified: true })),
}));
vi.mock("../../src/lib/login_alert.js", () => ({ notifyLoginSuccess: vi.fn(async () => undefined) }));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { db, schema, ensureSchema, resetDb, makeUser, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { ssoRoutes } = await import("../../src/web/sso.js");
const { exchangeCode } = await import("../../src/lib/sso.js");
let app: FastifyInstance;
let session: string;
let userId: string;

beforeAll(async () => {
  await ensureSchema();
  app = Fastify();
  await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await app.register(ssoRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); });
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  const user = await makeUser("sso-owner@example.com");
  userId = user.id;
  session = await loginAs(app, user.id);
  await db.insert(schema.ssoProviders).values({ slug: "test", label: "Test", enabled: true, issuerUrl: "https://idp.example.com", clientId: "client", clientSecret: "secret" });
});

async function start(link = false) {
  const res = await app.inject({ method: "GET", url: `/auth/idp/test/login${link ? "?link=1" : ""}`, headers: { cookie: session } });
  expect(res.statusCode).toBe(302);
  const value = res.cookies.find((c) => c.name === "bwc_sso_state")!.value;
  const unsigned = app.unsignCookie(value);
  // Accept either representation here so the regression tests exercise the old
  // vulnerable route as well as the signed implementation.
  const state = JSON.parse(Buffer.from(unsigned.valid ? unsigned.value! : value, "base64url").toString("utf8"));
  return { value, state };
}

function callback(value: string, state: string, currentSession = session) {
  return app.inject({
    method: "GET", url: `/auth/idp/callback?code=test-code&state=${encodeURIComponent(state)}`,
    headers: { cookie: `bwc_sso_state=${encodeURIComponent(value)}; ${currentSession}` },
  });
}

it("signs SSO state and allows the original session to link its identity", async () => {
  const { value, state } = await start(true);
  expect(app.unsignCookie(value).valid).toBe(true);
  const res = await callback(value, state.state);
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe("/app/settings/security");
    expect(redirectFlash(res).success).toBeTruthy();
  expect(await db.select().from(schema.userIdentities)).toMatchObject([{ userId, provider: "test", subject: "idp-subject" }]);
});

it("rejects an unsigned cookie that changes login into account linking", async () => {
  const { state } = await start();
  const forged = Buffer.from(JSON.stringify({ ...state, link: true })).toString("base64url");
  const res = await callback(forged, state.state);
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe("/login");
    expect(redirectFlash(res).error).toBeTruthy();
  expect(exchangeCode).not.toHaveBeenCalled();
  expect(await db.select().from(schema.userIdentities)).toHaveLength(0);
});

it("rejects linking after the browser changes to another account", async () => {
  const { value, state } = await start(true);
  const other = await makeUser("other@example.com");
  const res = await callback(value, state.state, await loginAs(app, other.id));
  expect(res.headers.location).toBe("/login");
    expect(redirectFlash(res).error).toBeTruthy();
  expect(exchangeCode).not.toHaveBeenCalled();
  expect(await db.select().from(schema.userIdentities)).toHaveLength(0);
});

it("enforces the state lifetime on the server", async () => {
  const { value, state } = await start();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
  const res = await callback(value, state.state);
  expect(res.headers.location).toBe("/login");
    expect(redirectFlash(res).error).toBeTruthy();
  expect(exchangeCode).not.toHaveBeenCalled();
});

it.each([null, [], {}, { slug: "test", state: "x" }])("rejects malformed state %j without a 500", async (state) => {
  const value = Buffer.from(JSON.stringify(state)).toString("base64url");
  for (const cookieValue of [value, app.signCookie(value)]) {
    const res = await callback(cookieValue, "x");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(redirectFlash(res).error).toBeTruthy();
  }
  expect(exchangeCode).not.toHaveBeenCalled();
});

it("still completes an ordinary SSO login", async () => {
  const { value, state } = await start();
  const res = await callback(value, state.state, "");
  expect(res.headers.location).toBe("/app");
  expect(res.cookies.some((c) => c.name === "bwc_sid" && c.value)).toBe(true);
});
