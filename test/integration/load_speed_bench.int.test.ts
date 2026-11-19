// 加载速度基准（非常规测试的一部分）。
//
// 只在显式开启时运行：
//   BWC_BENCH=1 npx vitest run --config vitest.integration.config.ts \
//     test/integration/load_speed_bench.int.test.ts
//
// 测什么（同一进程、同一份种子数据、改前改后同法对比）：
//   · GET /api/v1/events 月视图窗口（42 天）/ 周窗口（7 天）的服务端耗时
//     （中位数 + p95）、响应字节数、事件条数；
//   · 同一窗口带 If-None-Match 的 304 复核耗时；
//   · GET /api/v1/calendars 的耗时与字节数（登录后首屏组合的另一半）；
//   · 注册了 @fastify/compress 的实例上 gzip / br 的线上字节与耗时；
//   · 窗口查询的 EXPLAIN ANALYZE（PGlite）；
//   · 网页首屏资源图：layout 全局资源 + 日历页专属资源的 raw/gzip/br
//     体积与请求数（生产口径：JS 取 _built 的压缩版）。
//
// 方法学说明：DB 是进程内 PGlite（WASM），绝对毫秒数和生产 Postgres
// 不可比；这里的数字只用于「同一环境、同一数据、改动前后」的相对对比。
// 种子数据是一个「重度用户」画像：3 个日历、800 条单次事件、45 条进行中
// 的重复系列、250 条早已结束的重复系列（现实里会不断累积的那种）。
import { vi, beforeAll, describe, it } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

import { gzipSync, brotliCompressSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { InjectOptions, Response as InjectResponse } from "light-my-request";
import {
  ensureSchema, resetDb, db, schema, pg,
  makeUser, buildRoutedApp, loginAs,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://bench:bench@localhost:5432/bench";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { calendarRoutes } = await import("../../src/routes/calendars.js");
const { default: compress } = await import("@fastify/compress");
const { default: fastifyStatic } = await import("@fastify/static");
const { cacheControlForVersionedStatic } = await import("../../src/lib/asset_version.js");
import path from "node:path";

const run = process.env.BWC_BENCH === "1" ? describe : describe.skip;

// 确定性伪随机，种子数据每次一致，改前改后可比。
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

async function seed() {
  const user = await makeUser("bench@example.com");
  const cals = [];
  for (const name of ["Work", "Personal", "Team"]) {
    const [c] = await db
      .insert(schema.calendars)
      .values({ ownerId: user.id, name, color: "#3b82f6", timezone: "Australia/Sydney" })
      .returning();
    cals.push(c!);
  }
  const rnd = lcg(42);
  const rows: EventRow[] = [];
  const day = 86_400_000;
  const base = Date.UTC(2025, 8, 1); // 2025-09-01

  // 800 条单次事件，散布在 2025-09 ~ 2027-03。
  for (let i = 0; i < 800; i++) {
    const start = new Date(base + Math.floor(rnd() * 547) * day + Math.floor(rnd() * 10 + 8) * 3_600_000);
    rows.push({
      calendarId: cals[i % 3]!.id,
      uid: `single-${i}`,
      summary: `Meeting ${i} — project sync and planning`,
      description: i % 2 === 0 ? "Agenda notes. ".repeat(18) : null,
      location: i % 3 === 0 ? "Office / Zoom" : null,
      startsAt: start,
      endsAt: new Date(start.getTime() + 3_600_000),
      extra: i % 4 === 0 ? { url: "https://meet.example.com/room-42" } : null,
    });
  }
  // 进行中的重复系列：25 周会 + 10 日会 + 10 月会，带 rawIcs（手机建的）。
  for (let i = 0; i < 25; i++) {
    const start = new Date(Date.UTC(2025, 10, 20, 1, 0) + i * day);
    rows.push({
      calendarId: cals[i % 3]!.id, uid: `weekly-${i}`, summary: `Weekly standup ${i}`,
      description: "Weekly recurring sync. ".repeat(8), location: "Room A",
      startsAt: start, endsAt: new Date(start.getTime() + 1_800_000),
      rrule: "FREQ=WEEKLY", rawIcs: RAW_ICS.replace("placeholder", `weekly-${i}`),
      extra: { timezone: "Australia/Sydney" },
    });
  }
  for (let i = 0; i < 10; i++) {
    const start = new Date(Date.UTC(2026, 0, 1, 22, 30) + i * 3_600_000);
    rows.push({
      calendarId: cals[i % 3]!.id, uid: `daily-${i}`, summary: `Daily check-in ${i}`,
      startsAt: start, endsAt: new Date(start.getTime() + 900_000),
      rrule: "FREQ=DAILY", rawIcs: RAW_ICS.replace("placeholder", `daily-${i}`),
      extra: { timezone: "Australia/Sydney" },
    });
  }
  for (let i = 0; i < 10; i++) {
    const start = new Date(Date.UTC(2025, 10, 5, 3, 0) + i * day);
    rows.push({
      calendarId: cals[i % 3]!.id, uid: `monthly-${i}`, summary: `Monthly review ${i}`,
      startsAt: start, endsAt: new Date(start.getTime() + 7_200_000),
      rrule: "FREQ=MONTHLY", rawIcs: RAW_ICS.replace("placeholder", `monthly-${i}`),
      extra: { timezone: "Australia/Sydney" },
    });
  }
  // 早已结束的重复系列：200 周会（UNTIL 2024-06）+ 50 日会（COUNT 用完）。
  // 它们对任何当前窗口都贡献 0 条，但窗口查询的谓词（rrule IS NOT NULL）
  // 会把它们全部捞出来再展开——测的就是这部分浪费。
  for (let i = 0; i < 200; i++) {
    const start = new Date(Date.UTC(2023, 0, 2, 1, 0) + (i % 300) * day);
    rows.push({
      calendarId: cals[i % 3]!.id, uid: `dead-weekly-${i}`, summary: `Old weekly ${i}`,
      startsAt: start, endsAt: new Date(start.getTime() + 1_800_000),
      rrule: "FREQ=WEEKLY;UNTIL=20240601T000000Z", rawIcs: RAW_ICS.replace("placeholder", `dead-weekly-${i}`),
      extra: { timezone: "Australia/Sydney" },
    });
  }
  for (let i = 0; i < 50; i++) {
    const start = new Date(Date.UTC(2024, 0, 1, 22, 30) + (i % 60) * day);
    rows.push({
      calendarId: cals[i % 3]!.id, uid: `dead-daily-${i}`, summary: `Old daily ${i}`,
      startsAt: start, endsAt: new Date(start.getTime() + 900_000),
      rrule: "FREQ=DAILY;COUNT=30", rawIcs: RAW_ICS.replace("placeholder", `dead-daily-${i}`),
      extra: { timezone: "Australia/Sydney" },
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(schema.events).values(rows.slice(i, i + 200));
  }
  return { user, cals };
}

async function timed(fn: () => Promise<{ ms: number }>, n = 25) {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) await fn(); // warmup
  for (let i = 0; i < n; i++) samples.push((await fn()).ms);
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  return { median, p95 };
}

async function injectTimed(app: FastifyInstance, opts: InjectOptions) {
  const t0 = performance.now();
  const res: InjectResponse = await app.inject(opts);
  return { ms: performance.now() - t0, res };
}

function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}KB` : `${n}B`;
}

run("load speed bench", () => {
  beforeAll(async () => { await ensureSchema(); });

  it("reports baselines", async () => {
    await resetDb();
    const { user, cals } = await seed();

    const plain = await buildRoutedApp(async (a) => {
      await eventRoutes(a);
      await calendarRoutes(a);
    }, { prefix: "/api/v1" });
    const cookie = await loginAs(plain, user.id);

    const monthUrl = "/api/v1/events?from=2026-11-16T00:00:00.000Z&to=2026-12-28T00:00:00.000Z";
    const weekUrl = "/api/v1/events?from=2026-11-16T00:00:00.000Z&to=2026-11-23T00:00:00.000Z";

    const out: string[] = ["", "=== API（PGlite 进程内，相对对比用）==="];
    let etag = "";
    {
      let last: Awaited<ReturnType<typeof injectTimed>> | null = null;
      const t = await timed(async () => {
        const r = await injectTimed(plain, { url: monthUrl, headers: { cookie } });
        last = r;
        return r;
      });
      const body = JSON.parse(last!.res.payload) as { events: unknown[]; calendars: unknown[] };
      etag = last!.res.headers.etag as string;
      out.push(`GET /events 42d   median ${t.median.toFixed(1)}ms p95 ${t.p95.toFixed(1)}ms  ${fmt(last!.res.rawPayload.length)}  events=${body.events.length} calendars=${body.calendars.length}`);
    }
    {
      const t = await timed(() => injectTimed(plain, { url: weekUrl, headers: { cookie } }));
      const r = await injectTimed(plain, { url: weekUrl, headers: { cookie } });
      const body = JSON.parse(r.res.payload) as { events: unknown[] };
      out.push(`GET /events 7d    median ${t.median.toFixed(1)}ms p95 ${t.p95.toFixed(1)}ms  ${fmt(r.res.rawPayload.length)}  events=${body.events.length}`);
    }
    {
      const t = await timed(() => injectTimed(plain, { url: monthUrl, headers: { cookie, "if-none-match": etag } }));
      const r = await injectTimed(plain, { url: monthUrl, headers: { cookie, "if-none-match": etag } });
      out.push(`GET /events 42d 304 median ${t.median.toFixed(1)}ms  status=${r.res.statusCode} ${fmt(r.res.rawPayload.length)}`);
    }
    {
      const t = await timed(() => injectTimed(plain, { url: "/api/v1/calendars", headers: { cookie } }));
      const r = await injectTimed(plain, { url: "/api/v1/calendars", headers: { cookie } });
      out.push(`GET /calendars    median ${t.median.toFixed(1)}ms p95 ${t.p95.toFixed(1)}ms  ${fmt(r.res.rawPayload.length)}`);
    }
    await plain.close();

    // 带压缩的同一组请求：线上字节 + 压缩耗时。
    const comp = await buildRoutedApp(async (a) => {
      await a.register(compress, { global: true, encodings: ["br", "gzip"], threshold: 1024 });
      await eventRoutes(a);
      await calendarRoutes(a);
    }, { prefix: "/api/v1" });
    const cookie2 = await loginAs(comp, user.id);
    for (const enc of ["gzip", "br"] as const) {
      const t = await timed(() => injectTimed(comp, { url: monthUrl, headers: { cookie: cookie2, "accept-encoding": enc } }));
      const r = await injectTimed(comp, { url: monthUrl, headers: { cookie: cookie2, "accept-encoding": enc } });
      out.push(`GET /events 42d ${enc.padEnd(4)} median ${t.median.toFixed(1)}ms p95 ${t.p95.toFixed(1)}ms  wire=${fmt(r.res.rawPayload.length)} enc=${r.res.headers["content-encoding"]}`);
    }
    await comp.close();

    // 窗口查询的执行计划。
    const ids = cals.map((c) => c.id);
    const explain = await pg.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT * FROM events
       WHERE calendar_id IN ($1, $2, $3)
         AND starts_at <= '2026-12-28T00:00:00Z'
         AND (ends_at >= '2026-11-16T00:00:00Z' OR rrule IS NOT NULL)
         AND deleted_at IS NULL
       ORDER BY starts_at ASC`,
      ids,
    );
    out.push("", "=== 窗口查询 EXPLAIN ANALYZE ===");
    for (const row of explain.rows as { "QUERY PLAN": string }[]) out.push(row["QUERY PLAN"]);

    // 网页首屏资源图（生产口径：自家 JS 取 _built 压缩版）。
    const pub = "src/public";
    const pick = (rel: string) => {
      const built = `${pub}/_built/${rel}`;
      if (rel.endsWith(".js") && existsSync(built)) return built;
      return `${pub}/${rel}`;
    };
    const layoutAssets = [
      "css/styles.css", "app.css",
      "auth-guard.js", "app.js", "local-time.js",
      "version-check.js", "banners.js", "palette.js",
    ].map(pick);
    const calendarAssets = [
      "lib/toastui-calendar.min.css", "lib/toastui-calendar.min.js",
      "lib/purify.min.js", "lib/nl-parse.js", "event-store.js", "calendar-app.js",
    ].map(pick);
    const total = (files: string[]) => {
      let raw = 0, gz = 0, br = 0;
      for (const f of files) {
        const buf = readFileSync(f);
        raw += buf.length;
        gz += gzipSync(buf, { level: 9 }).length;
        br += brotliCompressSync(buf).length;
      }
      return { raw, gz, br };
    };
    out.push("", "=== 网页资源（生产构建产物）===");
    for (const f of [...layoutAssets, ...calendarAssets]) {
      const buf = readFileSync(f);
      out.push(`${f.replace(`${pub}/`, "").padEnd(38)} raw ${fmt(buf.length).padStart(8)}  gzip ${fmt(gzipSync(buf, { level: 9 }).length).padStart(8)}  br ${fmt(brotliCompressSync(buf).length).padStart(8)}`);
    }
    const lt = total(layoutAssets);
    const ct = total(calendarAssets);
    out.push(`layout 全局（${layoutAssets.length} 请求）: raw ${fmt(lt.raw)} gzip ${fmt(lt.gz)} br ${fmt(lt.br)}`);
    out.push(`日历页专属（${calendarAssets.length} 请求）: raw ${fmt(ct.raw)} gzip ${fmt(ct.gz)} br ${fmt(ct.br)}`);
    out.push(`日历页合计（${layoutAssets.length + calendarAssets.length} 请求）: raw ${fmt(lt.raw + ct.raw)} gzip ${fmt(lt.gz + ct.gz)} br ${fmt(lt.br + ct.br)}`);

    // 静态缓存头（与 server.ts 相同的插件配置 + 同一个 onSend 判定函数）：
    // 带 ?v= 的 URL 应当拿到一年 immutable，没带 v 的保持 7 天，
    // 且条件请求（ETag）仍然工作。
    const statics = await buildRoutedApp(async (a) => {
      await a.register(fastifyStatic, {
        root: path.join(process.cwd(), "src", "public"),
        prefix: "/static/",
        cacheControl: true,
        maxAge: "7d",
      });
      a.addHook("onSend", async (req, reply, payload) => {
        if (reply.statusCode === 200) {
          const cc = cacheControlForVersionedStatic(req.raw.url ?? "");
          if (cc) reply.header("Cache-Control", cc);
        }
        return payload;
      });
    });
    out.push("", "=== 静态缓存头 ===");
    const vUrl = "/static/_built/app.js?v=4af6afc9639c4f6e";
    const r1 = await statics.inject({ url: vUrl });
    out.push(`GET ${vUrl} -> ${r1.statusCode} cache-control: ${r1.headers["cache-control"]}`);
    const r2 = await statics.inject({ url: "/static/_built/app.js" });
    out.push(`GET /static/_built/app.js -> ${r2.statusCode} cache-control: ${r2.headers["cache-control"]}`);
    const r3 = await statics.inject({ url: vUrl, headers: { "if-none-match": r1.headers.etag as string } });
    out.push(`GET ${vUrl} (If-None-Match) -> ${r3.statusCode} cache-control: ${r3.headers["cache-control"]}`);
    const r4 = await statics.inject({ url: "/static/uploads/none.svg?v=4af6afc9639c4f6e" });
    out.push(`GET /static/uploads/none.svg?v=... -> ${r4.statusCode} cache-control: ${r4.headers["cache-control"]}`);
    await statics.close();

    console.log(out.join("\n"));
  }, 300_000);
});
