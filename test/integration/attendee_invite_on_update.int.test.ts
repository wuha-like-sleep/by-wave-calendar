// 「把人加进一个已经存在的事件」到底有没有把邀请发出去。
//
// ── 这条的形状 ────────────────────────────────────────────────────────
//
// 建事件那条路（POST）会给 extra.attendees 里的每个人发一封带 .ics 的邀请，
// 而改事件那条路（PATCH）只把名字合并进 extra 就完事了 —— 不建 token、不发信。
//
// 于是在桌面端给一个**已有**的会加人：名字进了列表、存得下、同步得过去、
// 一个错都不报，而被加的那个人**永远收不到任何东西**。组织者以为已经发了。
//
// 手机端碰不到这个洞：安卓和 iOS 的参与者是单独一页，走 POST /events/:id/attendees
// 那条专门的邀请接口。只有桌面端把参与者做在了编辑表单里，跟着 PATCH 一起走。
//
// 判据必须**同时钉住两条路**：只测 PATCH 的话，万一哪天 POST 也坏了（谁都收不到），
// 这个文件照样全绿。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

// 把发信拦下来记账。**不能断言「有没有抛错」** —— 发信是 fire-and-forget 的，
// 发不出去也只是一条日志，从响应上完全看不出来。
const sent: { to: string; subject: string }[] = [];
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async (args: { to: string; subject: string }) => {
    sent.push({ to: args.to, subject: args.subject });
    return { ok: true };
  }),
  isMailerEnabled: vi.fn(async () => true),
}));

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp, loginAs,
} from "./harness.js";

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
  sent.length = 0;
  app = await buildRoutedApp(eventRoutes, { prefix: "/api" });
  user = await makeUser("owner@example.com");
  cal = await makeCalendar(user.id);
  cookie = await loginAs(app, user.id);
});
afterEach(async () => { await app.close(); });

function send(method: "POST" | "PATCH", url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
}

async function makeEvent(extra?: unknown) {
  const res = await send("POST", "/api/events", {
    calendarId: cal.id, summary: "季度复盘",
    startsAt: "2026-07-14T01:00:00.000Z", endsAt: "2026-07-14T02:00:00.000Z",
    ...(extra === undefined ? {} : { extra }),
  });
  expect([200, 201], `建事件就失败了: ${res.body.slice(0, 300)}`).toContain(res.statusCode);
  return JSON.parse(res.body) as { id: string };
}

/** 收件人里有没有这个人。fire-and-forget 发信不会影响响应码，只能这么看。 */
const invited = (email: string) => sent.some((m) => m.to === email);

describe("给事件加参与者 → 对方要真的收到邀请", () => {
  it("建事件时带上参与者 → 发出去了（presence）", async () => {
    // 没有这条，下面那条红了也分不清是「PATCH 不发」还是「整个发信就没通」。
    await makeEvent({ attendees: ["a@example.com"] });
    expect(invited("a@example.com"), "连建事件这条路都没发出邀请 —— 下面的断言无从谈起").toBe(true);
  });

  it("**给已有的事件加人 → 也要发出去**（这条是这个文件的核心）", async () => {
    const ev = await makeEvent();
    expect(sent.length, "建的时候没人，不该有信").toBe(0);

    const res = await send("PATCH", `/api/events/${ev.id}`, { extra: { attendees: ["b@example.com"] } });
    expect([200, 204], `改事件失败: ${res.body.slice(0, 300)}`).toContain(res.statusCode);

    // 名字确实存下来了 —— 所以组织者在界面上看得见他，以为已经邀请过了。
    const [row] = await db.select().from(schema.events).where(eq(schema.events.id, ev.id));
    expect((row!.extra as { attendees?: unknown }).attendees, "名字连存都没存下").toBeTruthy();

    expect(
      invited("b@example.com"),
      "名字进了参与者列表、存得下、一个错都不报，而对方永远收不到任何邀请 —— " +
        "组织者以为已经发了。桌面端给已有的会加人走的就是这条路。",
    ).toBe(true);
  });

  it("加人时不重复打扰原有的参与者", async () => {
    const ev = await makeEvent({ attendees: ["a@example.com"] });
    sent.length = 0;
    await send("PATCH", `/api/events/${ev.id}`, {
      extra: { attendees: ["a@example.com", "b@example.com"] },
    });
    expect(invited("b@example.com"), "新加的人没收到").toBe(true);
    expect(
      invited("a@example.com"),
      "原来就在列表里的人又被发了一封 —— 每改一次事件，所有人的邮箱就响一次",
    ).toBe(false);
  });

  it("改的是别的字段时，谁也不该收到信", async () => {
    const ev = await makeEvent({ attendees: ["a@example.com"] });
    sent.length = 0;
    await send("PATCH", `/api/events/${ev.id}`, { summary: "改个标题" });
    expect(sent.length, `只改标题却发了 ${sent.length} 封信`).toBe(0);
  });

  it("把人移出列表，不该给他发新的邀请", async () => {
    const ev = await makeEvent({ attendees: ["a@example.com", "b@example.com"] });
    sent.length = 0;
    await send("PATCH", `/api/events/${ev.id}`, { extra: { attendees: ["a@example.com"] } });
    expect(sent.length, "移除参与者时发了信").toBe(0);
  });
});
