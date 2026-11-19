// 同步内容保真（集成层）：ICS 导入与 CalDAV round-trip 的字段不丢不改。
//
// 守的回归（都是这一轮实查出来的真丢法）：
//   · 导入的重复事件带着 EXDATE，新行以前根本不写 exdates 列——删掉的那一次照样出现；
//   · 上游刷新新带一条 EXDATE（在别处删了某一次），这边 unchanged 判定不看
//     exdates，永远落不了库；
//   · ATTENDEE / CATEGORIES / TRANSP / STATUS / URL 解析出来了却不进 extra，
//     导入即丢；
//   · RECURRENCE-ID 的 override 和主记录同 uid 在 pending 里互相顶掉，
//     主记录被那一次的内容整个覆盖、系列只剩一次；
//   · CalDAV PUT 存进 extra 的 TRANSP/CATEGORIES/…，事件被 API PATCH 一次
//     （rawIcs 被清）之后，合成路径吐不回去，字段从手机日历眼前消失。
import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { and, eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, loginAs, SESSION_COOKIE_NAME } from "./harness.js";
import { importIcsText } from "../../src/lib/ics_import.js";
import { hashPassword } from "../../src/lib/password.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { caldavRoutes } = await import("../../src/web/caldav.js");
const { eventRoutes } = await import("../../src/routes/events.js");

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); invalidateCalDavAuthCache(); });

const CRLF = "\r\n";
const icsOf = (blocks: string[][]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//fidelity//EN", ...blocks.flat(), "END:VCALENDAR"].join(CRLF) + CRLF;

async function rowByUid(calendarId: string, uid: string) {
  const [r] = await db.select().from(schema.events)
    .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uid, uid)));
  return r ?? null;
}

// 一个带 EXDATE 的周会 + 一条被单独改过的 occurrence（RECURRENCE-ID）+
// 带参与者/分类/TRANSP/STATUS/URL 的普通事件 + DURATION 事件。
const MASTER_UID = "weekly-master@example.com";
const FILE_V1 = icsOf([
  [
    "BEGIN:VEVENT",
    `UID:${MASTER_UID}`,
    "SUMMARY:Weekly sync",
    "DTSTART:20260601T090000Z",
    "DTEND:20260601T100000Z",
    "RRULE:FREQ=WEEKLY",
    "EXDATE:20260615T090000Z",
    "END:VEVENT",
  ],
  [
    "BEGIN:VEVENT",
    `UID:${MASTER_UID}`,
    "SUMMARY:Weekly sync (moved)",
    "DTSTART:20260608T140000Z",
    "DTEND:20260608T150000Z",
    "RECURRENCE-ID:20260608T090000Z",
    "END:VEVENT",
  ],
  [
    "BEGIN:VEVENT",
    "UID:invite-event@example.com",
    "SUMMARY:Planning",
    "DTSTART:20260603T100000Z",
    "DTEND:20260603T110000Z",
    "LOCATION:Office",
    "ATTENDEE;CN=Alice;ROLE=REQ-PARTICIPANT:mailto:alice@example.com",
    "ORGANIZER:mailto:boss@example.com",
    "CATEGORIES:Work,Planning",
    "TRANSP:TRANSPARENT",
    "STATUS:TENTATIVE",
    "URL:https://meet.example.com/planning",
    "END:VEVENT",
  ],
  [
    "BEGIN:VEVENT",
    "UID:duration-event@example.com",
    "SUMMARY:Focus block",
    "DTSTART:20260604T100000Z",
    "DURATION:PT2H",
    "END:VEVENT",
  ],
]);

describe("ICS 导入保真", () => {
  it("EXDATE 落库、override 拆成 exdate + 独立事件、字段进 extra、DURATION 成立", async () => {
    const user = await makeUser("fid-import@example.com");
    const cal = await makeCalendar(user.id, "Imported");

    const res = await importIcsText(cal.id, FILE_V1);
    // 主记录 + 独立的那一次 + invite + duration = 4 条新增。
    expect(res.inserted).toBe(4);

    const master = await rowByUid(cal.id, MASTER_UID);
    expect(master).not.toBeNull();
    // 主记录没有被 override 顶掉：标题和开始时间还是系列本身的。
    expect(master!.summary).toBe("Weekly sync");
    expect(master!.startsAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(master!.rrule).toBe("FREQ=WEEKLY");
    // EXDATE（文件自带的）+ override 的那一次，都进了 exdates。
    const exdates = (master!.exdates as string[]).slice().sort();
    expect(exdates).toEqual(["2026-06-08T09:00:00.000Z", "2026-06-15T09:00:00.000Z"]);

    // override 本体是一条独立单次事件，uid 确定性派生。
    const standalone = await rowByUid(cal.id, `${MASTER_UID}~2026-06-08T09:00:00.000Z`);
    expect(standalone).not.toBeNull();
    expect(standalone!.summary).toBe("Weekly sync (moved)");
    expect(standalone!.startsAt.toISOString()).toBe("2026-06-08T14:00:00.000Z");
    expect(standalone!.rrule).toBeNull();

    const invite = await rowByUid(cal.id, "invite-event@example.com");
    const extra = invite!.extra as Record<string, unknown>;
    expect(extra.attendees).toEqual(["alice@example.com"]);
    expect(extra.organizer).toBe("boss@example.com");
    expect(extra.categories).toEqual(["Work", "Planning"]);
    expect(extra.transp).toBe("TRANSPARENT");
    expect(extra.status).toBe("TENTATIVE");
    expect(extra.url).toBe("https://meet.example.com/planning");

    const dur = await rowByUid(cal.id, "duration-event@example.com");
    expect(dur!.endsAt.getTime() - dur!.startsAt.getTime()).toBe(2 * 3_600_000);
  });

  it("重复导入幂等：计数全为重复，主记录 exdates 不重复追加", async () => {
    const user = await makeUser("fid-import2@example.com");
    const cal = await makeCalendar(user.id, "Imported");
    await importIcsText(cal.id, FILE_V1);
    const res = await importIcsText(cal.id, FILE_V1);
    expect(res.inserted).toBe(0);
    expect(res.updated).toBe(0);
    const master = await rowByUid(cal.id, MASTER_UID);
    expect((master!.exdates as string[]).length).toBe(2);
  });

  it("上游新带一条 EXDATE 的刷新能落库（以前 unchanged 判定看不见 exdates）", async () => {
    const user = await makeUser("fid-import3@example.com");
    const cal = await makeCalendar(user.id, "Imported");
    await importIcsText(cal.id, FILE_V1);
    const v2 = FILE_V1.replace("EXDATE:20260615T090000Z", "EXDATE:20260615T090000Z\r\nEXDATE:20260622T090000Z");
    const res = await importIcsText(cal.id, v2);
    expect(res.updated).toBe(1);
    const master = await rowByUid(cal.id, MASTER_UID);
    expect((master!.exdates as string[]).slice().sort()).toEqual([
      "2026-06-08T09:00:00.000Z", "2026-06-15T09:00:00.000Z", "2026-06-22T09:00:00.000Z",
    ]);
  });

  it("用户在本地删掉的一次不会被不带 EXDATE 的上游刷新复活（并集口径）", async () => {
    const user = await makeUser("fid-import4@example.com");
    const cal = await makeCalendar(user.id, "Imported");
    await importIcsText(cal.id, FILE_V1);
    // 模拟用户在我们这边又删了 2026-06-29 那一次。
    const master = await rowByUid(cal.id, MASTER_UID);
    await db.update(schema.events)
      .set({ exdates: [...(master!.exdates as string[]), "2026-06-29T09:00:00.000Z"] })
      .where(eq(schema.events.id, master!.id));
    await importIcsText(cal.id, FILE_V1);
    const after = await rowByUid(cal.id, MASTER_UID);
    expect(after!.exdates as string[]).toContain("2026-06-29T09:00:00.000Z");
  });
});

describe("CalDAV round-trip 保真（合成路径）", () => {
  const PASSWORD = "fidelity-pw-123456";

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(cookie, { secret: "test-cookie-secret-for-fidelity-suite-0123456789" });
    app.addHttpMethod("PROPFIND", { hasBody: true });
    app.addHttpMethod("REPORT", { hasBody: true });
    app.addContentTypeParser(
      /^(application\/xml|text\/xml|text\/calendar)\b/i,
      { parseAs: "string" },
      (_req, body, done) => done(null, body as string),
    );
    await app.register(caldavRoutes);
    await app.register(async (scoped) => { await eventRoutes(scoped); }, { prefix: "/api/v1" });
    await app.ready();
    return app;
  }

  it("PUT 存下的 TRANSP/STATUS/CATEGORIES/URL，被 API PATCH 后仍能从 CalDAV 读回", async () => {
    const [user] = await db.insert(schema.users)
      .values({ email: "fid-dav@example.com", emailVerified: true, passwordHash: await hashPassword(PASSWORD) })
      .returning();
    const cal = await makeCalendar(user!.id, "DavCal");
    const app = await buildApp();
    const auth = "Basic " + Buffer.from(`${user!.email}:${PASSWORD}`).toString("base64");
    const url = `/caldav/${user!.id}/${cal.id}/roundtrip-1.ics`;
    const body = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//fidelity//EN",
      "BEGIN:VEVENT",
      "UID:roundtrip-1",
      "DTSTAMP:20260601T000000Z",
      "DTSTART:20260610T100000Z",
      "DTEND:20260610T110000Z",
      "SUMMARY:Round trip",
      "TRANSP:TRANSPARENT",
      "STATUS:TENTATIVE",
      "CATEGORIES:Work,Planning",
      "URL:https://meet.example.com/rt",
      "END:VEVENT", "END:VCALENDAR",
    ].join(CRLF);
    const put = await app.inject({ method: "PUT", url, headers: { authorization: auth, "content-type": "text/calendar" }, payload: body });
    expect(put.statusCode).toBe(201);

    const get1 = await app.inject({ method: "GET", url, headers: { authorization: auth } });
    expect(get1.body).toContain("TRANSP:TRANSPARENT");
    expect(get1.body).toContain("CATEGORIES:Work,Planning");

    // API PATCH 改标题：这条路会清掉 rawIcs，之后 CalDAV 只能走合成路径——
    // 合成路径以前不写 TRANSP/STATUS/CATEGORIES/URL，字段就此消失。
    const row = await rowByUid(cal.id, "roundtrip-1");
    const cookieHeader = await loginAs(app, user!.id);
    expect(cookieHeader.startsWith(SESSION_COOKIE_NAME)).toBe(true);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/events/${row!.id}`,
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: JSON.stringify({ summary: "Round trip (renamed)" }),
    });
    expect(patch.statusCode).toBe(200);
    const after = await rowByUid(cal.id, "roundtrip-1");
    expect(after!.rawIcs).toBeNull();

    const get2 = await app.inject({ method: "GET", url, headers: { authorization: auth } });
    expect(get2.body).toContain("SUMMARY:Round trip (renamed)");
    expect(get2.body).toContain("TRANSP:TRANSPARENT");
    expect(get2.body).toContain("STATUS:TENTATIVE");
    expect(get2.body).toContain("CATEGORIES:Work,Planning");
    expect(get2.body).toContain("URL:https://meet.example.com/rt");
    await app.close();
  });
});
