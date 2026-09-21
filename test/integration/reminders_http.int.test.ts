// events.extra 的浅合并（C1）+ trigger 校验（C6）+ 去重截断（C7）——**全部从 HTTP 打进去**。
//
// 为什么非得这么写：这个仓库上一次栽的跟头是「封禁功能 30 条单元测试全绿，后台的真实
// 路径是坏的」。直调 mergeEventExtra 的测试结构上看不见三件事：
//   ① PATCH 这条路上 extra 到底有没有被送进合并（`body.extra !== undefined ? ... : undefined`
//      这一行写反了，直调合并函数的测试照样全绿）；
//   ② scope=instance / scope=future 是**另外两段**各自独立的 insert，各写一遍 extra；
//   ③ trigger 校验挂在 zod schema 上，而「ZodError 冒到 setErrorHandler 会变成 500」
//      这件事只有真的发一个请求才看得见。
// 所以这里一律：真 Fastify + 真路由 + 真会话 cookie + 真 PGlite，断言读的是 GET 回来的响应体。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

// Point the production `db`/`schema` at the in-memory PGlite instance.
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp, loginAs,
} from "./harness.js";

// routes/events.ts 一路拉到 lib/mailer → env.ts，而 env 解析不过是 process.exit(1)：
// 整个 vitest 进程当场消失，连一条红都留不下。CI 上没有 .env，所以先兜底再动态
// import。dotenv 不覆盖已存在的 env，本地有 .env 也不受影响。
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;
let cookie: string;
let user: Awaited<ReturnType<typeof makeUser>>;
let cal: Awaited<ReturnType<typeof makeCalendar>>;

beforeEach(async () => {
  await resetDb();
  // 前缀和生产一致（server.ts:853 的 ["/api", "/api/v1"]）。
  app = await buildRoutedApp(eventRoutes, { prefix: "/api" });
  user = await makeUser("phone@example.com");
  cal = await makeCalendar(user.id);
  cookie = await loginAs(app, user.id);
});

afterEach(async () => { await app.close(); });

type Json = Record<string, unknown>;

function send(method: "POST" | "PATCH" | "GET", url: string, payload?: Json, withCookie = true) {
  return app.inject({
    method,
    url,
    headers: withCookie ? { cookie } : {},
    ...(payload === undefined ? {} : { payload }),
  });
}

const BASE_EVENT = {
  summary: "周会",
  startsAt: "2026-07-14T01:00:00.000Z",
  endsAt: "2026-07-14T02:00:00.000Z",
};

async function createEvent(extra: Json | null, overrides: Json = {}) {
  return send("POST", "/api/events", { calendarId: cal.id, ...BASE_EVENT, extra, ...overrides });
}

/** 从 HTTP 把事件读回来（GET /api/calendars/:id/events?eventId=…，网页详情用的就是它）。 */
async function fetchEvent(id: string): Promise<Json | undefined> {
  const res = await send("GET", `/api/calendars/${cal.id}/events?eventId=${id}`);
  expect(res.statusCode).toBe(200);
  return (res.json() as Json[])[0];
}

/** 这个日历下现在有几个活着的事件 —— 用来断言「400 的那次没有半条数据落库」。 */
async function liveEventCount(): Promise<number> {
  const res = await send("GET", `/api/calendars/${cal.id}/events`);
  expect(res.statusCode).toBe(200);
  return (res.json() as Json[]).length;
}

const extraOf = (row: Json | undefined) => (row?.extra ?? null) as Record<string, unknown> | null;

// ---------------------------------------------------------------------------

describe("会话鉴权本身（先证明「已登录」不是假的）", () => {
  it("不带 cookie 的 POST 是 401，且没有事件落库", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/events",
      payload: { calendarId: cal.id, ...BASE_EVENT },
    });
    expect(res.statusCode).toBe(401);
    // 数一遍要带上自己的 cookie，否则 GET 也是 401、断言就成了空对空。
    expect(await liveEventCount()).toBe(0);
  });

  it("别人的事件 PATCH 不动（loadOwnedEvent 真的在拦）", async () => {
    const created = await createEvent({ category: "工作" });
    const id = (created.json() as Json).id as string;

    const other = await makeUser("someone-else@example.com");
    const otherCookie = await loginAs(app, other.id);
    const res = await app.inject({
      method: "PATCH", url: `/api/events/${id}`,
      headers: { cookie: otherCookie },
      payload: { summary: "被别人改了" },
    });
    expect(res.statusCode).toBe(404);
    expect(extraOf(await fetchEvent(id))?.category).toBe("工作");
  });
});

describe("C1 · 手机端那条（本轮核心）", () => {
  it("手机发一个只含 timezone 的 PATCH，提醒/分类/参与者全都还在", async () => {
    // 网页建的事件：提醒 + 分类 + 参与者 + 时区。
    const created = await createEvent({
      alarms: [{ trigger: "-PT15M" }, { trigger: "-P1D" }],
      category: "工作",
      attendees: ["a@example.com"],
      timezone: "Asia/Shanghai",
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as Json).id as string;

    // iOS / 安卓的事件模型里根本没有 alarms / category / attendees 这几个字段，
    // 它 PATCH 上来的 extra 就长这样 —— 一份「完整的」、但少了三个键的 extra。
    const patched = await send("PATCH", `/api/events/${id}`, {
      summary: "周会（改期）",
      extra: { timezone: "Asia/Tokyo" },
    });
    expect(patched.statusCode).toBe(200);

    const row = await fetchEvent(id);
    expect(row?.summary).toBe("周会（改期）");
    const extra = extraOf(row);
    expect(extra?.alarms).toEqual([{ trigger: "-PT15M" }, { trigger: "-P1D" }]);
    expect(extra?.category).toBe("工作");
    expect(extra?.attendees).toEqual(["a@example.com"]);
    expect(extra?.timezone).toBe("Asia/Tokyo");   // 传了的那个键照常覆盖
  });

  it("PATCH 里完全没提 extra → 整块原样不动", async () => {
    const created = await createEvent({ alarms: [{ trigger: "-PT30M" }], category: "工作" });
    const id = (created.json() as Json).id as string;

    const res = await send("PATCH", `/api/events/${id}`, { summary: "只改标题" });
    expect(res.statusCode).toBe(200);

    expect(extraOf(await fetchEvent(id))).toEqual({
      alarms: [{ trigger: "-PT30M" }], category: "工作",
    });
  });

  it("extra 显式传 null → 整块清空（这是唯一的整块清空手段）", async () => {
    const created = await createEvent({ alarms: [{ trigger: "-PT30M" }], category: "工作" });
    const id = (created.json() as Json).id as string;

    const res = await send("PATCH", `/api/events/${id}`, { extra: null });
    expect(res.statusCode).toBe(200);
    expect(extraOf(await fetchEvent(id))).toBeNull();
  });

  it("CalDAV 带进来的私有键，网页 PATCH 一次也不会被抹掉", async () => {
    const created = await createEvent({ category: "工作" });
    const id = (created.json() as Json).id as string;
    // 模拟 CalDAV PUT 往 extra 里塞的键（zod 的 strip 认不得它，以前整块替换会抹掉）。
    await db.update(schema.events)
      .set({ extra: { category: "工作", transp: "TRANSPARENT", source: "sub:s1" } })
      .where(eq(schema.events.id, id));

    const res = await send("PATCH", `/api/events/${id}`, { extra: { category: "生活" } });
    expect(res.statusCode).toBe(200);

    const extra = extraOf(await fetchEvent(id));
    expect(extra?.category).toBe("生活");
    expect(extra?.transp).toBe("TRANSPARENT");
    expect(extra?.source).toBe("sub:s1");
  });
});

describe("C1 · 六个键逐个清空（只测 alarms 一个等于没测）", () => {
  const FULL: Record<string, unknown> = {
    category: "工作",
    timezone: "Asia/Shanghai",
    url: "https://meet.example.com/abc",
    meetingPassword: "8888",
    attendees: ["a@example.com"],
    alarms: [{ trigger: "-PT15M" }],
  };

  it.each(Object.keys(FULL))("PATCH { extra: { %s: null } } → 这个键没了，其余五个一个不少", async (key) => {
    const created = await createEvent({ ...FULL });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as Json).id as string;
    // 先确认六个键都真的落库了 —— 否则「删掉之后不在」是空对空地绿。
    expect(Object.keys(extraOf(await fetchEvent(id)) ?? {}).sort()).toEqual(Object.keys(FULL).sort());

    const res = await send("PATCH", `/api/events/${id}`, { extra: { [key]: null } });
    expect(res.statusCode).toBe(200);

    const extra = extraOf(await fetchEvent(id)) ?? {};
    expect(Object.prototype.hasOwnProperty.call(extra, key)).toBe(false);
    for (const other of Object.keys(FULL)) {
      if (other === key) continue;
      expect(extra[other]).toEqual(FULL[other]);
    }
  });

  it("最后一个键被删掉时整列落 null，不留一个空对象", async () => {
    const created = await createEvent({ category: "工作" });
    const id = (created.json() as Json).id as string;

    await send("PATCH", `/api/events/${id}`, { extra: { category: null } });
    // `{}` 和 null 必须是同一种表示，客户端不用同时判两种空。
    expect(extraOf(await fetchEvent(id))).toBeNull();
  });

  it("POST 时写成 null 的键不落库 —— 新建和改过之后的 extra 形状要一致", async () => {
    // 新建走的是 mergeEventExtra(null, body.extra)，不是把 body.extra 原样塞进列里。
    // 不这么做的话，读取侧要同时会判「新建的（键在、值是 null）」和「改过的（键不在）」两种空。
    const res = await createEvent({ category: "工作", timezone: null, attendees: null });
    expect(res.statusCode).toBe(201);
    const extra = extraOf(await fetchEvent((res.json() as Json).id as string)) ?? {};
    expect(Object.keys(extra)).toEqual(["category"]);
  });

  it("POST extra: {} → 整列落 null", async () => {
    const res = await createEvent({});
    expect(res.statusCode).toBe(201);
    expect(extraOf(await fetchEvent((res.json() as Json).id as string))).toBeNull();
  });

  it("attendees 传 [] 是「保留键、清到零个」，和传 null 不是一回事", async () => {
    const created = await createEvent({ attendees: ["a@example.com"], category: "工作" });
    const id = (created.json() as Json).id as string;

    await send("PATCH", `/api/events/${id}`, { extra: { attendees: [] } });
    const extra = extraOf(await fetchEvent(id)) ?? {};
    expect(Object.prototype.hasOwnProperty.call(extra, "attendees")).toBe(true);
    expect(extra.attendees).toEqual([]);
  });
});

describe("C6 · 我们自己的 JSON API：trigger 解析不了就整个请求 400", () => {
  it("POST 一条 banana → 400，而且库里一个事件都没建出来", async () => {
    const res = await createEvent({ alarms: [{ trigger: "banana" }] });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Json;
    expect(body.error).toBe("invalid_body");
    // 路径 + 原值都要在里面，否则客户端只知道「有问题」不知道哪儿有问题。
    expect(String(body.message)).toContain("alarms");
    expect(String(body.message)).toContain("banana");
    expect(await liveEventCount()).toBe(0);
  });

  it("好的和坏的混在一起也是 400 —— 自家客户端不做「丢一条留其余」", async () => {
    const res = await createEvent({ alarms: [{ trigger: "-PT15M" }, { trigger: "banana" }] });
    expect(res.statusCode).toBe(400);
    expect(await liveEventCount()).toBe(0);
  });

  it("PATCH 一条 banana → 400，且库里那份 extra 一个字节没动", async () => {
    const created = await createEvent({ alarms: [{ trigger: "-PT15M" }], category: "工作" });
    const id = (created.json() as Json).id as string;

    const res = await send("PATCH", `/api/events/${id}`, {
      summary: "顺手也改了标题",
      extra: { alarms: [{ trigger: "banana" }] },
    });
    expect(res.statusCode).toBe(400);

    const row = await fetchEvent(id);
    expect(row?.summary).toBe("周会");   // 整个请求被拒，标题也不许落
    expect(extraOf(row)).toEqual({ alarms: [{ trigger: "-PT15M" }], category: "工作" });
  });

  it("空串是「不提醒」那一档的哨兵值，不能吃 400", async () => {
    const res = await createEvent({ alarms: [{ trigger: "" }], category: "工作" });
    expect(res.statusCode).toBe(201);
    const extra = extraOf(await fetchEvent((res.json() as Json).id as string));
    // 放行、但不落成一条永远不会响的提醒。
    expect(extra?.alarms).toEqual([]);
    expect(extra?.category).toBe("工作");
  });

  it("其它字段写坏了同样是 400，不是 500", async () => {
    // ZodError 身上没有 statusCode，用 schema.parse() 会一路冒成 500「服务器内部错误」。
    const res = await createEvent(null, { summary: "" });
    expect(res.statusCode).toBe(400);
  });
});

describe("C7 · 去重与 8 条上限", () => {
  it("9 条里有 2 条是重复的 → 落库 7 条，顺序按先来后到", async () => {
    const res = await createEvent({
      alarms: [
        { trigger: "-PT5M" },
        { trigger: "-PT15M" },
        { trigger: "-PT5M" },    // 字面重复
        { trigger: "-PT30M" },
        { trigger: "-PT1H" },
        { trigger: "-PT60M" },   // 语义重复（= -PT1H），幂等键会撞
        { trigger: "-PT2H" },
        { trigger: "-P1D" },
        { trigger: "-P1W" },
      ],
    });
    expect(res.statusCode).toBe(201);
    const extra = extraOf(await fetchEvent((res.json() as Json).id as string));
    expect((extra?.alarms as Array<{ trigger: string }>).map((a) => a.trigger))
      .toEqual(["-PT5M", "-PT15M", "-PT30M", "-PT1H", "-PT2H", "-P1D", "-P1W"]);
  });

  it("12 条互不相同 → 截到 8 条，不报错", async () => {
    const triggers = ["-PT0M", "-PT5M", "-PT10M", "-PT15M", "-PT20M", "-PT25M",
                      "-PT30M", "-PT45M", "-PT1H", "-PT2H", "-P1D", "-P1W"];
    const res = await createEvent({ alarms: triggers.map((trigger) => ({ trigger })) });
    expect(res.statusCode).toBe(201);
    const extra = extraOf(await fetchEvent((res.json() as Json).id as string));
    expect((extra?.alarms as Array<{ trigger: string }>).map((a) => a.trigger))
      .toEqual(triggers.slice(0, 8));
  });

  it("PATCH 上来的一组同样去重截断", async () => {
    const created = await createEvent({ alarms: [{ trigger: "-PT15M" }] });
    const id = (created.json() as Json).id as string;
    await send("PATCH", `/api/events/${id}`, {
      extra: { alarms: [{ trigger: "-PT1H" }, { trigger: "-PT60M" }, { trigger: "-P1D" }] },
    });
    const extra = extraOf(await fetchEvent(id));
    expect((extra?.alarms as Array<{ trigger: string }>).map((a) => a.trigger))
      .toEqual(["-PT1H", "-P1D"]);
  });

  it("全天档位（PT9H 这类正数触发）原样存进去，符号没被吃掉", async () => {
    const res = await createEvent(
      { alarms: [{ trigger: "PT9H" }, { trigger: "-P6DT15H" }] },
      { allDay: true },
    );
    expect(res.statusCode).toBe(201);
    const extra = extraOf(await fetchEvent((res.json() as Json).id as string));
    // 幂等键是 (event_id, trigger, instance_start)，trigger 原文改一个字符
    // 已发过的提醒就对不上旧行、会重发一遍。
    expect((extra?.alarms as Array<{ trigger: string }>).map((a) => a.trigger))
      .toEqual(["PT9H", "-P6DT15H"]);
  });
});

describe("C1 · 重复事件拆分的两条分支（各自独立的一段代码）", () => {
  const RECUR = {
    summary: "每周例会",
    startsAt: "2026-07-06T01:00:00.000Z",
    endsAt: "2026-07-06T02:00:00.000Z",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
  };
  const RECUR_EXTRA = { alarms: [{ trigger: "-PT30M" }], category: "工作", timezone: "Asia/Shanghai" };

  async function createSeries() {
    const res = await app.inject({
      method: "POST", url: "/api/events", headers: { cookie },
      payload: { calendarId: cal.id, ...RECUR, extra: { ...RECUR_EXTRA } },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as Json).id as string;
  }

  it("scope=instance 拆出来的那一行也保住了提醒", async () => {
    const masterId = await createSeries();
    const res = await send("PATCH", `/api/events/${masterId}`, {
      scope: "instance",
      recurrenceId: "2026-07-13T01:00:00.000Z",
      summary: "这次换个房间",
      extra: { timezone: "Asia/Tokyo" },   // 手机只会发这一个键
    });
    expect(res.statusCode).toBe(200);
    const detachedId = (res.json() as Json).id as string;
    expect(detachedId).not.toBe(masterId);

    const extra = extraOf(await fetchEvent(detachedId));
    expect(extra?.alarms).toEqual([{ trigger: "-PT30M" }]);
    expect(extra?.category).toBe("工作");
    expect(extra?.timezone).toBe("Asia/Tokyo");
    // master 那份不受影响。
    expect(extraOf(await fetchEvent(masterId))).toEqual(RECUR_EXTRA);
  });

  it("scope=future 新拆出来的 master 也保住了提醒", async () => {
    const masterId = await createSeries();
    const res = await send("PATCH", `/api/events/${masterId}`, {
      scope: "future",
      recurrenceId: "2026-07-13T01:00:00.000Z",
      summary: "以后都换个房间",
      extra: { timezone: "Asia/Tokyo" },
    });
    expect(res.statusCode).toBe(200);
    const newMasterId = (res.json() as Json).id as string;
    expect(newMasterId).not.toBe(masterId);

    const extra = extraOf(await fetchEvent(newMasterId));
    expect(extra?.alarms).toEqual([{ trigger: "-PT30M" }]);
    expect(extra?.category).toBe("工作");
    expect(extra?.timezone).toBe("Asia/Tokyo");
    expect(extraOf(await fetchEvent(masterId))).toEqual(RECUR_EXTRA);
  });

  it("scope=instance 的显式 null 一样能删键", async () => {
    const masterId = await createSeries();
    const res = await send("PATCH", `/api/events/${masterId}`, {
      scope: "instance",
      recurrenceId: "2026-07-13T01:00:00.000Z",
      extra: { category: null },
    });
    const extra = extraOf(await fetchEvent((res.json() as Json).id as string)) ?? {};
    expect(Object.prototype.hasOwnProperty.call(extra, "category")).toBe(false);
    expect(extra.alarms).toEqual([{ trigger: "-PT30M" }]);
  });
});
