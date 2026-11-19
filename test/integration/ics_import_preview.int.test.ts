// 导入预览：写入之前先把结果给用户看（共 N 条、新增 / 更新 / 重复 / 无效）。
//
// 这一档盯三件事：
//   一、预览不落库 —— 预览完日历里一条都不能多；
//   二、口径一致 —— 预览说的新增 / 更新 / 重复，和紧接着真实导入的结果逐项
//       相等（判定是同一份 planImport，这里从 HTTP 两条路各验一遍）；
//   三、无效要能解释 —— 解析不出来的块单列 invalid 并给原因（缺哪个字段），
//       它在真实导入里根本不入账（连 total 都不算），预览把它捞出来给用户看。
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
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { webRoutes } = await import("../../src/web/index.js");
const { env } = await import("../../src/env.js");

beforeAll(async () => { await ensureSchema(); });
let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });
  await app.register(webRoutes);
  await app.ready();
});
afterEach(async () => { await app.close(); });

type Sess = { cookie: string; csrf: string };

async function setup(): Promise<{ s: Sess; calId: string }> {
  const u = await makeUser("a@example.com");
  const cal = await makeCalendar(u.id);
  const sid = newSessionId();
  await db.insert(schema.sessions).values({ id: sid, userId: u.id, mfaSatisfied: true, expiresAt: new Date(Date.now() + 86400_000) });
  return {
    s: {
      cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
      csrf: createHmac("sha256", env.SESSION_SECRET).update(sid).digest("hex"),
    },
    calId: cal.id,
  };
}

const CRLF = "\r\n";
function vevent(uid: string, summary = "导入的日程"): string[] {
  return [
    "BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`,
    "DTSTART:20261101T010000Z", "DTEND:20261101T020000Z", "END:VEVENT",
  ];
}
function ics(...blocks: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//import//EN", ...blocks.flat(), "END:VCALENDAR"].join(CRLF) + CRLF;
}

type Preview = { total: number; inserted: number; updated: number; duplicates: number; invalid: number; invalidReasons: string[] };

async function previewText(s: Sess, calId: string, text: string): Promise<Preview> {
  const res = await app.inject({
    method: "POST", url: `/app/calendars/${calId}/import/preview/text`,
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    payload: new URLSearchParams({ _csrf: s.csrf, text }).toString(),
  });
  expect(res.statusCode, `预览失败: ${res.body.slice(0, 200)}`).toBe(200);
  const body = JSON.parse(res.body) as { ok: boolean; preview: Preview };
  expect(body.ok).toBe(true);
  return body.preview;
}

async function importText(s: Sess, calId: string, text: string) {
  const res = await app.inject({
    method: "POST", url: `/app/calendars/${calId}/import/text`,
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    payload: new URLSearchParams({ _csrf: s.csrf, text }).toString(),
  });
  expect(res.statusCode, `导入失败: ${res.body.slice(0, 200)}`).toBe(200);
  return JSON.parse(res.body) as { ok: boolean; inserted: number; updated: number; skipped: number };
}

async function uploadTo(s: Sess, calId: string, path: string, content: Buffer) {
  const b = "----bwc" + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${s.csrf}\r\n` +
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="cal.ics"\r\nContent-Type: text/calendar\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${b}--\r\n`);
  return app.inject({
    method: "POST", url: `/app/calendars/${calId}/${path}`,
    headers: { cookie: s.cookie, "content-type": `multipart/form-data; boundary=${b}`, accept: "application/json" },
    payload: Buffer.concat([head, content, tail]),
  });
}

async function eventCount(calId: string) {
  return (await db.select().from(schema.events).where(eq(schema.events.calendarId, calId))).length;
}

describe("导入预览（粘贴）", () => {
  it("空日历预览全是新增，且预览完库里一条都没有", async () => {
    const { s, calId } = await setup();
    const text = ics(vevent("p1@example.com"), vevent("p2@example.com"), vevent("p3@example.com"));
    const p = await previewText(s, calId, text);
    expect(p).toMatchObject({ total: 3, inserted: 3, updated: 0, duplicates: 0, invalid: 0 });
    expect(await eventCount(calId), "预览不许落库").toBe(0);
  });

  it("预览的新增 / 更新 / 重复与紧接着的真实导入逐项相等", async () => {
    const { s, calId } = await setup();
    const v1 = ics(vevent("q1@example.com"), vevent("q2@example.com"), vevent("q3@example.com"));
    await importText(s, calId, v1);

    // 原样再导：全是重复。
    const p1 = await previewText(s, calId, v1);
    expect(p1).toMatchObject({ inserted: 0, updated: 0, duplicates: 3, invalid: 0 });
    const r1 = await importText(s, calId, v1);
    expect(r1).toMatchObject({ inserted: p1.inserted, updated: p1.updated, skipped: p1.duplicates + p1.invalid });

    // 改一条标题、加一条新的：1 更新 + 1 新增 + 2 重复。
    const v2 = ics(
      vevent("q1@example.com", "改过的标题"),
      vevent("q2@example.com"), vevent("q3@example.com"), vevent("q4@example.com"),
    );
    const p2 = await previewText(s, calId, v2);
    expect(p2).toMatchObject({ total: 4, inserted: 1, updated: 1, duplicates: 2, invalid: 0 });
    const r2 = await importText(s, calId, v2);
    expect(r2).toMatchObject({ inserted: p2.inserted, updated: p2.updated, skipped: p2.duplicates + p2.invalid });
    expect(await eventCount(calId)).toBe(4);
  });

  it("解析不出来的块单列 invalid 并给原因（缺 DTSTART），且不入真实导入的账", async () => {
    const { s, calId } = await setup();
    const broken = ["BEGIN:VEVENT", "UID:broken@example.com", "SUMMARY:坏事件", "DTEND:20261101T020000Z", "END:VEVENT"];
    const text = ics(vevent("ok@example.com"), broken);
    const p = await previewText(s, calId, text);
    expect(p.total).toBe(2);
    expect(p.inserted).toBe(1);
    expect(p.invalid).toBe(1);
    expect(p.invalidReasons.join(" ")).toContain("DTSTART");
    const r = await importText(s, calId, text);
    expect(r.inserted).toBe(1);
    expect(await eventCount(calId)).toBe(1);
  });
});

describe("导入预览（文件）", () => {
  it("文件预览与粘贴同口径，且不落库", async () => {
    const { s, calId } = await setup();
    const content = Buffer.from(ics(vevent("f1@example.com"), vevent("f2@example.com")));
    const res = await uploadTo(s, calId, "import/preview/file", content);
    expect(res.statusCode, `文件预览失败: ${res.body.slice(0, 200)}`).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; preview: Preview };
    expect(body.ok).toBe(true);
    expect(body.preview).toMatchObject({ total: 2, inserted: 2, updated: 0, duplicates: 0, invalid: 0 });
    expect(await eventCount(calId), "预览不许落库").toBe(0);

    // 真导入之后再预览同一份文件：全变重复。
    const imp = await uploadTo(s, calId, "import/file", content);
    expect(imp.statusCode).toBe(200);
    const res2 = await uploadTo(s, calId, "import/preview/file", content);
    const body2 = JSON.parse(res2.body) as { ok: boolean; preview: Preview };
    expect(body2.preview).toMatchObject({ inserted: 0, duplicates: 2 });
  });

  it("没带令牌的文件预览同样被拒（校验口径和导入一致）", async () => {
    const { s, calId } = await setup();
    const b = "----bwc" + Math.random().toString(36).slice(2);
    const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="cal.ics"\r\nContent-Type: text/calendar\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${b}--\r\n`);
    const res = await app.inject({
      method: "POST", url: `/app/calendars/${calId}/import/preview/file`,
      headers: { cookie: s.cookie, "content-type": `multipart/form-data; boundary=${b}` },
      payload: Buffer.concat([head, Buffer.from(ics(vevent("x@example.com"))), tail]),
    });
    expect(res.statusCode).toBe(403);
    expect(await eventCount(calId)).toBe(0);
  });
});
