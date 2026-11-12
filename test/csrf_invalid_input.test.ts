import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { csrfTokenFor, verifyCsrf, verifyMultipartCsrf } from "../src/lib/csrf.js";

const app = Fastify();
let token: string;
beforeAll(async () => {
  await app.register(cookie, { secret: "csrf-test-cookie-secret-32-characters" });
  app.get("/token", (req) => ({ token: csrfTokenFor(req) }));
  app.post("/form", (req, reply) => {
    if (!verifyCsrf(req, reply)) return reply;
    return { ok: true };
  });
  // Supply the parsed field shape used by @fastify/multipart.
  app.post("/multipart", (req, reply) => {
    const fields = { _csrf: { value: (req.body as { _csrf?: unknown })?._csrf } };
    if (!verifyMultipartCsrf(req, reply, fields)) return reply;
    return { ok: true };
  });
  token = (await app.inject("/token")).json().token;
});
afterAll(async () => { await app.close(); });

describe.each(["/form", "/multipart"])("%s rejects malformed tokens safely", (url) => {
  it.each(["é".repeat(64), "中".repeat(64), "😀".repeat(32), "x".repeat(64), "", ["duplicate", "duplicate"], null])("rejects %j with 403, not an exception", async (_csrf) => {
    const res = await app.inject({ method: "POST", url, payload: { _csrf } });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_invalid" });
  });
  it("accepts the current token from the body and header", async () => {
    const body = await app.inject({ method: "POST", url, payload: { _csrf: token } });
    expect(body.statusCode).toBe(200);
    const header = await app.inject({ method: "POST", url, headers: { "x-csrf-token": token }, payload: {} });
    expect(header.statusCode).toBe(200);
  });
});
