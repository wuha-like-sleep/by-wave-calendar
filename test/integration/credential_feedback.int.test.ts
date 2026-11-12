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
import { createApiToken, verifyApiToken } from "../../src/lib/api_token.js";
import { getSettings, reloadSettings, updateSettings } from "../../src/lib/site_settings.js";

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
  { name: "app password", post: "/app/settings/app-passwords", get: "/app/settings/devices", field: "newAppPassword", label: "newAppLabel", fragment: "#app-passwords" },
  { name: "API token", post: "/admin/api/tokens", get: "/admin/api", field: "issuedToken", label: "issuedLabel", fragment: "" },
])("$name feedback", (route) => {
  it("shows a real newly issued credential once without putting it in a URL", async () => {
    const csrf = (await app.inject({ url: "/test/csrf", headers: { cookie: session } })).json().token;
    const response = await app.inject({ method: "POST", url: route.post, headers: { cookie: session }, payload: { _csrf: csrf, userId, label: "Desktop", scope: "write" } });
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
