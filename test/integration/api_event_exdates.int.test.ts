// PATCH /events/:id 的 exdates 整表替换：三端编辑器「恢复某次已删除的
// 单次」依赖它。在这之前 updateSchema 里没有 exdates 字段，zod strip
// 静默丢弃 —— 客户端发了、界面刷新了、服务端没存。这里盯：
//   一、传数组整表替换（删一条 = 那一次恢复出现，其余仍排除）；
//   二、空数组 / null 清空全部例外；
//   三、不传 exdates 时这一列纹丝不动（普通改标题不许顺手清掉例外）；
//   四、收口：乱序、重复、带偏移的写法落库都是 canonical ISO 去重排序；
//   五、非法条目（不是日期）整个请求 400，不许存半份。
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
  makeUser, makeCalendar, buildRoutedApp,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  reloadSettings();
  await getSettings();
  await updateSettings({ apiEnabled: true });
  app = await buildRoutedApp(async (a) => { await eventRoutes(a); }, { prefix: "/api/v1" });
});
afterEach(async () => { await app.close(); });

const EX1 = "2026-11-09T01:00:00.000Z";
const EX2 = "2026-11-16T01:00:00.000Z";

async function seedSeries() {
  const user = await makeUser("a@example.com");
  const cal = await makeCalendar(user.id);
  const issued = await createApiToken({ userId: user.id, label: "App", scope: "write" });
  const auth = { authorization: `Bearer ${issued.plain}` };
  const [ev] = await db.insert(schema.events).values({
    calendarId: cal.id,
    uid: "series@x",
    summary: "周会",
    startsAt: new Date("2026-11-02T01:00:00.000Z"),
    endsAt: new Date("2026-11-02T02:00:00.000Z"),
    rrule: "FREQ=WEEKLY",
    exdates: [EX1, EX2],
  }).returning();
  return { user, cal, auth, ev: ev! };
}

async function storedExdates(id: string): Promise<unknown> {
  const [row] = await db.select({ exdates: schema.events.exdates })
    .from(schema.events).where(eq(schema.events.id, id));
  return row?.exdates ?? null;
}

async function patch(id: string, auth: Record<string, string>, body: unknown) {
  return app.inject({
    method: "PATCH", url: `/api/v1/events/${id}`,
    headers: { "content-type": "application/json", ...auth },
    payload: JSON.stringify(body),
  });
}

describe("PATCH /events/:id 的 exdates", () => {
  it("整表替换：删掉一条例外 = 那一次恢复，其余仍排除", async () => {
    const { ev, auth } = await seedSeries();
    const res = await patch(ev.id, auth, { exdates: [EX2] });
    expect(res.statusCode).toBe(200);
    expect(await storedExdates(ev.id)).toEqual([EX2]);
  });

  it("空数组与 null 都清空全部例外", async () => {
    const { ev, auth } = await seedSeries();
    const res1 = await patch(ev.id, auth, { exdates: [] });
    expect(res1.statusCode).toBe(200);
    expect(await storedExdates(ev.id)).toEqual([]);

    await db.update(schema.events).set({ exdates: [EX1] }).where(eq(schema.events.id, ev.id));
    const res2 = await patch(ev.id, auth, { exdates: null });
    expect(res2.statusCode).toBe(200);
    expect(await storedExdates(ev.id)).toBeNull();
  });

  it("不传 exdates：改标题不许动这一列", async () => {
    const { ev, auth } = await seedSeries();
    const res = await patch(ev.id, auth, { summary: "改名了" });
    expect(res.statusCode).toBe(200);
    expect(await storedExdates(ev.id)).toEqual([EX1, EX2]);
  });

  it("收口：乱序 + 重复 + 带时区偏移的写法 → canonical ISO 去重排序", async () => {
    const { ev, auth } = await seedSeries();
    const res = await patch(ev.id, auth, {
      exdates: ["2026-11-16T12:00:00+11:00", EX1, EX1],
    });
    expect(res.statusCode).toBe(200);
    expect(await storedExdates(ev.id)).toEqual([EX1, EX2]);
  });

  it("非法条目整个请求 400，库里那份不动", async () => {
    const { ev, auth } = await seedSeries();
    const res = await patch(ev.id, auth, { exdates: [EX1, "not-a-date"] });
    expect(res.statusCode).toBe(400);
    expect(await storedExdates(ev.id)).toEqual([EX1, EX2]);
  });

  it("建事件不收 exdates（新事件没有例外，传了也忽略不报错）", async () => {
    const { cal, auth } = await seedSeries();
    const res = await app.inject({
      method: "POST", url: "/api/v1/events",
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({
        calendarId: cal.id, summary: "新事件",
        startsAt: "2026-11-03T01:00:00.000Z", endsAt: "2026-11-03T02:00:00.000Z",
        exdates: [EX1],
      }),
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().data ?? res.json();
    expect(await storedExdates(created.id)).toBeNull();
  });
});
