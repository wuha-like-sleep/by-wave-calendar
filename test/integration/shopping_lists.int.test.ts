// 购买清单 JSON API（/api/v1/shopping-lists*）口径：
//   一、清单/条目 CRUD、勾选、排序都按 owner 隔离——别人的清单在每一
//       个动词上都是 404，不泄露存在性；
//   二、个人 API Token 可用：只读 Token 读得通、写被 session 层的既有
//       闸门以 403 token_is_read_only 拒掉；写 Token 可建可改；
//   三、事件关联：只能关联自己日历上未删除的事件；事件被物理删除后
//       清单保留、关联自动置空（外键 SET NULL），软删后展示层不再
//       给出事件名（死链不当活链摆）。
import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, makeUser, makeCalendar, makeEvent, buildRoutedApp, loginAs } from "./harness.js";
import { db, schema } from "../../src/db/client.js";

const { shoppingListRoutes } = await import("../../src/routes/shopping_lists.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { updateSettings, reloadSettings } = await import("../../src/lib/site_settings.js");

let app: FastifyInstance;

type Json = Record<string, unknown>;
const body = (res: { body: string }): Json => JSON.parse(res.body) as Json;
const data = (res: { body: string }): Json => (body(res).data ?? {}) as Json;

async function api(method: string, url: string, headers: Record<string, string>, payload?: unknown) {
  return app.inject({ method, url, headers, payload: payload as never });
}

beforeAll(async () => {
  await ensureSchema();
  app = await buildRoutedApp(shoppingListRoutes, { prefix: "/api/v1" });
});
afterAll(async () => { await app?.close(); });

beforeEach(async () => {
  await resetDb();
  await db.insert(schema.siteSettings)
    .values({ id: 1, registrationMode: "public", appsEnabled: true, captchaProvider: "none" })
    .onConflictDoNothing();
  await updateSettings({ apiEnabled: true } as never);
  reloadSettings();
});

describe("购买清单 API", () => {
  it("未登录 → 401", async () => {
    const res = await api("GET", "/api/v1/shopping-lists", {});
    expect(res.statusCode).toBe(401);
  });

  it("清单 CRUD 全流程", async () => {
    const u = await makeUser("a@example.com");
    const cookie = { cookie: await loginAs(app, u.id) };

    const created = await api("POST", "/api/v1/shopping-lists", cookie, { title: "周末烧烤" });
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201);
    const list = data(created);
    expect(list.title).toBe("周末烧烤");
    expect(list.totalCount).toBe(0);
    expect(list.eventId).toBeNull();
    const id = list.id as string;

    const lists = await api("GET", "/api/v1/shopping-lists", cookie);
    expect(lists.statusCode).toBe(200);
    expect((data(lists) as unknown as Json[]).map((l) => l.id)).toContain(id);

    const renamed = await api("PATCH", `/api/v1/shopping-lists/${id}`, cookie, { title: "烧烤采购" });
    expect(renamed.statusCode).toBe(200);
    expect(data(renamed).title).toBe("烧烤采购");

    const removed = await api("DELETE", `/api/v1/shopping-lists/${id}`, cookie);
    expect(removed.statusCode).toBe(200);
    const gone = await api("GET", `/api/v1/shopping-lists/${id}`, cookie);
    expect(gone.statusCode).toBe(404);
  });

  it("条目 CRUD、勾选与排序", async () => {
    const u = await makeUser("items@example.com");
    const cookie = { cookie: await loginAs(app, u.id) };
    const list = data(await api("POST", "/api/v1/shopping-lists", cookie, { title: "采购" }));
    const listId = list.id as string;

    const mk = async (payload: unknown) => {
      const res = await api("POST", `/api/v1/shopping-lists/${listId}/items`, cookie, payload);
      expect(res.statusCode, res.body.slice(0, 200)).toBe(201);
      return data(res);
    };
    const beef = await mk({ name: "牛肉", quantity: 2, unit: "斤" });
    const tomato = await mk({ name: "番茄", quantity: 0.5, unit: "斤", note: "要熟透的" });
    const beer = await mk({ name: "啤酒" });
    // 小数数量原样回来（numeric 列 → API 转 number）。
    expect(tomato.quantity).toBe(0.5);
    expect(tomato.note).toBe("要熟透的");
    expect(beer.quantity).toBeNull();

    // 勾选 + 改名。
    const toggled = await api("PATCH", `/api/v1/shopping-lists/${listId}/items/${beef.id}`, cookie, { done: true });
    expect(data(toggled).done).toBe(true);
    const edited = await api("PATCH", `/api/v1/shopping-lists/${listId}/items/${beer.id}`, cookie, { name: "精酿啤酒", quantity: 6, unit: "瓶" });
    expect(data(edited).name).toBe("精酿啤酒");
    expect(data(edited).quantity).toBe(6);

    // 排序：把啤酒上移一位 → 顺序变成 牛肉、啤酒、番茄。
    const moved = await api("POST", `/api/v1/shopping-lists/${listId}/items/${beer.id}/move`, cookie, { direction: "up" });
    expect(moved.statusCode).toBe(200);
    const detail = data(await api("GET", `/api/v1/shopping-lists/${listId}`, cookie));
    const items = detail.items as Json[];
    expect(items.map((i) => i.name)).toEqual(["牛肉", "精酿啤酒", "番茄"]);
    expect((detail.list as Json).doneCount).toBe(1);
    expect((detail.list as Json).totalCount).toBe(3);

    // 端点上再上移 = 无操作，仍是 200。
    const noop = await api("POST", `/api/v1/shopping-lists/${listId}/items/${beef.id}/move`, cookie, { direction: "up" });
    expect(noop.statusCode).toBe(200);

    // 删除条目。
    const del = await api("DELETE", `/api/v1/shopping-lists/${listId}/items/${tomato.id}`, cookie);
    expect(del.statusCode).toBe(200);
    const after = data(await api("GET", `/api/v1/shopping-lists/${listId}`, cookie));
    expect((after.items as Json[]).map((i) => i.name)).toEqual(["牛肉", "精酿啤酒"]);
  });

  it("owner 隔离：别人的清单处处 404", async () => {
    const a = await makeUser("owner-a@example.com");
    const b = await makeUser("owner-b@example.com");
    const cookieA = { cookie: await loginAs(app, a.id) };
    const cookieB = { cookie: await loginAs(app, b.id) };
    const list = data(await api("POST", "/api/v1/shopping-lists", cookieA, { title: "A 的清单" }));
    const listId = list.id as string;
    const item = data(await api("POST", `/api/v1/shopping-lists/${listId}/items`, cookieA, { name: "牛奶" }));

    expect((await api("GET", `/api/v1/shopping-lists/${listId}`, cookieB)).statusCode).toBe(404);
    expect((await api("PATCH", `/api/v1/shopping-lists/${listId}`, cookieB, { title: "改名" })).statusCode).toBe(404);
    expect((await api("DELETE", `/api/v1/shopping-lists/${listId}`, cookieB)).statusCode).toBe(404);
    expect((await api("POST", `/api/v1/shopping-lists/${listId}/items`, cookieB, { name: "x" })).statusCode).toBe(404);
    expect((await api("PATCH", `/api/v1/shopping-lists/${listId}/items/${item.id}`, cookieB, { done: true })).statusCode).toBe(404);
    expect((await api("DELETE", `/api/v1/shopping-lists/${listId}/items/${item.id}`, cookieB)).statusCode).toBe(404);
    expect((await api("POST", `/api/v1/shopping-lists/${listId}/items/${item.id}/move`, cookieB, { direction: "down" })).statusCode).toBe(404);

    const bLists = data(await api("GET", "/api/v1/shopping-lists", cookieB)) as unknown as Json[];
    expect(bLists).toEqual([]);
    // A 的清单毫发无损。
    const detail = data(await api("GET", `/api/v1/shopping-lists/${listId}`, cookieA));
    expect((detail.items as Json[]).length).toBe(1);
  });

  it("个人 Token：只读能读不能写，写 Token 可建", async () => {
    const u = await makeUser("token@example.com");
    const cookie = { cookie: await loginAs(app, u.id) };
    const list = data(await api("POST", "/api/v1/shopping-lists", cookie, { title: "Token 清单" }));
    const listId = list.id as string;

    const read = await createApiToken({ userId: u.id, label: "ro", scope: "read" });
    const ro = { authorization: `Bearer ${read.plain}` };
    expect((await api("GET", "/api/v1/shopping-lists", ro)).statusCode).toBe(200);
    expect((await api("GET", `/api/v1/shopping-lists/${listId}`, ro)).statusCode).toBe(200);
    const denied = await api("POST", "/api/v1/shopping-lists", ro, { title: "不许建" });
    expect(denied.statusCode).toBe(403);
    // session 层在 handler 之前直接回的，形状是全站统一的 { error: code }
    //（不走路由的信封助手）——与事件等其它接口撞上这道闸时一模一样。
    expect(body(denied).error).toBe("token_is_read_only");
    expect((await api("PATCH", `/api/v1/shopping-lists/${listId}`, ro, { title: "x" })).statusCode).toBe(403);
    expect((await api("DELETE", `/api/v1/shopping-lists/${listId}`, ro)).statusCode).toBe(403);
    expect((await api("POST", `/api/v1/shopping-lists/${listId}/items`, ro, { name: "x" })).statusCode).toBe(403);

    const write = await createApiToken({ userId: u.id, label: "rw", scope: "write" });
    const rw = { authorization: `Bearer ${write.plain}` };
    const made = await api("POST", "/api/v1/shopping-lists", rw, { title: "写 Token 建的" });
    expect(made.statusCode).toBe(201);
  });

  it("事件关联：关联、筛选、解除、删事件后清单保留", async () => {
    const u = await makeUser("link@example.com");
    const other = await makeUser("link-other@example.com");
    const cookie = { cookie: await loginAs(app, u.id) };
    const cal = await makeCalendar(u.id);
    const ev = await makeEvent(cal.id, "ev-1");
    const otherCal = await makeCalendar(other.id);
    const otherEv = await makeEvent(otherCal.id, "ev-2");

    // 建清单时直接关联。
    const created = await api("POST", "/api/v1/shopping-lists", cookie, { title: "活动采购", eventId: ev.id });
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201);
    const listId = data(created).id as string;
    expect(data(created).eventSummary).toBe("E");

    // ?eventId= 筛选只回关联到该事件的。
    const filtered = data(await api("GET", `/api/v1/shopping-lists?eventId=${ev.id}`, cookie)) as unknown as Json[];
    expect(filtered.map((l) => l.id)).toEqual([listId]);
    const unfiltered = data(await api("GET", `/api/v1/shopping-lists?eventId=${otherEv.id}`, cookie)) as unknown as Json[];
    expect(unfiltered).toEqual([]);

    // 关联别人的事件 → 400 event_not_found（不泄露对方事件存在）。
    const badLink = await api("PATCH", `/api/v1/shopping-lists/${listId}`, cookie, { eventId: otherEv.id });
    expect(badLink.statusCode).toBe(400);
    expect((body(badLink).error as Json).code).toBe("event_not_found");
    const badCreate = await api("POST", "/api/v1/shopping-lists", cookie, { title: "x", eventId: otherEv.id });
    expect(badCreate.statusCode).toBe(400);

    // 解除关联。
    const unlinked = await api("PATCH", `/api/v1/shopping-lists/${listId}`, cookie, { eventId: null });
    expect(unlinked.statusCode).toBe(200);
    expect(data(unlinked).eventId).toBeNull();

    // 重新关联，然后软删事件：eventSummary 变 null（不当活链展示），
    // event_id 还在；物理删除后 event_id 被外键置空，清单保留。
    await api("PATCH", `/api/v1/shopping-lists/${listId}`, cookie, { eventId: ev.id });
    await db.update(schema.events).set({ deletedAt: new Date() }).where(eq(schema.events.id, ev.id));
    const softDeleted = data(await api("GET", `/api/v1/shopping-lists/${listId}`, cookie));
    expect((softDeleted.list as Json).eventSummary).toBeNull();
    await db.delete(schema.events).where(eq(schema.events.id, ev.id));
    const afterPurge = data(await api("GET", `/api/v1/shopping-lists/${listId}`, cookie));
    expect((afterPurge.list as Json).eventId).toBeNull();
    expect((afterPurge.list as Json).title).toBe("活动采购");
  });

  it("输入校验：空标题、非法数量一律 400", async () => {
    const u = await makeUser("valid@example.com");
    const cookie = { cookie: await loginAs(app, u.id) };
    expect((await api("POST", "/api/v1/shopping-lists", cookie, { title: "  " })).statusCode).toBe(400);
    expect((await api("POST", "/api/v1/shopping-lists", cookie, { title: "x".repeat(121) })).statusCode).toBe(400);
    const list = data(await api("POST", "/api/v1/shopping-lists", cookie, { title: "校验" }));
    const listId = list.id as string;
    expect((await api("POST", `/api/v1/shopping-lists/${listId}/items`, cookie, { name: "" })).statusCode).toBe(400);
    expect((await api("POST", `/api/v1/shopping-lists/${listId}/items`, cookie, { name: "x", quantity: 0 })).statusCode).toBe(400);
    expect((await api("POST", `/api/v1/shopping-lists/${listId}/items`, cookie, { name: "x", quantity: -2 })).statusCode).toBe(400);
    expect((await api("POST", `/api/v1/shopping-lists/${listId}/items`, cookie, { name: "x", quantity: "abc" })).statusCode).toBe(400);
  });
});
