import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => false) }));
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { ensureSchema, resetDb, makeUser, loginAs } from "./harness.js";
import { flashCookie } from "./flash_helpers.js";
import { csrfTokenFor } from "../../src/lib/csrf.js";
import { adminRoutes } from "../../src/web/admin.js";
import { webRoutes } from "../../src/web/index.js";
import { createApiToken, verifyApiToken, listApiTokensForUser } from "../../src/lib/api_token.js";
import { getSettings, reloadSettings, updateSettings } from "../../src/lib/site_settings.js";
import { db, schema } from "../../src/db/client.js";
import { eq } from "drizzle-orm";
import { hashPassword } from "../../src/lib/password.js";
import { generateSync } from "otplib";
import { newTotpSecret } from "../../src/lib/mfa.js";

const REAL_PASSWORD = "Passw0rd!long";
async function setRealPassword(uid: string) {
  await db.update(schema.users).set({ passwordHash: await hashPassword(REAL_PASSWORD) }).where(eq(schema.users.id, uid));
}
async function csrfFor(sess: string) {
  return (await app.inject({ url: "/test/csrf", headers: { cookie: sess } })).json().token;
}
async function postSelfServiceToken(sess: string, payload: Record<string, unknown>) {
  const csrf = await csrfFor(sess);
  return app.inject({ method: "POST", url: "/app/settings/api-tokens", headers: { cookie: sess }, payload: { _csrf: csrf, ...payload } });
}
async function auditRowsFor(uid: string) {
  return db.select().from(schema.adminAuditLog).where(eq(schema.adminAuditLog.actorUserId, uid));
}

let app: FastifyInstance;
let session: string;
let otherSession: string;
let userId: string;
beforeAll(async () => {
  await ensureSchema();
  app = Fastify();
  await app.register(cookie, { secret: "test-cookie-secret-at-least-32-characters" });
  await app.register(formbody);
  app.decorateReply("view", function (template: string, locals: object) { return this.send({ template, locals }); });
  app.get("/test/csrf", (req) => ({ token: csrfTokenFor(req) }));
  await app.register(adminRoutes);
  await app.register(webRoutes);
});

afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  reloadSettings();
  await getSettings();
  const user = await makeUser("owner@example.com", { isAdmin: true });
  userId = user.id;
  session = await loginAs(app, user.id);
  const other = await makeUser("other@example.com", { isAdmin: true });
  otherSession = await loginAs(app, other.id);
});

describe.each([
  { name: "app password", post: "/app/settings/app-passwords", get: "/app/settings/devices", field: "newAppPassword", label: "newAppLabel", fragment: "#app-passwords", selfService: false },
  { name: "API token", post: "/admin/api/tokens", get: "/admin/api", field: "issuedToken", label: "issuedLabel", fragment: "", selfService: false },
  { name: "self-service API token", post: "/app/settings/api-tokens", get: "/app/settings/devices", field: "issuedToken", label: "issuedLabel", fragment: "#api-tokens", selfService: true },
])("$name feedback", (route) => {
  it("shows a real newly issued credential once without putting it in a URL", async () => {
    if (route.selfService) {
      await updateSettings({ apiEnabled: true });
      await setRealPassword(userId);
    }
    const csrf = (await app.inject({ url: "/test/csrf", headers: { cookie: session } })).json().token;
    const payload = route.selfService
      ? { _csrf: csrf, label: "Desktop", scope: "read", currentPassword: REAL_PASSWORD }
      : { _csrf: csrf, userId, label: "Desktop", scope: "write" };
    const response = await app.inject({ method: "POST", url: route.post, headers: { cookie: session }, payload });
    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBe(route.get + route.fragment);
    const cookieValue = flashCookie(response);
    const other = await app.inject({ url: route.get, headers: { cookie: otherSession + "; " + cookieValue } });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().locals[route.field]).toBeNull();
    const page = await app.inject({ url: route.get, headers: { cookie: session + "; " + cookieValue } });
    expect(page.statusCode, page.body).toBe(200);
    const secret = page.json().locals[route.field];
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(20);
    expect(page.json().locals[route.label]).toBe("Desktop");
    expect(String(response.headers["set-cookie"])).not.toContain(secret);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.cookies.find(c => c.name === "bwc_flash")?.value).toBe("");
    const refresh = await app.inject({ url: route.get, headers: { cookie: session } });
    expect(refresh.json().locals[route.field]).toBeNull();
    expect(refresh.json().locals.flash).toEqual({});
  });
});

it("keeps a rotated API token out of the URL and expires the replaced token", async () => {
  await updateSettings({ apiEnabled: true });
  const old = await createApiToken({ userId, label: "Automation", scope: "write" });
  const csrf = (await app.inject({ url: "/test/csrf", headers: { cookie: session } })).json().token;
  const response = await app.inject({ method: "POST", url: `/admin/api/tokens/${old.id}/rotate`, headers: { cookie: session }, payload: { _csrf: csrf, graceDays: 0 } });
  expect(response.statusCode, response.body).toBe(302);
  expect(response.headers.location).toBe("/admin/api");
  const page = await app.inject({ url: "/admin/api", headers: { cookie: session + "; " + flashCookie(response) } });
  const plain = page.json().locals.issuedToken;
  expect(typeof plain).toBe("string");
  expect(plain).not.toBe(old.plain);
  expect(await verifyApiToken(plain)).toMatchObject({ userId, scope: "write" });
  expect(await verifyApiToken(old.plain)).toBeNull();
  expect(String(response.headers["set-cookie"])).not.toContain(plain);
  expect(page.cookies.find(c => c.name === "bwc_flash")?.value).toBe("");
});

describe("self-service API tokens", () => {
  beforeEach(async () => {
    await updateSettings({ apiEnabled: true });
    await setRealPassword(userId);
  });

  it("rejects creation without a CSRF token", async () => {
    const response = await app.inject({ method: "POST", url: "/app/settings/api-tokens", headers: { cookie: session }, payload: { label: "NoCsrf", scope: "read", currentPassword: REAL_PASSWORD } });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error).toBe("csrf_invalid");
    expect(await listApiTokensForUser(userId)).toHaveLength(0);
  });

  it("rejects creation with a wrong password and audits the denial", async () => {
    const response = await postSelfServiceToken(session, { label: "BadPw", scope: "read", currentPassword: "wrong-password" });
    expect(response.statusCode, response.body).toBe(302);
    expect(await listApiTokensForUser(userId)).toHaveLength(0);
    const denied = (await auditRowsFor(userId)).filter((r) => r.action === "api_token.create_denied");
    expect(denied).toHaveLength(1);
    expect((denied[0]!.details as { reason?: string }).reason).toBe("step_up_failed");
  });

  it("rejects creation while the site API switch is off", async () => {
    await updateSettings({ apiEnabled: false });
    const response = await postSelfServiceToken(session, { label: "Off", scope: "read", currentPassword: REAL_PASSWORD });
    expect(response.statusCode, response.body).toBe(302);
    expect(await listApiTokensForUser(userId)).toHaveLength(0);
    const denied = (await auditRowsFor(userId)).filter((r) => r.action === "api_token.create_denied");
    expect((denied[0]!.details as { reason?: string }).reason).toBe("api_disabled");
  });

  it("enforces the per-user cap of 5 active tokens", async () => {
    for (let i = 0; i < 5; i++) await createApiToken({ userId, label: `T${i}`, scope: "read" });
    const response = await postSelfServiceToken(session, { label: "Sixth", scope: "read", currentPassword: REAL_PASSWORD });
    expect(response.statusCode, response.body).toBe(302);
    expect(await listApiTokensForUser(userId)).toHaveLength(5);
    const denied = (await auditRowsFor(userId)).filter((r) => r.action === "api_token.create_denied");
    expect((denied[0]!.details as { reason?: string }).reason).toBe("limit_reached");
  });

  it("audits a successful creation with via=self_service and prefix only, never the plain token", async () => {
    const response = await postSelfServiceToken(session, { label: "Mine", scope: "read", currentPassword: REAL_PASSWORD });
    expect(response.statusCode, response.body).toBe(302);
    const page = await app.inject({ url: "/app/settings/devices", headers: { cookie: session + "; " + flashCookie(response) } });
    const plain = page.json().locals.issuedToken as string;
    expect(typeof plain).toBe("string");
    const created = (await auditRowsFor(userId)).filter((r) => r.action === "api_token.create");
    expect(created).toHaveLength(1);
    const details = created[0]!.details as { via?: string; prefix?: string };
    expect(details.via).toBe("self_service");
    expect(details.prefix).toBe(plain.split("_")[1]);
    expect(JSON.stringify(created[0]!.details)).not.toContain(plain);
    // The self-created read token verifies as read-only.
    expect(await verifyApiToken(plain)).toMatchObject({ userId, scope: "read" });
  });

  it("cannot revoke another user's token (IDOR), but the owner can", async () => {
    const other = await makeUser("victim@example.com");
    const victim = await createApiToken({ userId: other.id, label: "Victim", scope: "write" });
    const csrf = await csrfFor(session);
    const attack = await app.inject({ method: "POST", url: `/app/settings/api-tokens/${victim.id}/revoke`, headers: { cookie: session }, payload: { _csrf: csrf } });
    expect(attack.statusCode, attack.body).toBe(302);
    expect(await listApiTokensForUser(other.id)).toHaveLength(1);
    expect(await verifyApiToken(victim.plain)).toMatchObject({ userId: other.id });
    // No revoke audit row may be written for a no-op cross-user attempt.
    expect((await auditRowsFor(userId)).filter((r) => r.action === "api_token.revoke")).toHaveLength(0);

    const ownerSession = await loginAs(app, other.id);
    const csrf2 = await csrfFor(ownerSession);
    const own = await app.inject({ method: "POST", url: `/app/settings/api-tokens/${victim.id}/revoke`, headers: { cookie: ownerSession }, payload: { _csrf: csrf2 } });
    expect(own.statusCode, own.body).toBe(302);
    expect(await listApiTokensForUser(other.id)).toHaveLength(0);
    // A revoked token no longer verifies — the API layer answers 401 for it.
    expect(await verifyApiToken(victim.plain)).toBeNull();
  });

  it("treats an expired token as invalid", async () => {
    const issued = await createApiToken({ userId, label: "ShortLived", scope: "read", expiresInDays: 1 });
    expect(await verifyApiToken(issued.plain)).not.toBeNull();
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.apiTokens.id, issued.id));
    expect(await verifyApiToken(issued.plain)).toBeNull();
  });

  it("requires a TOTP code on top of the password for write tokens when MFA is on", async () => {
    const secret = newTotpSecret();
    await db.update(schema.users).set({ mfaEnabled: true, mfaTotpSecret: secret }).where(eq(schema.users.id, userId));
    // Read with password only: fine.
    const read = await postSelfServiceToken(session, { label: "RO", scope: "read", currentPassword: REAL_PASSWORD });
    expect(read.statusCode, read.body).toBe(302);
    expect(await listApiTokensForUser(userId)).toHaveLength(1);
    // Write with password but no TOTP: refused.
    const noTotp = await postSelfServiceToken(session, { label: "RW", scope: "write", currentPassword: REAL_PASSWORD });
    expect(noTotp.statusCode, noTotp.body).toBe(302);
    expect(await listApiTokensForUser(userId)).toHaveLength(1);
    // Write with password + fresh TOTP: issued as write.
    const withTotp = await postSelfServiceToken(session, { label: "RW", scope: "write", currentPassword: REAL_PASSWORD, mfaCode: generateSync({ secret }) });
    expect(withTotp.statusCode, withTotp.body).toBe(302);
    const tokens = await listApiTokensForUser(userId);
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.scope).sort()).toEqual(["read", "write"]);
  });

  it("defaults a new token to a 365-day expiry, and still honours an explicit 0 (never)", async () => {
    const defaulted = await postSelfServiceToken(session, { label: "Defaulted", scope: "read", currentPassword: REAL_PASSWORD });
    expect(defaulted.statusCode, defaulted.body).toBe(302);
    const never = await postSelfServiceToken(session, { label: "Forever", scope: "read", expiresInDays: 0, currentPassword: REAL_PASSWORD });
    expect(never.statusCode, never.body).toBe(302);
    const tokens = await listApiTokensForUser(userId);
    expect(tokens).toHaveLength(2);
    const byLabel = new Map(tokens.map((t) => [t.label, t]));
    const exp = byLabel.get("Defaulted")!.expiresAt;
    expect(exp).not.toBeNull();
    const days = (new Date(exp!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
    expect(byLabel.get("Forever")!.expiresAt).toBeNull();
  });
});
