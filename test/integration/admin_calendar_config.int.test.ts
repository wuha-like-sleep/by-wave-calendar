import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/db/client.js", async () => { const h = await import("./harness.js"); return { db: h.db, schema: h.schema }; });
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema, ensureSchema, resetDb, makeUser, loginAs } from "./harness.js";
import { redirectFlash } from "./flash_helpers.js";
process.env.PUBLIC_BASE_URL ??= "https://calendar.test";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { adminRoutes } = await import("../../src/web/admin.js");
const { calendarSyncRoutes } = await import("../../src/web/calendar_sync.js");
const { env } = await import("../../src/env.js");
const { getSettings, reloadSettings } = await import("../../src/lib/site_settings.js");
const { getMicrosoftCalendarConfig } = await import("../../src/lib/calendar_sync/config.js");
const ROOT = "/admin/calendar-sync", USER = "/app/settings/calendar-sync";
const CLIENT = "12345678-1234-4123-a123-123456789abc", ENV_CLIENT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
let app: FastifyInstance, adminSession: string, userSession: string, adminId: string;
let originalEnv: string | undefined;
const pages: JSDOM[] = [];
beforeAll(async () => {
  await ensureSchema(); originalEnv = env.MICROSOFT_CALENDAR_CLIENT_ID;
  app = Fastify(); await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" }); await app.register(formbody);
  await app.register(view, { engine: { ejs }, root: path.resolve("src/views"), layout: "layout.ejs", defaultContext: { t: (key: string) => key } });
  await app.register(adminRoutes); await app.register(calendarSyncRoutes); await app.ready();
});
afterAll(async () => { env.MICROSOFT_CALENDAR_CLIENT_ID = originalEnv; await app?.close(); });
afterEach(() => { vi.unstubAllGlobals(); for (const page of pages.splice(0)) page.window.close(); });
beforeEach(async () => {
  await resetDb(); reloadSettings(); env.MICROSOFT_CALENDAR_CLIENT_ID = ""; await getSettings();
  const admin = await makeUser("admin@example.com", { isAdmin: true }); adminId = admin.id;
  adminSession = await loginAs(app, admin.id); userSession = await loginAs(app, (await makeUser("member@example.com")).id);
});
async function page(url = ROOT, session = adminSession) {
  const res = await app.inject({ url, headers: { cookie: session } }); expect(res.statusCode, res.body).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  const dom = new JSDOM(res.body, { url: "https://calendar.test" + url }); pages.push(dom); return dom;
}
async function form() {
  const dom = await page(); const form = dom.window.document.querySelector<HTMLFormElement>(`form[action="${ROOT}"]`)!;
  const data = new URLSearchParams(); for (const [k,v] of new dom.window.FormData(form)) data.append(k, String(v));
  expect(data.getAll("_csrf")).toHaveLength(1); return data;
}
function post(data: URLSearchParams, session = adminSession) {
  return app.inject({ method: "POST", url: ROOT, headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, payload: data.toString() });
}
async function save(value: string) { const data = await form(); data.set("clientId", value); return post(data); }
function status() { return app.inject({ url: USER + "/status", headers: { cookie: userSession } }); }

describe("admin Microsoft calendar configuration", () => {
  it("saves a rendered form and immediately updates pages and actual authorization requests", async () => {
    expect((await status()).json()).toEqual({ microsoftConfigured: false });
    const res = await save("  " + CLIENT.toUpperCase() + "  "); expect(res.headers.location).toBe(ROOT); expect(redirectFlash(res).success).toBeTruthy();
    const adminPage = await page(); expect(adminPage.window.document.querySelector<HTMLInputElement>('[name="clientId"]')!.value).toBe(CLIENT);
    expect(adminPage.window.document.querySelector('[data-config-source="admin"]')).not.toBeNull();
    const userPage = await page(USER, userSession);
    expect(userPage.window.document.querySelector<HTMLElement>('[data-microsoft-unconfigured]')!.hidden).toBe(true);
    expect(userPage.window.document.querySelector<HTMLElement>('[data-microsoft-connect]')!.hidden).toBe(false);
    expect((await status()).json()).toEqual({ microsoftConfigured: true });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ device_code: "private", user_code: "VISIBLE", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 })); vi.stubGlobal("fetch", fetcher);
    const csrf = userPage.window.document.querySelector<HTMLInputElement>('[name="_csrf"]')!.value;
    await app.inject({ method: "POST", url: USER + "/microsoft/start", headers: { cookie: userSession }, payload: { _csrf: csrf } });
    expect(fetcher).toHaveBeenCalledOnce(); expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body)).get("client_id")).toBe(CLIENT);
    expect((await db.select().from(schema.calendarSyncLogins))[0]!.clientId).toBe(CLIENT);
    const audit = await db.select().from(schema.adminAuditLog).where(eq(schema.adminAuditLog.action, "calendar_sync.config.update")); expect(audit).toHaveLength(1);
  });
  it("inherits env until configured, lets an empty field override it, and restores it explicitly", async () => {
    env.MICROSOFT_CALENDAR_CLIENT_ID = ENV_CLIENT;
    expect(await getMicrosoftCalendarConfig()).toMatchObject({ clientId: ENV_CLIENT, source: "environment" });
    await save(CLIENT); expect((await getMicrosoftCalendarConfig()).clientId).toBe(CLIENT);
    await save(""); expect(await getMicrosoftCalendarConfig()).toEqual({ clientId: "", configured: false, source: "disabled" });
    const userPage = await page(USER, userSession); expect(userPage.window.document.querySelector<HTMLButtonElement>('[data-microsoft-connect] button')!.disabled).toBe(true);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await app.inject({ method: "POST", url: USER + "/microsoft/start", headers: { cookie: userSession }, payload: { _csrf: userPage.window.document.querySelector<HTMLInputElement>('[name="_csrf"]')!.value } });
    expect(fetcher).not.toHaveBeenCalled();
    const data = await form(); data.set("action", "environment"); const res = await post(data); expect(res.headers.location).toBe(ROOT);
    expect(await getMicrosoftCalendarConfig()).toMatchObject({ clientId: ENV_CLIENT, source: "environment" });
  });
  it("rejects invalid IDs without replacing working configuration or leaking input in the URL", async () => {
    await save(CLIENT);
    for (const value of ["client-secret-not-an-id", "https://evil.test", "<script>bad</script>", "x".repeat(100)]) {
      const res = await save(value); expect(res.headers.location).toBe(ROOT); expect(redirectFlash(res).error).toBeTruthy(); expect((await getMicrosoftCalendarConfig()).clientId).toBe(CLIENT);
    }
  });
  it("requires administrator session, satisfied MFA and CSRF", async () => {
    expect((await app.inject({ url: ROOT })).headers.location).toBe("/login");
    expect((await app.inject({ url: ROOT, headers: { cookie: userSession } })).statusCode).toBe(403);
    const data = await form(); expect((await post(data, userSession)).statusCode).toBe(403);
    data.delete("_csrf"); expect((await post(data)).statusCode).toBe(403);
    expect((await post(new URLSearchParams({ action: "environment" }))).statusCode).toBe(403);
    await db.update(schema.users).set({ mfaEnabled: true }).where(eq(schema.users.id, adminId));
    await db.update(schema.sessions).set({ mfaSatisfied: false }).where(eq(schema.sessions.userId, adminId));
    expect((await post(data)).headers.location).toBe("/login/mfa");
    expect((await getMicrosoftCalendarConfig()).configured).toBe(false);
    expect((await app.inject({ url: USER + "/status" })).headers.location).toBe("/login");
  });
  it("observes changes from other workers and retains existing connection credentials", async () => {
    await save(CLIENT);
    await db.insert(schema.calendarSyncAccounts).values({ userId: adminId, clientId: CLIENT, accountId: "microsoft", label: "Connected", refreshToken: "existing-encrypted-token" });
    await db.update(schema.siteSettings).set({ microsoftCalendarClientId: ENV_CLIENT });
    expect((await getMicrosoftCalendarConfig()).clientId).toBe(ENV_CLIENT);
    await save(""); expect((await status()).json()).toEqual({ microsoftConfigured: false });
    expect((await db.select().from(schema.calendarSyncAccounts))[0]).toMatchObject({ clientId: CLIENT, refreshToken: "existing-encrypted-token" });
  });
  it("preserves configuration through backup and handles pre-setting backups", async () => {
    const { exportData, importData } = await import("../../src/lib/backup.js");
    await save(CLIENT); const bundle = JSON.parse(JSON.stringify(await exportData()));
    await save(""); await importData(bundle); expect((await getMicrosoftCalendarConfig()).clientId).toBe(CLIENT);
    delete bundle.tables.site_settings[0].microsoftCalendarClientId;
    env.MICROSOFT_CALENDAR_CLIENT_ID = ENV_CLIENT;
    await importData(bundle); expect((await getMicrosoftCalendarConfig()).clientId).toBe(ENV_CLIENT);
  });
});
