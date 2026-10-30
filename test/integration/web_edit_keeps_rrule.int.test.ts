// 网页编辑框保存一个「下拉里没有的」重复规则时，打到服务端的是什么、结果是什么。
//
// 以前下拉认不出的规则（手机写的 BYDAY=MO、「这次及以后」拆出来带 UNTIL 的、COUNT、隔周）
// 一律显示成「不重复」，保存发出 rrule:""，服务端照做清空 —— 只改个标题，整个系列就没了；
// 选「这次及以后」，拆出来的后半段变成单次。现在下拉临时插一项「自定义（保持原样）」选中，
// 保存时原规则原样带回去（test/event_form_reminder.test.ts 盯着前端那一半）。
//
// 这里从 HTTP 打进去，请求体照 calendar-app.js submit 拼的那个形状写。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, buildRoutedApp, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { reloadSettings } = await import("../../src/lib/site_settings.js");
const { hashPassword } = await import("../../src/lib/password.js");

const MEL = "Australia/Melbourne";

beforeAll(async () => { await ensureSchema(); });

let api: FastifyInstance;
let cookie: string;
let calendarId: string;

beforeEach(async () => {
  await resetDb();
  reloadSettings();
  api = await buildRoutedApp(eventRoutes, { prefix: "/api" });
  const [u] = await db.insert(schema.users)
    .values({ email: "web-edit@example.com", emailVerified: true, passwordHash: await hashPassword("web-edit-test-pw-123456"), passwordSet: true })
    .returning();
  cookie = await loginAs(api, u!.id);
  const [c] = await db.insert(schema.calendars)
    .values({ ownerId: u!.id, name: "Cal", color: "#000000", timezone: MEL }).returning();
  calendarId = c!.id;
});
afterEach(async () => { await api.close(); });

async function seed(rrule: string) {
  const [row] = await db.insert(schema.events).values({
    calendarId,
    uid: `web-edit-${Math.abs(hash(rrule))}`,
    summary: "例会",
    // 墨尔本 2026-09-28 周一 09:30 AEST
    startsAt: new Date("2026-09-27T23:30:00.000Z"),
    endsAt: new Date("2026-09-28T00:30:00.000Z"),
    rrule,
    extra: { timezone: MEL },
  }).returning();
  return row!;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

/** calendar-app.js submit 拼的请求体（编辑已有事件，定时、不是全天）。rrule 就是重复下拉的值。 */
function webBody(ev: { startsAt: Date; endsAt: Date }, rruleFromSelect: string, summary: string) {
  return {
    calendarId,
    summary,
    allDay: false,
    startsAt: ev.startsAt.toISOString(),
    endsAt: ev.endsAt.toISOString(),
    rrule: rruleFromSelect.trim() || "",
    extra: { category: null, timezone: MEL, attendees: null, url: null, meetingPassword: null, alarms: null },
  };
}

async function occurrencesOf(id: string): Promise<string[]> {
  const res = await api.inject({
    method: "GET",
    url: `/api/events?from=${encodeURIComponent("2026-09-01T00:00:00Z")}&to=${encodeURIComponent("2027-03-01T00:00:00Z")}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { events?: { id: string; startsAt: string }[] } | { id: string; startsAt: string }[];
  const list = Array.isArray(body) ? body : body.events ?? [];
  return list.filter((e) => e.id === id).map((e) => e.startsAt);
}

const CUSTOM_RULES = [
  "FREQ=WEEKLY;BYDAY=MO;COUNT=6",
  "FREQ=WEEKLY;UNTIL=20261102T000000Z",
  "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=4",
];

describe("网页只改了标题：下拉里没有的重复规则原样留着", () => {
  for (const rule of CUSTOM_RULES) {
    it(rule, async () => {
      const ev = await seed(rule);
      const before = await occurrencesOf(ev.id);
      expect(before.length, "前提：这是个重复事件").toBeGreaterThan(1);
      const res = await api.inject({
        method: "PATCH", url: `/api/events/${ev.id}`, headers: { cookie, "content-type": "application/json" },
        payload: JSON.stringify(webBody(ev, rule, "例会（改了标题）")),
      });
      expect(res.statusCode).toBe(200);
      const [row] = await db.select().from(schema.events).where(eq(schema.events.id, ev.id));
      expect(row!.rrule).toBe(rule);
      expect(row!.summary).toBe("例会（改了标题）");
      expect(await occurrencesOf(ev.id)).toEqual(before);
    });
  }

  it("对照：以前下拉显示成「不重复」时发出的空串，整个系列就没了（这条证明上面不是白测）", async () => {
    const ev = await seed(CUSTOM_RULES[0]!);
    await api.inject({
      method: "PATCH", url: `/api/events/${ev.id}`, headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify(webBody(ev, "", "例会（改了标题）")),
    });
    expect(await occurrencesOf(ev.id)).toHaveLength(1);
  });
});

describe("网页选「这次及以后」：拆出来的后半段还是重复的", () => {
  it("BYDAY=MO 的系列从 10-19 那次拆开：前半段到 10-12，后半段从 10-19 每周一继续", async () => {
    const rule = "FREQ=WEEKLY;BYDAY=MO;COUNT=8";
    const ev = await seed(rule);
    const occ = await occurrencesOf(ev.id);
    const split = occ.find((s) => s.startsWith("2026-10-18T22:30"))!;   // 墨尔本 10-19 周一 09:30 AEDT
    expect(split, "前提：10-19 那次在").toBeTruthy();
    const body = {
      ...webBody({ startsAt: new Date(split), endsAt: new Date(new Date(split).getTime() + 3600_000) }, rule, "新例会"),
      scope: "future", recurrenceId: split,
    };
    const res = await api.inject({
      method: "PATCH", url: `/api/events/${ev.id}`, headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(200);
    const created = res.json() as { id: string; rrule?: string | null };
    expect(created.rrule, "拆出来的后半段变成了单次").toBe(rule);
    const tail = await occurrencesOf(created.id);
    expect(tail.length).toBeGreaterThan(1);
    expect(tail[0]).toBe(split);
    expect((await occurrencesOf(ev.id)).every((s) => s < split)).toBe(true);
  });
});
