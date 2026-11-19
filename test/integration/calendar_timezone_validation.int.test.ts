// 日历 timezone 的写入关口：以前只有长度校验（≤100），乱填的字符串
// 能存进去，展开重复事件时静默回退 UTC，用户毫无察觉。这里钉住新口径：
//   一、合法 IANA 名原样落库；大小写 / 别名 / 前后空白归一化成规范名；
//   二、非法（含空串、纯空白）回 400，错误码 invalid_timezone，文案按
//       请求语言走，且不落库、PATCH 不动原值；
//   三、timezone 不在场的请求完全不受影响（建走默认、改不动原值），
//       存量脏值日历改别的字段也不会被这道关口卡住 —— 校验只管
//       「这次请求带来的 timezone」。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, makeUser, buildRoutedApp, db, schema,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { calendarRoutes } = await import("../../src/routes/calendars.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  reloadSettings();
  await getSettings();
  await updateSettings({ apiEnabled: true });
  app = await buildRoutedApp(async (a) => { await calendarRoutes(a); }, { prefix: "/api/v1" });
});
afterEach(async () => { await app.close(); });

async function seed(email = "a@example.com") {
  const user = await makeUser(email);
  const issued = await createApiToken({ userId: user.id, label: "App", scope: "write" });
  return { user, auth: { authorization: `Bearer ${issued.plain}` } };
}

type CalRow = { id: string; name: string; timezone: string };

async function createCal(auth: Record<string, string>, body: unknown, url = "/api/v1/calendars") {
  return app.inject({
    method: "POST", url,
    headers: { "content-type": "application/json", ...auth },
    payload: JSON.stringify(body),
  });
}

async function patchCal(auth: Record<string, string>, id: string, body: unknown) {
  return app.inject({
    method: "PATCH", url: `/api/v1/calendars/${id}`,
    headers: { "content-type": "application/json", ...auth },
    payload: JSON.stringify(body),
  });
}

async function listCals(auth: Record<string, string>): Promise<CalRow[]> {
  const res = await app.inject({ method: "GET", url: "/api/v1/calendars", headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json().data as CalRow[];
}

describe("POST /api/v1/calendars timezone 校验与归一化", () => {
  it("规范名原样落库", async () => {
    const { auth } = await seed();
    const res = await createCal(auth, { name: "工作", timezone: "Australia/Melbourne" });
    expect(res.statusCode).toBe(201);
    expect((res.json().data as CalRow).timezone).toBe("Australia/Melbourne");
  });

  it("大小写不规范归一化成规范名", async () => {
    const { auth } = await seed();
    const res = await createCal(auth, { name: "工作", timezone: "asia/shanghai" });
    expect(res.statusCode).toBe(201);
    expect((res.json().data as CalRow).timezone).toBe("Asia/Shanghai");
    expect((await listCals(auth))[0]!.timezone).toBe("Asia/Shanghai");
  });

  it("别名归一化到规范名", async () => {
    const { auth } = await seed();
    const cn = await createCal(auth, { name: "甲", timezone: "Asia/Chongqing" });
    expect(cn.statusCode).toBe(201);
    expect((cn.json().data as CalRow).timezone).toBe("Asia/Shanghai");
    const us = await createCal(auth, { name: "乙", timezone: "US/Eastern" });
    expect(us.statusCode).toBe(201);
    expect((us.json().data as CalRow).timezone).toBe("America/New_York");
  });

  it("前后空白先 trim 再校验", async () => {
    const { auth } = await seed();
    const res = await createCal(auth, { name: "工作", timezone: "  Europe/Berlin " });
    expect(res.statusCode).toBe(201);
    expect((res.json().data as CalRow).timezone).toBe("Europe/Berlin");
  });

  it("非法时区回 400 invalid_timezone 且不落库", async () => {
    const { auth } = await seed();
    const res = await createCal(auth, { name: "工作", timezone: "Mars/Olympus" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_timezone");
    expect(body.error.message).toContain("Mars/Olympus");
    expect(await listCals(auth)).toHaveLength(0);
  });

  it("空串与纯空白同样是非法，而不是走默认", async () => {
    const { auth } = await seed();
    for (const timezone of ["", "   "]) {
      const res = await createCal(auth, { name: "工作", timezone });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_timezone");
    }
    expect(await listCals(auth)).toHaveLength(0);
  });

  it("错误文案按请求语言走：?lang=en 给英文，默认给中文", async () => {
    const { auth } = await seed();
    const en = await createCal(auth, { name: "x", timezone: "Nowhere/Special" }, "/api/v1/calendars?lang=en");
    expect(en.statusCode).toBe(400);
    expect(en.json().error.message).toContain("Invalid time zone");
    const zh = await createCal(auth, { name: "x", timezone: "Nowhere/Special" });
    expect(zh.statusCode).toBe(400);
    expect(zh.json().error.message).toContain("不合法");
  });
});

describe("PATCH /api/v1/calendars/:id timezone 校验与归一化", () => {
  it("别名归一化后落库", async () => {
    const { auth } = await seed();
    const created = (await createCal(auth, { name: "工作", timezone: "Asia/Shanghai" })).json().data as CalRow;
    const res = await patchCal(auth, created.id, { timezone: "US/Eastern" });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as CalRow).timezone).toBe("America/New_York");
  });

  it("PATCH 同区的别名归一化后与原值相同，不算换时区", async () => {
    const { auth } = await seed();
    const created = (await createCal(auth, { name: "工作", timezone: "Asia/Shanghai" })).json().data as CalRow;
    const res = await patchCal(auth, created.id, { timezone: "Asia/Chongqing" });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as CalRow).timezone).toBe("Asia/Shanghai");
  });

  it("非法时区回 400 invalid_timezone 且原值不动", async () => {
    const { auth } = await seed();
    const created = (await createCal(auth, { name: "工作", timezone: "Europe/Berlin" })).json().data as CalRow;
    const res = await patchCal(auth, created.id, { timezone: "Garbage/Zone" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_timezone");
    expect((await listCals(auth))[0]!.timezone).toBe("Europe/Berlin");
  });

  it("空串回 400，不许用空串把时区抹掉", async () => {
    const { auth } = await seed();
    const created = (await createCal(auth, { name: "工作", timezone: "Europe/Berlin" })).json().data as CalRow;
    const res = await patchCal(auth, created.id, { timezone: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_timezone");
    expect((await listCals(auth))[0]!.timezone).toBe("Europe/Berlin");
  });

  it("不带 timezone 的 PATCH 不动时区", async () => {
    const { auth } = await seed();
    const created = (await createCal(auth, { name: "工作", timezone: "Europe/Berlin" })).json().data as CalRow;
    const res = await patchCal(auth, created.id, { name: "新名" });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as CalRow).timezone).toBe("Europe/Berlin");
  });

  it("存量脏值日历改别的字段不受关口影响，脏值原样保留待迁移", async () => {
    const { user, auth } = await seed();
    // 直接写库模拟校验上线前存进去的脏值。
    const [legacy] = await db
      .insert(schema.calendars)
      .values({ ownerId: user.id, name: "老日历", color: "#000000", timezone: "Mars/Olympus" })
      .returning();
    const res = await patchCal(auth, legacy!.id, { name: "改个名" });
    expect(res.statusCode).toBe(200);
    const row = (res.json().data as CalRow);
    expect(row.name).toBe("改个名");
    expect(row.timezone).toBe("Mars/Olympus");
  });
});
