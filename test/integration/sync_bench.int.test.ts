// 同步基准（非常规测试的一部分）。
//
// 只在显式开启时运行：
//   BWC_BENCH=1 npx vitest run --config vitest.integration.config.ts \
//     test/integration/sync_bench.int.test.ts
//
// 测什么（同一进程、同一份种子数据、改前改后同法对比）：
//   A. CalDAV 服务端路径：PROPFIND Depth:0/1、calendar-query（只要 etag /
//      带正文）、calendar-multiget（50/200 条）、GET 单条，在 500 与
//      2000 条事件的日历上的耗时（中位数 + p95）与响应字节数。
//   B. App 冷启动同步序列：手机端现行口径是「一次 GET /events 拉
//      -2/+13 个月窗口（响应里连日历一起给）」，量这个窗口的耗时、
//      字节数、展开后的条数，以及重复事件每次出现都整份重复
//      description/extra 占了多少字节；同窗口 304 复核耗时。
//
// 方法学与 load_speed_bench 一致：DB 是进程内 PGlite，绝对毫秒数和
// 生产 Postgres 不可比，只用于同一环境、同一数据、改动前后的相对对比。
import { vi, beforeAll, describe, it } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import type { InjectOptions, Response as InjectResponse } from "light-my-request";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp, loginAs,
} from "./harness.js";
import { hashPassword } from "../../src/lib/password.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://bench:bench@localhost:5432/bench";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { caldavRoutes } = await import("../../src/web/caldav.js");
const { eventRoutes } = await import("../../src/routes/events.js");
const { calendarRoutes } = await import("../../src/routes/calendars.js");

const run = process.env.BWC_BENCH === "1" ? describe : describe.skip;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const RAW_ICS = [
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example Inc//Example Client//EN\r\nBEGIN:VEVENT\r\n",
  "UID:placeholder\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T010000Z\r\nDTEND:20260101T020000Z\r\n",
  "SUMMARY:Synced from phone\r\nDESCRIPTION:A fairly long description that came from a phone client\\, with commas and details about the meeting agenda and follow-ups. ".repeat(4),
  "\r\nLOCATION:Building 4, Room 201\r\nATTENDEE;CN=Someone Else;ROLE=REQ-PARTICIPANT:mailto:someone.else@example.com\r\n",
  "ATTENDEE;CN=Another Person;ROLE=REQ-PARTICIPANT:mailto:another.person@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
].join("");

type EventRow = typeof schema.events.$inferInsert;
const day = 86_400_000;

/** 造一个有 n 条事件的日历：约 65% 单次、25% 重复主记录（半数带 rawIcs）、10% 带参与者+提醒。 */
async function seedCalendar(calId: string, n: number, tag: string) {
  const rnd = lcg(n * 7 + 13);
  const rows: EventRow[] = [];
  const base = Date.UTC(2025, 0, 1);
  const singles = Math.floor(n * 0.65);
  const recurring = Math.floor(n * 0.25);
  for (let i = 0; i < singles; i++) {
    const start = new Date(base + Math.floor(rnd() * 900) * day + Math.floor(rnd() * 10 + 8) * 3_600_000);
    rows.push({
      calendarId: calId, uid: `${tag}-single-${i}`,
      summary: `Meeting ${i} — project sync and planning`,
      description: i % 2 === 0 ? "Agenda notes. ".repeat(18) : null,
      location: i % 3 === 0 ? "Office / Zoom" : null,
      startsAt: start, endsAt: new Date(start.getTime() + 3_600_000),
    });
  }
  const freqs = ["FREQ=WEEKLY", "FREQ=DAILY", "FREQ=MONTHLY"];
  for (let i = 0; i < recurring; i++) {
    const start = new Date(Date.UTC(2025, 10, 3, 1, 0) + (i % 300) * day);
    rows.push({
      calendarId: calId, uid: `${tag}-series-${i}`,
      summary: `Series ${i}`, description: "Recurring sync. ".repeat(8), location: "Room A",
      startsAt: start, endsAt: new Date(start.getTime() + 1_800_000),
      rrule: freqs[i % 3]!,
      rawIcs: i % 2 === 0 ? RAW_ICS.replace("placeholder", `${tag}-series-${i}`) : null,
      extra: { timezone: "Australia/Sydney" },
    });
  }
  for (let i = singles + recurring; i < n; i++) {
    const start = new Date(base + Math.floor(rnd() * 900) * day + Math.floor(rnd() * 10 + 8) * 3_600_000);
    rows.push({
      calendarId: calId, uid: `${tag}-invite-${i}`,
      summary: `Invite ${i}`, description: "With attendees", location: "Office",
      startsAt: start, endsAt: new Date(start.getTime() + 3_600_000),
      extra: {
        attendees: ["someone.else@example.com", "another.person@example.com"],
        alarms: [{ trigger: "-PT15M", action: "DISPLAY" }],
      },
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(schema.events).values(rows.slice(i, i + 200));
  }
  return rows;
}

async function timed(fn: () => Promise<{ ms: number }>, n = 15) {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) await fn();
  for (let i = 0; i < n; i++) samples.push((await fn()).ms);
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)]!, p95: samples[Math.floor(samples.length * 0.95)]! };
}

async function injectTimed(app: FastifyInstance, opts: InjectOptions) {
  const t0 = performance.now();
  const res: InjectResponse = await (app.inject as (o: InjectOptions) => Promise<InjectResponse>)(opts);
  return { ms: performance.now() - t0, res };
}

function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}KB` : `${n}B`;
}

const PASSWORD = "sync-bench-pw-123456";

async function buildCaldavApp() {
  const app = Fastify({ logger: false });
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  app.addContentTypeParser(
    /^(application\/xml|text\/xml|text\/calendar)\b/i,
    { parseAs: "string" },
    (_req, body, done) => done(null, body as string),
  );
  await app.register(caldavRoutes);
  await app.ready();
  return app;
}

const QUERY_ETAG_MONTH = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20261101T000000Z" end="20261201T000000Z"/></C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
const QUERY_ETAG_ALL = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"/></C:filter>
</C:calendar-query>`;
const QUERY_DATA_MONTH = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20261101T000000Z" end="20261201T000000Z"/></C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;

function multigetBody(userId: string, calId: string, uids: string[]): string {
  const hrefs = uids.map((u) => `<D:href>/caldav/${userId}/${calId}/${u}.ics</D:href>`).join("");
  return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>${hrefs}
</C:calendar-multiget>`;
}

run("sync bench — CalDAV", () => {
  beforeAll(async () => { await ensureSchema(); });

  it("reports CalDAV baselines", async () => {
    await resetDb();
    const [user] = await db.insert(schema.users)
      .values({ email: "dav-bench@example.com", emailVerified: true, passwordHash: await hashPassword(PASSWORD) })
      .returning();
    const cal500 = await makeCalendar(user!.id, "Bench500");
    const cal2000 = await makeCalendar(user!.id, "Bench2000");
    await seedCalendar(cal500.id, 500, "s5");
    const rows2000 = await seedCalendar(cal2000.id, 2000, "s2");

    const app = await buildCaldavApp();
    const auth = "Basic " + Buffer.from(`${user!.email}:${PASSWORD}`).toString("base64");
    const calUrl = (calId: string) => `/caldav/${user!.id}/${calId}/`;

    const out: string[] = ["", "=== CalDAV（PGlite 进程内，相对对比用）==="];
    const line = async (label: string, opts: InjectOptions) => {
      const t = await timed(() => injectTimed(app, opts));
      const r = await injectTimed(app, opts);
      out.push(`${label.padEnd(44)} median ${t.median.toFixed(1).padStart(7)}ms p95 ${t.p95.toFixed(1).padStart(7)}ms  ${fmt(r.res.rawPayload.length).padStart(9)}  status=${r.res.statusCode}`);
      return r;
    };

    await line("PROPFIND 2000 Depth:0 (ctag 轮询)", { method: "PROPFIND" as never, url: calUrl(cal2000.id), headers: { authorization: auth, depth: "0" } });
    await line("PROPFIND 2000 Depth:1 (etag 清单)", { method: "PROPFIND" as never, url: calUrl(cal2000.id), headers: { authorization: auth, depth: "1" } });
    await line("PROPFIND 500  Depth:1", { method: "PROPFIND" as never, url: calUrl(cal500.id), headers: { authorization: auth, depth: "1" } });
    await line("PROPFIND home Depth:1 (两日历)", { method: "PROPFIND" as never, url: `/caldav/${user!.id}/`, headers: { authorization: auth, depth: "1" } });
    await line("REPORT query etag-only 近1月 2000", { method: "REPORT" as never, url: calUrl(cal2000.id), headers: { authorization: auth, "content-type": "application/xml" }, payload: QUERY_ETAG_MONTH });
    await line("REPORT query etag-only 无范围 2000", { method: "REPORT" as never, url: calUrl(cal2000.id), headers: { authorization: auth, "content-type": "application/xml" }, payload: QUERY_ETAG_ALL });
    await line("REPORT query 带正文 近1月 2000", { method: "REPORT" as never, url: calUrl(cal2000.id), headers: { authorization: auth, "content-type": "application/xml" }, payload: QUERY_DATA_MONTH });
    const uids50 = rows2000.slice(0, 50).map((r) => r.uid!);
    const uids200 = rows2000.slice(0, 200).map((r) => r.uid!);
    await line("REPORT multiget 50 条 2000", { method: "REPORT" as never, url: calUrl(cal2000.id), headers: { authorization: auth, "content-type": "application/xml" }, payload: multigetBody(user!.id, cal2000.id, uids50) });
    await line("REPORT multiget 200 条 2000", { method: "REPORT" as never, url: calUrl(cal2000.id), headers: { authorization: auth, "content-type": "application/xml" }, payload: multigetBody(user!.id, cal2000.id, uids200) });
    await line("GET 单条事件 2000", { method: "GET", url: `${calUrl(cal2000.id)}${rows2000[0]!.uid}.ics`, headers: { authorization: auth } });

    console.log(out.join("\n"));
    await app.close();
  }, 600_000);
});

run("sync bench — API 同步序列", () => {
  beforeAll(async () => { await ensureSchema(); });

  it("reports API sync baselines", async () => {
    await resetDb();
    const user = await makeUser("sync-bench@example.com");
    const cals = [];
    for (const name of ["Work", "Personal", "Team"]) {
      cals.push(await makeCalendar(user.id, name));
    }
    const rnd = lcg(99);
    const rows: EventRow[] = [];
    // 800 条单次事件，散布在 15 个月窗口（2026-09 ~ 2027-12）内外。
    for (let i = 0; i < 800; i++) {
      const start = new Date(Date.UTC(2026, 8, 1) + Math.floor(rnd() * 457) * day + Math.floor(rnd() * 10 + 8) * 3_600_000);
      rows.push({
        calendarId: cals[i % 3]!.id, uid: `m-single-${i}`,
        summary: `Meeting ${i} — project sync and planning`,
        description: i % 2 === 0 ? "Agenda notes. ".repeat(18) : null,
        location: i % 3 === 0 ? "Office / Zoom" : null,
        startsAt: start, endsAt: new Date(start.getTime() + 3_600_000),
        extra: i % 4 === 0 ? { url: "https://meet.example.com/room-42" } : null,
      });
    }
    // 1 条日会：贯穿整个窗口（约 457 次出现），带长描述 + 会议链接——
    // 每次出现都整份重复一份 description/extra，量的就是这部分。
    const dailyStart = new Date(Date.UTC(2026, 7, 31, 23, 30));
    rows.push({
      calendarId: cals[0]!.id, uid: "m-daily-standup", summary: "Daily standup",
      description: "Daily sync notes and blockers. ".repeat(10), location: "Room A",
      startsAt: dailyStart, endsAt: new Date(dailyStart.getTime() + 900_000),
      rrule: "FREQ=DAILY", extra: { timezone: "Australia/Sydney", url: "https://meet.example.com/standup" },
    });
    // 25 条周会（进行中）+ 200 条早已结束的系列（窗口内 0 次出现，但主记录会被捞出来展开）。
    for (let i = 0; i < 25; i++) {
      const start = new Date(Date.UTC(2026, 8, 7, 1, 0) + i * day);
      rows.push({
        calendarId: cals[i % 3]!.id, uid: `m-weekly-${i}`, summary: `Weekly ${i}`,
        description: "Weekly recurring sync. ".repeat(8),
        startsAt: start, endsAt: new Date(start.getTime() + 1_800_000),
        rrule: "FREQ=WEEKLY", extra: { timezone: "Australia/Sydney" },
      });
    }
    for (let i = 0; i < 200; i++) {
      const start = new Date(Date.UTC(2023, 0, 2, 1, 0) + (i % 300) * day);
      rows.push({
        calendarId: cals[i % 3]!.id, uid: `m-dead-${i}`, summary: `Old weekly ${i}`,
        startsAt: start, endsAt: new Date(start.getTime() + 1_800_000),
        rrule: "FREQ=WEEKLY;UNTIL=20240601T000000Z", extra: { timezone: "Australia/Sydney" },
      });
    }
    for (let i = 0; i < rows.length; i += 200) {
      await db.insert(schema.events).values(rows.slice(i, i + 200));
    }

    const app = await buildRoutedApp(async (a) => {
      await eventRoutes(a);
      await calendarRoutes(a);
    }, { prefix: "/api/v1" });
    const cookie = await loginAs(app, user.id);

    const out: string[] = ["", "=== API 同步序列（PGlite 进程内，相对对比用）==="];
    out.push("手机冷启动序列（代码走查）：刷新 token（过期时）→ GET /events 一次（日历+事件同响应）→ 结束。");
    const mobileUrl = "/api/v1/events?from=2026-09-01T00:00:00.000Z&to=2027-12-01T00:00:00.000Z";
    let etag = "";
    {
      const t = await timed(() => injectTimed(app, { url: mobileUrl, headers: { cookie } }), 10);
      const r = await injectTimed(app, { url: mobileUrl, headers: { cookie } });
      etag = r.res.headers.etag as string;
      const body = JSON.parse(r.res.payload) as { events: Array<Record<string, unknown>>; calendars: unknown[] };
      // 重复事件每次出现重复携带的 description/extra 字节估算：同一 id 第 2 次起出现的
      // description + extra JSON 长度之和。
      const seen = new Map<string, number>();
      let dupBytes = 0;
      for (const ev of body.events) {
        const id = String(ev.id);
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        if (n > 1) {
          dupBytes += String(ev.description ?? "").length;
          if (ev.extra) dupBytes += JSON.stringify(ev.extra).length;
        }
      }
      const recurringIds = [...seen.values()].filter((n) => n > 1).length;
      out.push(`GET /events 15个月(手机窗口) median ${t.median.toFixed(1)}ms p95 ${t.p95.toFixed(1)}ms  ${fmt(r.res.rawPayload.length)}  events=${body.events.length}（其中重复系列 ${recurringIds} 条） 重复携带的 description/extra ≈ ${fmt(dupBytes)}`);
      // 重复文本恰是压缩最擅长的：线径按 gzip / br 再量一遍，免得拿未压缩
      // 字节去高估「重复携带」的真实传输成本。
      out.push(`  同响应线径：gzip ${fmt(gzipSync(r.res.rawPayload).length)}  br ${fmt(brotliCompressSync(r.res.rawPayload).length)}`);
    }
    {
      const t = await timed(() => injectTimed(app, { url: mobileUrl, headers: { cookie, "if-none-match": etag } }), 10);
      const r = await injectTimed(app, { url: mobileUrl, headers: { cookie, "if-none-match": etag } });
      out.push(`GET /events 15个月 304 复核   median ${t.median.toFixed(1)}ms  status=${r.res.statusCode} ${fmt(r.res.rawPayload.length)}`);
    }
    {
      const url42 = "/api/v1/events?from=2026-11-16T00:00:00.000Z&to=2026-12-28T00:00:00.000Z";
      const t = await timed(() => injectTimed(app, { url: url42, headers: { cookie } }), 10);
      const r = await injectTimed(app, { url: url42, headers: { cookie } });
      const body = JSON.parse(r.res.payload) as { events: unknown[] };
      out.push(`GET /events 42天(网页窗口)    median ${t.median.toFixed(1)}ms p95 ${t.p95.toFixed(1)}ms  ${fmt(r.res.rawPayload.length)}  events=${body.events.length}`);
    }
    console.log(out.join("\n"));
    await app.close();
  }, 600_000);
});
