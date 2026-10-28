// 网页上导入日历的两件事 —— 从 HTTP 打进去：
//
// 一、上传 .ics 要校验防伪造令牌。
//     以前这条只认 cookie。本站和同一个上级域名下的几十个站点在浏览器眼里是「同站」，
//     SameSite=Lax 的 cookie 会跟着带过来：其中任何一个页面，都能替正在登录的人往他的
//     日历里塞一份 .ics，跟着 CalDAV 同步到他所有的手机上。
//     **两个方向都测**：伪造的被拒、什么都没写进去；带令牌的照常导入 —— 只加校验、
//     表单没跟上的话，功能就整个坏了（admin 的站点 Logo 上传就这么坏过一次）。
//
// 二、「导入日历」弹窗（calendar-app.js）拿得到失败的原因。
//     以前四条导入路由一律 302 + ?error=，弹窗用 fetch 提交时读不到它，于是文件过大、
//     不是 .ics、粘贴超长，用户看到的都是「导入完成」。现在弹窗带 Accept: application/json，
//     路由回 { ok, message }；日历详情页的原生表单不带这个头，照旧 302。
//     两种请求头都从 HTTP 打一遍：JSON 这一档要的是「失败时 ok:false + 4xx + 能看懂的话」，
//     302 这一档要的是「原来的行为一点没变」。
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
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { webRoutes } = await import("../../src/web/index.js");
const { env } = await import("../../src/env.js");
const { MAX_ICS_IMPORT_BYTES, MAX_ICS_IMPORT_MB, MAX_ICS_PASTE_CHARS } = await import("../../src/lib/ics_limits.js");

beforeAll(async () => { await ensureSchema(); });
let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  // 全局上限和 src/server.ts 一样。
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
function ics(...uids: string[]): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//import//EN",
    ...uids.flatMap((uid) => [
      "BEGIN:VEVENT", `UID:${uid}`, "SUMMARY:导入的日程",
      "DTSTART:20261101T010000Z", "DTEND:20261101T020000Z", "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

const JSON_ACCEPT = { accept: "application/json" };
// 浏览器原生提交表单时的 Accept。
const FORM_ACCEPT = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

type Field = { name: string; value: string };
async function upload(
  s: { cookie: string }, calId: string, content: Buffer,
  opts: { before?: Field[]; headers?: Record<string, string> } = {},
) {
  const b = "----bwc" + Math.random().toString(36).slice(2);
  const field = (f: Field) => `--${b}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`;
  // 普通字段排在文件前面 —— 和日历页的表单、导入弹窗拼的 FormData 一样。
  const head = Buffer.from(
    (opts.before ?? []).map(field).join("") +
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="cal.ics"\r\nContent-Type: text/calendar\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${b}--\r\n`);
  return app.inject({
    method: "POST", url: `/app/calendars/${calId}/import/file`,
    headers: { cookie: s.cookie, "content-type": `multipart/form-data; boundary=${b}`, ...(opts.headers ?? {}) },
    payload: Buffer.concat([head, content, tail]),
  });
}

async function paste(s: Sess, calId: string, text: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST", url: `/app/calendars/${calId}/import/text`,
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams({ _csrf: s.csrf, text }).toString(),
  });
}

async function eventCount(calId: string) {
  return (await db.select().from(schema.events).where(eq(schema.events.calendarId, calId))).length;
}
const where = (res: { headers: Record<string, unknown> }) => decodeURIComponent(String(res.headers.location ?? ""));

// ---------------------------------------------------------------------------
// 一、上传 .ics 的防伪造令牌
// ---------------------------------------------------------------------------

describe("上传 .ics 不能被同站的别的页面代发", () => {
  it("**没带令牌 → 403，日历里一条都没多**", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.from(ics("forged-1@example.com", "forged-2@example.com")));
    expect(res.statusCode, "伪造的上传没被拒 —— 同站的任何页面都能往别人日历里塞事件").toBe(403);
    expect(res.body).toMatch(/csrf/i);
    expect(await eventCount(calId), "被拒了，事件却已经写进去了").toBe(0);
  });

  it("令牌是错的 → 403", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.from(ics("forged@example.com")), { before: [{ name: "_csrf", value: "0".repeat(64) }] });
    expect(res.statusCode).toBe(403);
    expect(await eventCount(calId)).toBe(0);
  });

  it("别人的令牌也不行（令牌绑在会话上）", async () => {
    const { s, calId } = await setup();
    const other = createHmac("sha256", env.SESSION_SECRET).update(newSessionId()).digest("hex");
    const res = await upload(s, calId, Buffer.from(ics("forged@example.com")), { before: [{ name: "_csrf", value: other }] });
    expect(res.statusCode).toBe(403);
  });

  it("**带令牌（排在文件前面）→ 照常导入**（日历页表单的形状）", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.from(ics("ok-1@example.com", "ok-2@example.com")),
      { before: [{ name: "_csrf", value: s.csrf }], headers: FORM_ACCEPT });
    expect(res.statusCode, `带着正确令牌的正常上传被拒了：${res.body.slice(0, 200)}`).toBe(302);
    expect(where(res), "没走到导入成功那一步").toContain("success=");
    expect(await eventCount(calId), "正常上传没有导进去").toBe(2);
  });

  it("令牌放在 X-CSRF-Token 头里也认（和其它路由一致）", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.from(ics("hdr@example.com")), { headers: { "x-csrf-token": s.csrf, ...JSON_ACCEPT } });
    expect(res.statusCode).toBe(200);
    expect(await eventCount(calId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 二、导入弹窗拿得到失败的原因（Accept: application/json），原生表单行为不变
// ---------------------------------------------------------------------------

describe("导入弹窗（Accept: application/json）：失败就是失败", () => {
  const withToken = (s: Sess) => ({ before: [{ name: "_csrf", value: s.csrf }], headers: JSON_ACCEPT });

  it("**上传超过上限 → 413 + ok:false + 带上限数字的那句话**（以前弹窗说「导入完成」）", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.alloc(MAX_ICS_IMPORT_BYTES + 1024, "x"), withToken(s));
    expect(res.statusCode).toBe(413);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const body = res.json();
    expect(body.ok, "超限的上传回给弹窗的不是失败").toBe(false);
    expect(body.message).toMatch(/过大/);
    expect(body.message).toContain(`${MAX_ICS_IMPORT_MB}MB`);
    expect(res.headers.location, "JSON 请求不该再跳转").toBeUndefined();
  });

  it("上传的不是 .ics → 400 + ok:false", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.from("this is not a calendar"), withToken(s));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.json().message).toMatch(/iCalendar/);
  });

  it("上传成功 → 200 + ok:true + 条数", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.from(ics("a@x", "b@x", "c@x")), withToken(s));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, inserted: 3, updated: 0 });
    expect(res.json().message).toMatch(/3/);
    expect(await eventCount(calId)).toBe(3);
  });

  it("**粘贴超过字符上限 → 413 + ok:false + 「太长、改用上传」**", async () => {
    const { s, calId } = await setup();
    const res = await paste(s, calId, "A".repeat(MAX_ICS_PASTE_CHARS + 1), JSON_ACCEPT);
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.ok, "超长的粘贴回给弹窗的不是失败").toBe(false);
    expect(body.message).toMatch(/1\D?000\D?000/);
    expect(body.message).toContain(`${MAX_ICS_IMPORT_MB}MB`);
  });

  it("粘贴的不是 iCalendar → 400 + ok:false", async () => {
    const { s, calId } = await setup();
    const res = await paste(s, calId, "随便贴了一段不是日历的文字，长度超过二十个字", JSON_ACCEPT);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.json().message).toMatch(/iCalendar/);
    expect(await eventCount(calId)).toBe(0);
  });

  it("粘贴成功 → 200 + ok:true", async () => {
    const { s, calId } = await setup();
    const res = await paste(s, calId, ics("p@x"), JSON_ACCEPT);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, inserted: 1 });
    expect(await eventCount(calId)).toBe(1);
  });

  it("从 URL 导入一次、拉不下来 → 502 + ok:false + 原因", async () => {
    const { s, calId } = await setup();
    const res = await app.inject({
      method: "POST", url: `/app/calendars/${calId}/import/url-once`,
      headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", ...JSON_ACCEPT },
      payload: new URLSearchParams({ _csrf: s.csrf, url: "not-a-url" }).toString(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.json().message).toMatch(/http/);
  });

  it("新建订阅、第一次拉取失败 → ok:true + partial（订阅已经存下了，弹窗不能让人再建一条）", async () => {
    const { s, calId } = await setup();
    const res = await app.inject({
      method: "POST", url: `/app/calendars/${calId}/subscriptions`,
      headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", ...JSON_ACCEPT },
      payload: new URLSearchParams({ _csrf: s.csrf, url: "not-a-url" }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, partial: true });
    const subs = await db.select().from(schema.calendarSubscriptions).where(eq(schema.calendarSubscriptions.calendarId, calId));
    expect(subs.length).toBe(1);
  });

  it("令牌不对 → 403，不会回 ok:true", async () => {
    const { s, calId } = await setup();
    const res = await paste({ ...s, csrf: "0".repeat(64) }, calId, ics("x@x"), JSON_ACCEPT);
    expect(res.statusCode).toBe(403);
    expect(res.json().ok).not.toBe(true);
    expect(await eventCount(calId)).toBe(0);
  });
});

describe("日历详情页的原生表单（不带 Accept: application/json）：行为不变", () => {
  it("上传超限 → 照旧 302 回详情页、?error= 里是那句话", async () => {
    const { s, calId } = await setup();
    const res = await upload(s, calId, Buffer.alloc(MAX_ICS_IMPORT_BYTES + 1024, "x"),
      { before: [{ name: "_csrf", value: s.csrf }], headers: FORM_ACCEPT });
    expect(res.statusCode).toBe(302);
    expect(where(res)).toContain(`/app/calendars/${calId}?error=`);
    expect(where(res)).toMatch(/过大/);
  });

  it("粘贴成功 → 照旧 302 + ?success=", async () => {
    const { s, calId } = await setup();
    const res = await paste(s, calId, ics("form@x"), FORM_ACCEPT);
    expect(res.statusCode).toBe(302);
    expect(where(res)).toContain(`/app/calendars/${calId}?success=`);
  });

  it("没写 Accept 也按原生表单处理", async () => {
    const { s, calId } = await setup();
    const res = await paste(s, calId, "不是日历不是日历不是日历不是日历不是日历不是日历");
    expect(res.statusCode).toBe(302);
    expect(where(res)).toContain("?error=");
  });
});
