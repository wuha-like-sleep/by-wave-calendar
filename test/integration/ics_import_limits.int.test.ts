// 导入日历（.ics）的大小上限 —— 从 HTTP 打进去，看真正生效的是哪个数。
//
// 这条路踩过两次「代码里写着一个上限、实际生效的是另一个」：
//   · 上传：路由写 5MB，没带 per-request limits，实际是全局的 2MB；
//   · 粘贴：zod 写 1,000,000 字符，可请求体先撞上全局 2MB —— 表单是 urlencoded，
//     一个汉字转义成 9 字节，中文多的日历五六十万字符就被 Fastify 回英文 413，
//     根本走不到「内容太长」那句话。
// 所以这里的 Fastify 用和生产一样的 2MB bodyLimit、2MB 的 multipart 全局上限。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { createHmac } from "node:crypto";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { webRoutes } = await import("../../src/web/index.js");
const { env } = await import("../../src/env.js");
const { MAX_ICS_IMPORT_BYTES, MAX_ICS_IMPORT_MB, MAX_ICS_PASTE_CHARS } = await import("../../src/lib/ics_limits.js");

beforeAll(async () => { await ensureSchema(); });
let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  // 和 src/server.ts 一样的两道全局上限 —— 这一档要测的正是「路由有没有自己顶掉它」。
  app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });
  await app.register(webRoutes);
  await app.ready();
});
afterEach(async () => { await app.close(); });

async function sessionFor(userId: string) {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({ id: sid, userId, mfaSatisfied: true, expiresAt: new Date(Date.now() + 86400_000) });
  return {
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", env.SESSION_SECRET).update(sid).digest("hex"),
  };
}

async function setup() {
  const u = await makeUser("a@example.com");
  const cal = await makeCalendar(u.id);
  return { s: await sessionFor(u.id), calId: cal.id };
}

async function paste(s: { cookie: string; csrf: string }, calId: string, text: string) {
  return app.inject({
    method: "POST", url: `/app/calendars/${calId}/import/text`,
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ _csrf: s.csrf, text }).toString(),
  });
}

async function upload(s: { cookie: string; csrf: string }, calId: string, content: Buffer) {
  const b = "----bwc" + Math.random().toString(36).slice(2);
  // _csrf 排在文件前面，和日历页的表单一样（这条路现在校验令牌，见 web_ics_import.int.test.ts）。
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${s.csrf}\r\n` +
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="cal.ics"\r\nContent-Type: text/calendar\r\n\r\n`,
  );
  return app.inject({
    method: "POST", url: `/app/calendars/${calId}/import/file`,
    headers: { cookie: s.cookie, "content-type": `multipart/form-data; boundary=${b}` },
    payload: Buffer.concat([head, content, Buffer.from(`\r\n--${b}--\r\n`)]),
  });
}

const where = (res: { headers: Record<string, unknown> }) => decodeURIComponent(String(res.headers.location ?? ""));

describe("粘贴 .ics 文本", () => {
  it("**中文多的内容，没到字符上限就不能撞上请求体上限**（以前是英文 413）", async () => {
    const { s, calId } = await setup();
    // 40 万个汉字：远小于 MAX_ICS_PASTE_CHARS，转义后 3.6MB，超过全局 2MB。
    const text = "中".repeat(400_000);
    expect(new URLSearchParams({ text }).toString().length, "夹具没超过 2MB，这条用例什么也没测到")
      .toBeGreaterThan(2 * 1024 * 1024);
    const res = await paste(s, calId, text);
    expect(
      res.statusCode,
      "没超字符上限的粘贴被请求体上限挡掉了 —— 对中文用户，真正生效的上限是另一个、随内容变的数字",
    ).toBe(302);
    // 内容本身不是 iCalendar，所以落在「不是 iCalendar 格式」那句 —— 说明走进了路由，
    // 而且没被当成「太长」。
    expect(where(res)).toContain("iCalendar");
    expect(where(res)).not.toMatch(/1\D?000\D?000/);
  });

  it("**超过字符上限 → 明说太长、改用上传**，而不是「请粘贴 .ics 文本内容」", async () => {
    const { s, calId } = await setup();
    const res = await paste(s, calId, "A".repeat(MAX_ICS_PASTE_CHARS + 1));
    expect(res.statusCode).toBe(302);
    const msg = where(res);
    expect(msg, "超长时给的提示里没有上限数字 —— 用户贴了一大段，看到的却是「请粘贴」").toMatch(/1\D?000\D?000/);
    expect(msg, "没告诉用户可以改用上传、上传的上限是多少").toContain(`${MAX_ICS_IMPORT_MB}MB`);
  });
});

describe("上传 .ics 文件", () => {
  it("超过全局 2MB、没到上限的文件能收下", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.alloc(3 * 1024 * 1024, "x"));
    expect(res.statusCode).toBe(302);
    expect(where(res), "3MB 的文件被当成过大拒了").not.toMatch(/过大|上限/);
  });

  it("**超过上限时，报错里的数字就是代码里的上限**（以前写 >5MB，实际是 8MB）", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.alloc(MAX_ICS_IMPORT_BYTES + 1024, "x"));
    expect(res.statusCode).toBe(302);
    const msg = where(res);
    expect(msg, "超限时没给出「过大」的提示").toMatch(/过大/);
    expect(msg, `报错里写的上限不是代码里的 ${MAX_ICS_IMPORT_MB}MB`).toContain(`${MAX_ICS_IMPORT_MB}MB`);
    expect(msg, "报错里漏出了没填的占位符").not.toContain("{mb}");
  });
});
