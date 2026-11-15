import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("../../src/db/client.js", async () => { const h = await import("./harness.js"); return { db: h.db, schema: h.schema }; });
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => false) }));
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import path from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema, ensureSchema, resetDb, makeUser, loginAs } from "./harness.js";
process.env.PUBLIC_BASE_URL ??= "https://calendar.test";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { webRoutes } = await import("../../src/web/index.js");
const { deviceRoutes } = await import("../../src/routes/devices.js");
const { registerApiCsrf } = await import("../../src/lib/api_csrf.js");
const { reloadSettings } = await import("../../src/lib/site_settings.js");
const { initPairing } = await import("../../src/lib/devices.js");
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const request = { state: "s".repeat(43), scheme: "bywave", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
const entry = "/app/auth/native?" + new URLSearchParams(request);
let app: FastifyInstance;
let session: string;
let userId: string;
beforeAll(async () => {
  await ensureSchema(); app = Fastify({ logger: false });
  await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await app.register(formbody);
  await app.register(view, { engine: { ejs }, root: path.resolve("src/views"), layout: "layout.ejs", defaultContext: { t: (key: string) => key } });
  registerApiCsrf(app);
  await app.register(webRoutes); await app.register(deviceRoutes, { prefix: "/api/v1" }); await app.ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(async () => {
  await resetDb();
  await db.insert(schema.siteSettings).values({ id: 1, appsEnabled: true, captchaProvider: "none" }); reloadSettings();
  const user = await makeUser("phone@example.com"); userId = user.id; session = await loginAs(app, userId);
});
async function consent() {
  const page = await app.inject({ url: entry, headers: { cookie: session } });
  expect(page.statusCode, page.body).toBe(200);
  const dom = new JSDOM(page.body); const form = dom.window.document.querySelector("form")!;
  const body = Object.fromEntries([...new dom.window.FormData(form).entries()].map(([k,v]) => [k,String(v)]));
  dom.window.close(); return body;
}
async function authorize() {
  const res = await app.inject({ method: "POST", url: "/app/auth/native/complete", headers: { cookie: session }, payload: await consent() });
  expect(res.statusCode, res.body).toBe(303); expect(res.headers["cache-control"]).toBe("no-store");
  const url = new URL(res.headers.location!); expect(url.searchParams.get("state")).toBe(request.state);
  return url.searchParams.get("code")!;
}
function claim(code: string, proof: string | undefined = verifier) {
  return app.inject({ method: "POST", url: "/api/v1/devices/pair-claim", payload: { code, codeVerifier: proof, label: "Browser phone", kind: "ios" } });
}
describe("native browser login", () => {
  it("retains the S256 request through the real login bounce", async () => {
    const res = await app.inject({ url: entry }); expect(res.statusCode).toBe(302); expect(res.headers.location).toBe("/login");
    const back = res.cookies.find(c => c.name === "bwc_return_to")!;
    expect(app.unsignCookie(decodeURIComponent(back.value)).value).toBe(entry);
  });
  it("requires consent and CSRF before minting a code", async () => {
    await consent(); expect(await db.select().from(schema.devicePairings)).toHaveLength(0);
    const res = await app.inject({ method: "POST", url: "/app/auth/native/complete", headers: { cookie: session }, payload: { ...request, accountId: userId } });
    expect(res.statusCode).toBe(403); expect(await db.select().from(schema.devicePairings)).toHaveLength(0);
  });
  it("rejects intercepted codes, then lets only the initiating app redeem once", async () => {
    const code = await authorize(); expect(code).toMatch(/^BW1\./);
    const rows = await db.select().from(schema.devicePairings); expect(rows[0]!.code).not.toContain(code);
    expect((await claim(code, "x".repeat(43))).statusCode).toBe(401);
    expect((await claim(code, undefined)).statusCode).toBe(200); // default argument is the correct proof
    expect((await claim(code)).statusCode).toBe(401);
  });
  it("cannot downgrade a browser code to the legacy QR claim", async () => {
    const code = await authorize();
    const res = await app.inject({ method: "POST", url: "/api/v1/devices/pair-claim", payload: { code, label: "Phone", kind: "android" } });
    expect(res.statusCode).toBe(401); expect((await claim(code)).statusCode).toBe(200);
  });
  it("allows only one concurrent redemption, including existing QR codes", async () => {
    for (const [code, proof] of [[await authorize(), verifier], [(await initPairing(userId)).code, null]] as const) {
      const responses = await Promise.all([1,2,3].map(() => app.inject({ method: "POST", url: "/api/v1/devices/pair-claim", payload: { code, ...(proof ? { codeVerifier: proof } : {}), label: "Phone", kind: "android" } })));
      expect(responses.map(r => r.statusCode).sort()).toEqual([200,401,401]);
    }
  });
  it("does not authorize a different browser account than the one confirmed", async () => {
    const body = await consent(); const other = await makeUser("other@example.com"); const otherSession = await loginAs(app, other.id);
    // New session => fresh CSRF, but keep the displayed account ID.
    const old = session; session = otherSession; const fresh = await consent(); session = old;
    const res = await app.inject({ method: "POST", url: "/app/auth/native/complete", headers: { cookie: otherSession }, payload: { ...body, _csrf: fresh._csrf } });
    expect(res.statusCode).toBe(303); expect(res.headers.location).toBe(entry); expect(await db.select().from(schema.devicePairings)).toHaveLength(0);
  });
  it("switches accounts without losing the original request", async () => {
    const res = await app.inject({ method: "POST", url: "/app/auth/native/switch-account", headers: { cookie: session }, payload: await consent() });
    expect(res.statusCode).toBe(303); expect(res.headers.location).toBe("/login");
    expect(app.unsignCookie(decodeURIComponent(res.cookies.find(c=>c.name === "bwc_return_to")!.value)).value).toBe(entry);
  });
  it("gates MFA, disabled apps, unsupported clients, and untrusted callback schemes", async () => {
    await db.update(schema.users).set({ mfaEnabled: true }).where(eq(schema.users.id,userId));
    await db.update(schema.sessions).set({ mfaSatisfied: false });
    expect((await app.inject({url:entry,headers:{cookie:session}})).headers.location).toBe("/login/mfa");
    await db.update(schema.siteSettings).set({ appsEnabled:false }); reloadSettings();
    expect((await app.inject({url:entry,headers:{cookie:session}})).statusCode).toBe(403);
    expect((await app.inject({url:"/app/auth/native?state=old-client"})).statusCode).toBe(400);
    expect((await app.inject({url:entry.replace("scheme=bywave","scheme=evil")})).statusCode).toBe(400);
  });
  it("rejects expired codes and disabled accounts", async () => {
    const code = await authorize(); await db.update(schema.devicePairings).set({ expiresAt: new Date(0) });
    expect((await claim(code)).statusCode).toBe(401);
    const next = await authorize(); await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id,userId));
    expect((await claim(next)).statusCode).toBe(401);
  });
});
