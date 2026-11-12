import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
vi.mock("../src/env.js", () => ({ env: { NODE_ENV: "production", SESSION_SECRET: "feedback-test-secret-at-least-32-characters" } }));
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { FLASH_COOKIE, readFlash, redirectWithFlash, type Flash } from "../src/lib/flash.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  app.post<{ Querystring: { target?: string }; Body: Flash }>("/save", (req, reply) => redirectWithFlash(reply, req.query.target ?? "/result", req.body));
  app.get("/result", (req, reply) => ({ flash: readFlash(req, reply), again: readFlash(req, reply) }));
  app.get("/elsewhere", (req, reply) => readFlash(req, reply));
  app.get("/oauth/callback", (req) => req.query);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => app.close());
function cookieHeader(res: { cookies: Array<{ name: string; value: string }> }) {
  return `${FLASH_COOKIE}=${encodeURIComponent(res.cookies.find(c => c.name === FLASH_COOKIE)!.value)}`;
}

it("redirects to a clean URL while retaining filters and anchors", async () => {
  const target = "/result?q=a%26b&page=2&success=" + encodeURIComponent("已更新 提供方") + "#providers";
  const save = await app.inject({ method: "POST", url: "/save?target=" + encodeURIComponent(target), payload: {} });
  expect(save.statusCode).toBe(302);
  expect(save.headers.location).toBe("/result?q=a%26b&page=2#providers");
  expect(String(save.headers["set-cookie"])).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  expect(String(save.headers["set-cookie"])).toContain("Max-Age=120");
  expect(save.headers["cache-control"]).toBe("no-store");
  const page = await app.inject({ url: "/result?q=a%26b&page=2", headers: { cookie: cookieHeader(save) } });
  expect(page.json()).toEqual({ flash: { success: "已更新 提供方" }, again: { success: "已更新 提供方" } });
  expect(page.cookies.find(c => c.name === FLASH_COOKIE)?.value).toBe("");
  expect(page.headers["cache-control"]).toBe("no-store");
  expect((await app.inject("/result")).json().flash).toEqual({});
});

it("does not consume feedback on another page or a HEAD request", async () => {
  const save = await app.inject({ method: "POST", url: "/save", payload: { error: "保存失败" } });
  const headers = { cookie: cookieHeader(save) };
  expect((await app.inject({ url: "/elsewhere", headers })).headers["set-cookie"]).toBeUndefined();
  expect((await app.inject({ method: "HEAD", url: "/result", headers })).headers["set-cookie"]).toBeUndefined();
  expect((await app.inject({ url: "/result", headers })).json().flash.error).toBe("保存失败");
});

it.each(["tampered", "expired", "malformed"])("discards %s cookies without failing the page", async (kind) => {
  const save = await app.inject({ method: "POST", url: "/save", payload: { success: "saved" } });
  let value = save.cookies.find(c => c.name === FLASH_COOKIE)!.value;
  if (kind === "tampered") {
    const bytes = Buffer.from(value, "base64url"); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; value = bytes.toString("base64url");
  } else if (kind === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
  else value = "broken";
  const page = await app.inject({ url: "/result", headers: { cookie: `${FLASH_COOKIE}=${value}` } });
  expect(page.statusCode).toBe(200);
  expect(page.json().flash).toEqual({});
  expect(page.cookies.find(c => c.name === FLASH_COOKIE)?.value).toBe("");
});

it("limits Unicode messages to a cookie the browser can store", async () => {
  const save = await app.inject({ method: "POST", url: "/save", payload: { success: "日历🙂".repeat(2000), error: "失败".repeat(2000) } });
  expect(String(save.headers["set-cookie"]).length).toBeLessThan(4000);
  const { flash } = (await app.inject({ url: "/result", headers: { cookie: cookieHeader(save) } })).json();
  expect(flash.success.endsWith("…")).toBe(true);
  expect(flash.success).not.toContain("�");
  expect(flash.error.endsWith("…")).toBe(true);
});

it.each(["newAppPassword", "issuedToken"] as const)("encrypts %s and binds it to the issuing session", async (field) => {
  const secret = "test-only-issued-credential";
  const save = await app.inject({ method: "POST", url: "/save", headers: { cookie: "bwc_sid=session-one" }, payload: { [field]: secret, success: "created" } });
  expect(save.headers.location).toBe("/result");
  expect(String(save.headers["set-cookie"])).not.toContain(secret);
  expect(Buffer.from(save.cookies[0]!.value, "base64url").toString()).not.toContain(secret);
  expect((await app.inject({ url: "/result", headers: { cookie: cookieHeader(save) + "; bwc_sid=session-two" } })).json().flash).toEqual({});
  expect((await app.inject({ url: "/result", headers: { cookie: cookieHeader(save) + "; bwc_sid=session-one" } })).json().flash[field]).toBe(secret);
});

it("does not trust query-string messages or change OAuth protocol errors", async () => {
  expect((await app.inject("/result?success=forged")).json().flash).toEqual({});
  expect((await app.inject("/oauth/callback?error=access_denied&state=opaque")).json()).toEqual({ error: "access_denied", state: "opaque" });
});

it.each(["//example.com/", "/\\example.com/", "/\t/example.com/"])("rejects non-local feedback destinations: %s", async (target) => {
  const save = await app.inject({ method: "POST", url: "/save?target=" + encodeURIComponent(target), payload: { success: "saved" } });
  expect(save.statusCode).toBe(500);
  expect(save.headers.location).toBeUndefined();
});
