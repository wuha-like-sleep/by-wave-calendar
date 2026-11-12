// Submit the rendered HTML through the real routes. Hand-written request bodies
// miss browser repairs of nested forms (including duplicate CSRF fields).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, ensureSchema, loginAs, makeUser, resetDb, schema } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { adminRoutes } = await import("../../src/web/admin.js");
let app: FastifyInstance;
let sessionCookie: string;
let adminId: string;
let providers: schema.SsoProvider[];
const pages: JSDOM[] = [];

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await app.register(formbody);
  await app.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view",
    defaultContext: { t: (key: string) => key },
  });
  await app.register(adminRoutes);
  await app.ready();
});

afterAll(async () => { await app?.close(); });
afterEach(() => { for (const page of pages.splice(0)) page.window.close(); });

beforeEach(async () => {
  await resetDb();
  const admin = await makeUser("admin@example.com", { isAdmin: true });
  adminId = admin.id;
  sessionCookie = await loginAs(app, admin.id);
  providers = await db.insert(schema.ssoProviders).values([
    { slug: "first", label: "First SSO", issuerUrl: "https://first.example.com", clientId: "first-client", clientSecret: "first-secret", enabled: true, sortOrder: 1 },
    { slug: "second", label: "Second SSO", issuerUrl: "https://second.example.com", clientId: "second-client", clientSecret: "second-secret", enabled: false, sortOrder: 2 },
  ]).returning();
});

async function loadPage(url = "/admin/idp") {
  const res = await app.inject({ method: "GET", url, headers: { cookie: sessionCookie } });
  expect(res.statusCode, res.body).toBe(200);
  const page = new JSDOM(res.body, { url: `http://localhost${url}` });
  pages.push(page);
  return page;
}

function buttonForm(page: JSDOM, text: string, index = 0): HTMLFormElement {
  const button = [...page.window.document.querySelectorAll<HTMLButtonElement>("button[type=submit]")]
    .filter((b) => b.textContent?.trim() === text)[index];
  expect(button, `${text} button ${index}`).toBeDefined();
  expect(button!.form, `${text} must belong to a form`).not.toBeNull();
  return button!.form!;
}

function input(form: HTMLFormElement, name: string): HTMLInputElement {
  const field = form.elements.namedItem(name);
  expect(field, name).not.toBeNull();
  return field as HTMLInputElement;
}

function payload(page: JSDOM, form: HTMLFormElement) {
  const body = new URLSearchParams();
  for (const [key, value] of new page.window.FormData(form)) {
    expect(typeof value, `${key} must be a text field`).toBe("string");
    body.append(key, String(value));
  }
  return body;
}

function submit(form: HTMLFormElement, body: URLSearchParams) {
  expect(form.method).toBe("post");
  return app.inject({
    method: "POST", url: new URL(form.action).pathname,
    headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
    payload: body.toString(),
  });
}

async function getProvider(id: string) {
  const [provider] = await db.select().from(schema.ssoProviders).where(eq(schema.ssoProviders.id, id));
  return provider;
}

describe("SSO settings rendered forms", () => {
  it.each([
    ["/admin/idp", 0], ["/admin/idp", 1], ["/admin/sso", 0], ["/admin/sso", 1],
  ] as const)("%s saves provider %i with one CSRF token and keeps a blank secret", async (url, index) => {
    const page = await loadPage(url);
    const form = buttonForm(page, "保存修改", index);
    const provider = providers[index]!;
    const other = providers[1 - index]!;
    input(form, "label").value = "Updated SSO";
    input(form, "issuerUrl").value = "https://updated.example.com";
    input(form, "clientId").value = "updated-client";
    input(form, "sortOrder").value = "7";
    input(form, "enabled").checked = !provider.enabled;
    expect(input(form, "clientSecret").value).toBe("");
    expect(form.checkValidity()).toBe(true);
    expect(new URL(form.action).pathname).toBe(`/admin/idp/providers/${provider.id}`);
    const body = payload(page, form);
    const res = await submit(form, body);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/idp\?success=/);
    expect(body.getAll("_csrf")).toHaveLength(1);
    expect(await getProvider(provider.id)).toMatchObject({
      label: "Updated SSO", issuerUrl: "https://updated.example.com", clientId: "updated-client",
      sortOrder: 7, enabled: !provider.enabled, clientSecret: provider.clientSecret,
    });
    expect(await getProvider(other.id)).toEqual(other);
  });

  it("saves a replacement client secret", async () => {
    const page = await loadPage();
    const form = buttonForm(page, "保存修改");
    input(form, "clientSecret").value = "replacement-secret";
    const res = await submit(form, payload(page, form));
    expect(res.statusCode, res.body).toBe(302);
    expect((await getProvider(providers[0]!.id))?.clientSecret).toBe("replacement-secret");
  });

  it.each([0, 1])("deletes only provider %i through its separate confirmation form", async (index) => {
    const page = await loadPage();
    const edit = buttonForm(page, "保存修改", index);
    const form = buttonForm(page, "删除提供方", index);
    const provider = providers[index]!;
    const other = providers[1 - index]!;
    expect(form).not.toBe(edit);
    expect(new URL(form.action).pathname).toBe(`/admin/idp/providers/${provider.id}/delete`);
    expect(form.dataset.confirm).toContain(provider.label);
    expect(form.dataset.confirmDanger).toBe("1");
    // Invalid unsaved edits must not block deletion or leak into its request.
    input(edit, "clientId").value = "";
    expect(edit.checkValidity()).toBe(false);
    expect(form.checkValidity()).toBe(true);
    const body = payload(page, form);
    expect([...body.keys()]).toEqual(["_csrf"]);
    const res = await submit(form, body);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/idp\?success=/);
    expect(await getProvider(provider.id)).toBeUndefined();
    expect(await getProvider(other.id)).toEqual(other);
  });

  it.each([0, 2])("creates a provider when %i providers already exist", async (count) => {
    if (count === 0) await db.delete(schema.ssoProviders);
    const page = await loadPage();
    const form = buttonForm(page, "添加提供方");
    input(form, "slug").value = "new-provider";
    input(form, "label").value = "New SSO";
    input(form, "issuerUrl").value = "https://new.example.com";
    input(form, "clientId").value = "new-client";
    input(form, "clientSecret").value = "new-secret";
    const body = payload(page, form);
    expect(body.getAll("_csrf")).toHaveLength(1);
    expect(form.checkValidity()).toBe(true);
    const res = await submit(form, body);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/idp\?success=/);
    const rows = await db.select().from(schema.ssoProviders);
    expect(rows).toHaveLength(count + 1);
    expect(rows.find((p) => p.slug === "new-provider")).toMatchObject({
      label: "New SSO", issuerUrl: "https://new.example.com", clientId: "new-client",
      clientSecret: "new-secret", enabled: true,
    });
  });
});

describe.each(["保存修改", "删除提供方", "添加提供方"])("%s CSRF protection", (button) => {
  it.each(["missing", "invalid", "duplicate", "different-session"])("rejects %s tokens without changing providers", async (kind) => {
    const page = await loadPage();
    const form = buttonForm(page, button);
    const body = payload(page, form);
    if (kind === "missing") body.delete("_csrf");
    if (kind === "invalid") body.set("_csrf", "0".repeat(64));
    if (kind === "duplicate") body.append("_csrf", body.get("_csrf")!);
    if (kind === "different-session") sessionCookie = await loginAs(app, adminId);
    const before = await db.select().from(schema.ssoProviders).orderBy(schema.ssoProviders.slug);
    const res = await submit(form, body);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_invalid" });
    expect(await db.select().from(schema.ssoProviders).orderBy(schema.ssoProviders.slug)).toEqual(before);
  });
});
