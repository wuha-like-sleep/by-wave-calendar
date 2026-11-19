// API（/api/v1）ICS 导入：给三个客户端补的入口，导入核心和网页端共用
// 同一份（ics_import.ts），这里盯的是 API 这一层的口径：
//   一、计数与幂等 —— 导入的新增 / 更新 / 跳过和网页导入同一口径，
//       同一份文件重复导第二次必须全是跳过；
//   二、预览同口径且不落库 —— 预览的数字和紧接着真实导入逐项对得上；
//   三、权限 —— 没认证 401、只读 Token 403（token_is_read_only）、
//       别人的日历 404；
//   四、上限 —— 解码后文本超过 8MB 回 413，不是 iCalendar 回 400。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp, loginAs,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "<redacted>";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { importRoutes } = await import("../../src/routes/import.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  // 先 getSettings 把 site_settings 那行建出来，updateSettings 才有行可改。
  reloadSettings();
  await getSettings();
  await updateSettings({ apiEnabled: true });
  app = await buildRoutedApp(async (a) => { await importRoutes(a); }, { prefix: "/api/v1" });
});
afterEach(async () => { await app.close(); });

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

async function seed(scope: "read" | "write" = "write") {
  const user = await makeUser("a@example.com");
  const cal = await makeCalendar(user.id);
  const issued = await createApiToken({ userId: user.id, label: "App", scope });
  return { user, cal, auth: { authorization: `Bearer ${issued.plain}` } };
}

async function eventCount(calId: string): Promise<number> {
  const rows = await db.select({ id: schema.events.id }).from(schema.events)
    .where(eq(schema.events.calendarId, calId));
  return rows.length;
}

type ImportResult = { inserted: number; updated: number; skipped: number; total: number };
type Preview = { total: number; inserted: number; updated: number; duplicates: number; invalid: number; invalidReasons: string[] };

async function callImport(calId: string, headers: Record<string, string>, body: unknown, preview = false) {
  return app.inject({
    method: "POST",
    url: `/api/v1/calendars/${calId}/import${preview ? "/preview" : ""}`,
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
}

describe("POST /api/v1/calendars/:id/import", () => {
  it("导入计数正确，同一份文件再导一次全部跳过（幂等）", async () => {
    const { cal, auth } = await seed();
    const text = ics(vevent("evt-0001-import"), vevent("evt-0002-import", "第二场"));

    const first = await callImport(cal.id, auth, { text, filename: "trip.ics" });
    expect(first.statusCode, first.body.slice(0, 300)).toBe(200);
    const r1 = (first.json() as { data: ImportResult }).data;
    expect(r1).toEqual({ inserted: 2, updated: 0, skipped: 0, total: 2 });
    expect(await eventCount(cal.id)).toBe(2);

    const second = await callImport(cal.id, auth, { text, filename: "trip.ics" });
    const r2 = (second.json() as { data: ImportResult }).data;
    expect(r2).toEqual({ inserted: 0, updated: 0, skipped: 2, total: 2 });
    expect(await eventCount(cal.id)).toBe(2);
  });

  it("内容变了的算更新，没变的跳过", async () => {
    const { cal, auth } = await seed();
    await callImport(cal.id, auth, { text: ics(vevent("evt-0001-import"), vevent("evt-0002-import")), filename: "a.ics" });
    const changed = ics(vevent("evt-0001-import"), vevent("evt-0002-import", "改了标题"));
    const res = await callImport(cal.id, auth, { text: changed, filename: "a.ics" });
    const r = (res.json() as { data: ImportResult }).data;
    expect(r).toEqual({ inserted: 0, updated: 1, skipped: 1, total: 2 });
  });

  it("预览不落库，且数字和紧接着的真实导入逐项相等", async () => {
    const { cal, auth } = await seed();
    const text = ics(vevent("evt-0001-import"), vevent("evt-0002-import"));
    const p = await callImport(cal.id, auth, { text, filename: "a.ics" }, true);
    expect(p.statusCode, p.body.slice(0, 300)).toBe(200);
    const preview = (p.json() as { data: Preview }).data;
    expect(preview.total).toBe(2);
    expect(preview.inserted).toBe(2);
    expect(await eventCount(cal.id)).toBe(0);

    const r = (await callImport(cal.id, auth, { text, filename: "a.ics" })).json() as { data: ImportResult };
    expect(r.data.inserted).toBe(preview.inserted);
    expect(r.data.updated).toBe(preview.updated);
    expect(r.data.skipped).toBe(preview.duplicates + preview.invalid);
  });

  it("预览能把解析不出的块单列 invalid 并给原因", async () => {
    const { cal, auth } = await seed();
    const broken = ["BEGIN:VEVENT", "UID:broken-1", "SUMMARY:缺结束时间", "DTSTART:20261101T010000Z", "END:VEVENT"];
    const p = await callImport(cal.id, auth, { text: ics(vevent("evt-0001-import"), broken), filename: "a.ics" }, true);
    const preview = (p.json() as { data: Preview }).data;
    expect(preview.total).toBe(2);
    expect(preview.inserted).toBe(1);
    expect(preview.invalid).toBe(1);
    expect(preview.invalidReasons.length).toBeGreaterThan(0);
    expect(await eventCount(cal.id)).toBe(0);
  });

  it("会话 cookie 也能导（网页内嵌场景与 Token 走同一条路）", async () => {
    const user = await makeUser("cookie@example.com");
    const cal = await makeCalendar(user.id);
    const cookie = await loginAs(app, user.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/calendars/${cal.id}/import`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ text: ics(vevent("evt-0001-import")), filename: "a.ics" }),
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(await eventCount(cal.id)).toBe(1);
  });
});

describe("权限与上限", () => {
  it("没带认证 → 401", async () => {
    const { cal } = await seed();
    const res = await callImport(cal.id, {}, { text: ics(vevent("evt-0001-import")) });
    expect(res.statusCode).toBe(401);
    expect(await eventCount(cal.id)).toBe(0);
  });

  it("假 Token → 401", async () => {
    const { cal } = await seed();
    const res = await callImport(cal.id, { authorization: "Bearer <redacted>" }, { text: ics(vevent("evt-0001-import")) });
    expect(res.statusCode).toBe(401);
  });

  it("只读 Token 导入和预览都 → 403 token_is_read_only", async () => {
    const { cal, auth } = await seed("read");
    const res = await callImport(cal.id, auth, { text: ics(vevent("evt-0001-import")) });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("token_is_read_only");
    const p = await callImport(cal.id, auth, { text: ics(vevent("evt-0001-import")) }, true);
    expect(p.statusCode).toBe(403);
    expect(await eventCount(cal.id)).toBe(0);
  });

  it("往别人的日历导 → 404", async () => {
    const { auth } = await seed();
    const other = await makeUser("other@example.com");
    const otherCal = await makeCalendar(other.id);
    const res = await callImport(otherCal.id, auth, { text: ics(vevent("evt-0001-import")) });
    expect(res.statusCode).toBe(404);
    expect(await eventCount(otherCal.id)).toBe(0);
  });

  it("日历 id 不是 uuid → 404", async () => {
    const { auth } = await seed();
    const res = await callImport("not-a-uuid", auth, { text: ics(vevent("evt-0001-import")) });
    expect(res.statusCode).toBe(404);
  });

  it("解码后超过 8MB → 413", async () => {
    const { cal, auth } = await seed();
    const big = "BEGIN:VCALENDAR\r\nX-PAD:" + "a".repeat(8 * 1024 * 1024) + "\r\nEND:VCALENDAR\r\n";
    const res = await callImport(cal.id, auth, { text: big, filename: "big.ics" });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(413);
    expect(await eventCount(cal.id)).toBe(0);
  });

  it("不是 iCalendar 内容 → 400", async () => {
    const { cal, auth } = await seed();
    const res = await callImport(cal.id, auth, { text: "这只是一段普通文本，不是日历文件。" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("not_ics");
  });
});
