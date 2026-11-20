// 网页端预约链接的每周可约时间编辑器（建链 + 编辑两处）。
//
// 此前网页建链表单把 weeklyAvailability 写死 DEFAULT_AVAILABILITY、页面
// 文案却写着「创建后可以再细调」，而网页根本没有编辑表单 —— 只有桌面/
// Android 经 JSON API 能改。本文件盯住网页这条路：
//   1. 列表页给每条链接渲染编辑表单，可约时间区按该链接的真实矩阵播种；
//      建链表单的编辑区按默认矩阵播种；误导文案已换成新键的文案。
//   2. 建链 POST 带 weeklyAvailability（JSON 串，只含可约日）→ 原样落库；
//      不带该字段 → 仍存默认矩阵（无 JS 时的兜底口径）。
//   3. 编辑 POST 改一个时段 → 落库矩阵与预期一致、其余字段不动；
//      描述清空 → 落 null（不是把旧值带回去）。
//   4. weeklyAvailability 是坏 JSON / 坏形状 → 重定向报错且不落库；
//      别人的链接打 update → 不生效。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??=<redacted>
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { webRoutes } = await import("../../src/web/index.js");
const { makeT } = await import("../../src/lib/i18n.js");
const { env } = await import("../../src/env.js");
const { jsonForScript } = await import("../../src/lib/script_json.js");
const { DEFAULT_AVAILABILITY } = await import("../../src/lib/booking.js");

let app: FastifyInstance;
let owner: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;
let calendarId: string;
let auth: string;
let otherAuth: string;

// A deliberately non-default matrix: Saturday on, Tuesday double window,
// Wednesday off (absent from the wire format entirely).
const CUSTOM = {
  "2": [["08:30", "12:00"], ["13:00", "17:30"]],
  "6": [["10:00", "12:00"]],
} as const;

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(formbody);
  await app.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view", options: { async: false },
    defaultContext: {
      t: makeT("zh-CN"), siteName: "ByWave", siteLogoUrl: null, icpNumber: null, icpUrl: "",
      assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n", currentLocale: "zh-CN",
      locales: [], siteLocaleOptions: [], currentUser: null, themePalette: "indigo",
      themeDensity: "comfortable", currentPath: "/app/booking-links", jsonForScript,
    },
  });
  await app.register(webRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); });

beforeEach(async () => {
  await resetDb();
  owner = await makeUser("bkweb-owner@example.com");
  other = await makeUser("bkweb-other@example.com");
  const cal = await makeCalendar(owner.id);
  calendarId = cal.id;
  // other needs a calendar too, or their booking-links page renders the
  // "no calendars yet" branch with no form (and no csrf token to scrape).
  await makeCalendar(other.id);
  auth = await loginAs(app, owner.id);
  otherAuth = await loginAs(app, other.id);
});

async function csrfFor(cookieHeader: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/app/booking-links", headers: { cookie: cookieHeader } });
  expect(res.statusCode).toBe(200);
  const m = res.body.match(/name="_csrf" value="([0-9a-f]+)"/);
  expect(m, "page should carry a csrf token").toBeTruthy();
  return m![1]!;
}

function form(fields: Record<string, string>, cookieHeader: string) {
  return {
    headers: { cookie: cookieHeader, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  };
}

async function seedLink(weeklyAvailability: unknown = CUSTOM) {
  const [link] = await db.insert(schema.bookingLinks).values({
    userId: owner.id, calendarId, slug: "chat", title: "咨询",
    description: "旧描述", durationMinutes: 45, minNoticeHours: 3, maxDaysAhead: 21,
    bufferBeforeMin: 5, bufferAfterMin: 10, notifyEmail: false,
    weeklyAvailability: weeklyAvailability as never,
  }).returning();
  return link!;
}

async function storedLink(id: string) {
  const [row] = await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.id, id));
  return row!;
}

describe("网页预约链接编辑器", () => {
  it("列表页编辑表单按真实矩阵播种，建链表单按默认矩阵播种，误导文案已替换", async () => {
    const link = await seedLink();
    const res = await app.inject({ method: "GET", url: "/app/booking-links", headers: { cookie: auth } });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    // Misleading copy is gone; the replacement key's zh-CN text is shown.
    expect(html).not.toContain("创建后可以再细调");
    expect(html).toContain("创建后也可以在链接的编辑表单里随时修改");
    // Edit form exists for the seeded link and posts to the update route.
    expect(html).toContain(`action="/app/booking-links/${link.id}/update"`);
    // Seeded windows are rendered as input values (Saturday 10:00–12:00,
    // Tuesday's second window 13:00–17:30).
    expect(html).toContain('data-avail-day="6"');
    expect(html).toContain('value="10:00"');
    expect(html).toContain('value="13:00"');
    expect(html).toContain('value="17:30"');
    // The edit form's hidden field carries exactly the stored matrix
    // (bookable days only), HTML-escaped quotes included.
    const wire = JSON.stringify(CUSTOM).replace(/"/g, "&#34;");
    expect(html).toContain(`value="${wire}"`);
    // Other fields are seeded too.
    expect(html).toContain('value="咨询"');
    expect(html).toContain("旧描述");
    // Create form's hidden field carries the default matrix.
    const defaultWire = JSON.stringify({
      "1": [["09:00", "18:00"]], "2": [["09:00", "18:00"]], "3": [["09:00", "18:00"]],
      "4": [["09:00", "18:00"]], "5": [["09:00", "18:00"]],
    }).replace(/"/g, "&#34;");
    expect(html).toContain(`value="${defaultWire}"`);
    expect(DEFAULT_AVAILABILITY["1"]).toEqual([["09:00", "18:00"]]);
  });

  it("建链 POST 带自定义矩阵 → 原样落库；不带 → 默认矩阵", async () => {
    const csrf = await csrfFor(auth);
    const res = await app.inject({
      method: "POST", url: "/app/booking-links",
      ...form({
        _csrf: csrf, slug: "custom", title: "自定义时段", calendarId,
        durationMinutes: "30", minNoticeHours: "2", maxDaysAhead: "14",
        bufferBeforeMin: "0", bufferAfterMin: "0", notifyEmail: "on",
        weeklyAvailability: JSON.stringify(CUSTOM),
      }, auth),
    });
    expect(res.statusCode).toBe(302);
    const [row] = await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.slug, "custom"));
    expect(row!.weeklyAvailability).toEqual(CUSTOM);

    const res2 = await app.inject({
      method: "POST", url: "/app/booking-links",
      ...form({
        _csrf: csrf, slug: "plain", title: "默认时段", calendarId,
        durationMinutes: "30", minNoticeHours: "2", maxDaysAhead: "14",
      }, auth),
    });
    expect(res2.statusCode).toBe(302);
    const [row2] = await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.slug, "plain"));
    expect(row2!.weeklyAvailability).toEqual(DEFAULT_AVAILABILITY);
  });

  it("编辑 POST 改一个时段 → 矩阵与预期一致，其余字段不动，描述可清空", async () => {
    const link = await seedLink();
    const csrf = await csrfFor(auth);
    const edited = { "2": [["08:30", "12:00"], ["13:00", "17:30"]], "6": [["10:30", "12:00"]] };
    const res = await app.inject({
      method: "POST", url: `/app/booking-links/${link.id}/update`,
      ...form({
        _csrf: csrf, slug: "chat", title: "咨询", description: "",
        calendarId, durationMinutes: "45", minNoticeHours: "3", maxDaysAhead: "21",
        bufferBeforeMin: "5", bufferAfterMin: "10",
        // notifyEmail absent = unchecked, matching the seeded false.
        weeklyAvailability: JSON.stringify(edited),
      }, auth),
    });
    expect(res.statusCode).toBe(302);
    const row = await storedLink(link.id);
    expect(row.weeklyAvailability).toEqual(edited);
    expect(row.title).toBe("咨询");
    expect(row.durationMinutes).toBe(45);
    expect(row.minNoticeHours).toBe(3);
    expect(row.bufferAfterMin).toBe(10);
    expect(row.notifyEmail).toBe(false);
    expect(row.description).toBeNull();
  });

  it("编辑 POST 带坏矩阵 → 不落库；非所有者 update → 不生效", async () => {
    const link = await seedLink();
    const csrf = await csrfFor(auth);
    const bad = await app.inject({
      method: "POST", url: `/app/booking-links/${link.id}/update`,
      ...form({
        _csrf: csrf, slug: "chat", title: "改名", calendarId,
        durationMinutes: "45", minNoticeHours: "3", maxDaysAhead: "21",
        bufferBeforeMin: "5", bufferAfterMin: "10",
        weeklyAvailability: "{\"2\":[[\"25:00\",\"26:00\"]]}",
      }, auth),
    });
    expect(bad.statusCode).toBe(302);
    let row = await storedLink(link.id);
    expect(row.title).toBe("咨询");
    expect(row.weeklyAvailability).toEqual(CUSTOM);

    const otherCsrf = await csrfFor(otherAuth);
    const foreign = await app.inject({
      method: "POST", url: `/app/booking-links/${link.id}/update`,
      ...form({
        _csrf: otherCsrf, slug: "chat", title: "别人的改名", calendarId,
        durationMinutes: "45", minNoticeHours: "3", maxDaysAhead: "21",
        bufferBeforeMin: "5", bufferAfterMin: "10",
        weeklyAvailability: JSON.stringify(CUSTOM),
      }, otherAuth),
    });
    expect(foreign.statusCode).toBe(302);
    row = await storedLink(link.id);
    expect(row.title).toBe("咨询");
  });
});
