// 日历新建 / 编辑的字段收存契约：四端（网页 + 桌面 + Android + iOS）
// 的新建/编辑对话框都只发 name / description / color / timezone 四个
// 字段，这里盯的是 API 这一层对每个字段的收存口径：
//   一、四字段建时全量落库、读回逐字一致（颜色大小写原样保留）；
//   二、只给 name 时其余字段走数据库默认（color #3b82f6、timezone
//       Asia/Shanghai），不许被 schema 吞成 null；
//   三、PATCH 逐字段改互不干扰；description 传 "" 必须真的清空
//       （客户端编辑器靠省略空值做不到清空，API 这一层不能再把 ""
//       也吞掉，否则全平台没有任何路径能清掉一段日历描述）；
//   四、非法 color / 空 name 回 400；改别人的日历回 404。
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
  ensureSchema, resetDb, makeUser, buildRoutedApp,
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

type CalRow = {
  id: string; name: string; description: string | null;
  color: string; timezone: string;
};

async function createCal(auth: Record<string, string>, body: unknown) {
  return app.inject({
    method: "POST", url: "/api/v1/calendars",
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

describe("POST /api/v1/calendars 字段收存", () => {
  it("四字段全量落库且读回逐字一致", async () => {
    const { auth } = await seed();
    const res = await createCal(auth, {
      name: "工作",
      description: "项目排期与会议",
      color: "#A855F7",
      timezone: "Australia/Melbourne",
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().data as CalRow;
    expect(created.name).toBe("工作");
    expect(created.description).toBe("项目排期与会议");
    expect(created.color).toBe("#A855F7");
    expect(created.timezone).toBe("Australia/Melbourne");

    const listed = await listCals(auth);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "工作",
      description: "项目排期与会议",
      color: "#A855F7",
      timezone: "Australia/Melbourne",
    });
  });

  it("只给 name 时 color / timezone 走数据库默认而不是 null", async () => {
    const { auth } = await seed();
    const res = await createCal(auth, { name: "极简" });
    expect(res.statusCode).toBe(201);
    const created = res.json().data as CalRow;
    expect(created.color).toBe("#3b82f6");
    expect(created.timezone).toBe("Asia/Shanghai");
    expect(created.description).toBeNull();
  });

  it("非法 color 与空 name 回 400", async () => {
    const { auth } = await seed();
    expect((await createCal(auth, { name: "x", color: "red" })).statusCode).toBe(400);
    expect((await createCal(auth, { name: "" })).statusCode).toBe(400);
    expect(await listCals(auth)).toHaveLength(0);
  });
});

describe("PATCH /api/v1/calendars/:id 字段收存", () => {
  it("逐字段修改互不干扰，description 传空串真的清空", async () => {
    const { auth } = await seed();
    const created = (await createCal(auth, {
      name: "原名", description: "有描述", color: "#3b82f6", timezone: "Asia/Shanghai",
    })).json().data as CalRow;

    const renamed = (await patchCal(auth, created.id, { name: "新名" })).json().data as CalRow;
    expect(renamed.name).toBe("新名");
    expect(renamed.description).toBe("有描述");
    expect(renamed.color).toBe("#3b82f6");
    expect(renamed.timezone).toBe("Asia/Shanghai");

    const recolored = (await patchCal(auth, created.id, { color: "#10b981" })).json().data as CalRow;
    expect(recolored.color).toBe("#10b981");
    expect(recolored.name).toBe("新名");

    const rezoned = (await patchCal(auth, created.id, { timezone: "Europe/Berlin" })).json().data as CalRow;
    expect(rezoned.timezone).toBe("Europe/Berlin");
    expect(rezoned.description).toBe("有描述");

    const cleared = (await patchCal(auth, created.id, { description: "" })).json().data as CalRow;
    expect(cleared.description).toBe("");
    const listed = await listCals(auth);
    expect(listed[0]!.description).toBe("");
  });

  it("PATCH 非法字段回 400（不是 500），非法 id 也回 400", async () => {
    const { auth } = await seed();
    const created = (await createCal(auth, { name: "合法" })).json().data as CalRow;
    // 路由曾经用 schema.parse()：ZodError 没有 statusCode，冒到全局
    // 错误处理器会变成 500，客户端看不出是自己发错了（events 路由
    // 早先修过同一课）。这里钉住 400 契约。
    expect((await patchCal(auth, created.id, { color: "blue" })).statusCode).toBe(400);
    expect((await patchCal(auth, created.id, { name: "" })).statusCode).toBe(400);
    expect((await patchCal(auth, "not-a-uuid", { name: "x" })).statusCode).toBe(400);
    const listed = await listCals(auth);
    expect(listed[0]!.name).toBe("合法");
    expect(listed[0]!.color).toBe("#3b82f6");
  });

  it("改别人的日历回 404 且原数据不动", async () => {
    const mine = await seed();
    const other = await seed("b@example.com");
    const created = (await createCal(mine.auth, { name: "我的" })).json().data as CalRow;
    const res = await patchCal(other.auth, created.id, { name: "篡改" });
    expect(res.statusCode).toBe(404);
    const listed = await listCals(mine.auth);
    expect(listed[0]!.name).toBe("我的");
  });
});
