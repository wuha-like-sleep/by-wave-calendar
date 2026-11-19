// CalDAV sync-collection（RFC 6578）回归测试。
//
// 为什么必须从 HTTP 打进去：增量同步的契约全在报文里——令牌长什么样、
// 删掉的事件是不是以 404 条目出现、纪元变了旧令牌是不是被拒。直调内部
// 函数看不见这些。在这之前服务端根本没有 sync-collection，客户端每次
// 同步只能 Depth:1 全量列清单；这里钉的是新实现的行为边界：
//   1. 初次（无令牌）= 全量活事件 + 新令牌；
//   2. 增量只回水位之后动过的：改的给 200、删的给 404、没碰的别出现
//      （水位那一行按 >= 口径会重发一次，这是刻意的，断言里单独点名）；
//   3. 坏令牌 / 纪元不符的令牌 → 403 + valid-sync-token，客户端据此回退全量；
//   4. 只要 etag 的增量不带正文。
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
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeCalendar } from "./harness.js";
import { hashPassword } from "../../src/lib/password.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";
import { bumpCaldavSyncEpoch, reloadSettings } from "../../src/lib/site_settings.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { caldavRoutes } = await import("../../src/web/caldav.js");

const PASSWORD = "sync-collection-pw-123456";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  await resetDb();
  invalidateCalDavAuthCache();
  reloadSettings();
});

async function buildApp(): Promise<FastifyInstance> {
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

type InjectLike = (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>;

function syncBody(token: string | null, withData = true): string {
  const prop = withData ? "<D:getetag/><C:calendar-data/>" : "<D:getetag/>";
  const tokenEl = token === null ? "<D:sync-token/>" : `<D:sync-token>${token}</D:sync-token>`;
  return `<?xml version="1.0" encoding="utf-8" ?>
<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  ${tokenEl}<D:sync-level>1</D:sync-level>
  <D:prop>${prop}</D:prop>
</D:sync-collection>`;
}

function extractToken(body: string): string {
  const m = body.match(/<sync-token>([^<]+)<\/sync-token>/);
  expect(m, "响应里应当带 sync-token").not.toBeNull();
  return m![1]!;
}

async function seedUserWithEvents() {
  const [user] = await db.insert(schema.users)
    .values({ email: "sync-col@example.com", emailVerified: true, passwordHash: await hashPassword(PASSWORD) })
    .returning();
  const cal = await makeCalendar(user!.id, "SyncCal");
  // 三条事件，updatedAt 明确错开：e1 < e2 < e3（e3 是水位行）。
  const mk = async (uid: string, updatedAt: Date) => {
    const [r] = await db.insert(schema.events).values({
      calendarId: cal.id, uid, summary: `Event ${uid}`,
      startsAt: new Date("2026-06-01T10:00:00Z"), endsAt: new Date("2026-06-01T11:00:00Z"),
      createdAt: updatedAt, updatedAt,
    }).returning();
    return r!;
  };
  const e1 = await mk("sc-e1", new Date("2026-05-01T00:00:00Z"));
  const e2 = await mk("sc-e2", new Date("2026-05-02T00:00:00Z"));
  const e3 = await mk("sc-e3", new Date("2026-05-03T00:00:00Z"));
  return { user: user!, cal, e1, e2, e3 };
}

describe("sync-collection", () => {
  it("初次全量 + 增量只回变更（改 200 / 删 404 / 水位行重发 / 没碰的不出现）", async () => {
    const { user, cal, e1, e2 } = await seedUserWithEvents();
    const app = await buildApp();
    const auth = "Basic " + Buffer.from(`${user.email}:${PASSWORD}`).toString("base64");
    const inject = app.inject as unknown as InjectLike;
    const url = `/caldav/${user.id}/${cal.id}/`;
    const report = (token: string | null, withData = true) =>
      inject({ method: "REPORT", url, headers: { authorization: auth, "content-type": "application/xml" }, payload: syncBody(token, withData) });

    // PROPFIND 日历条目要广告 sync-token，客户端才知道能走增量。
    const pf = await inject({ method: "PROPFIND", url, headers: { authorization: auth, depth: "0" } });
    expect(pf.statusCode).toBe(207);
    expect(pf.body).toContain("<sync-token>");
    expect(pf.body).toContain("<sync-collection/>");

    const first = await report(null);
    expect(first.statusCode).toBe(207);
    expect(first.body).toContain("sc-e1.ics");
    expect(first.body).toContain("sc-e2.ics");
    expect(first.body).toContain("sc-e3.ics");
    expect(first.body).toContain("BEGIN:VCALENDAR");
    const token = extractToken(first.body);

    // 无变更再同步一次：只有水位行（e3，updatedAt 恰等于水位）按 >= 口径重发。
    const noop = await report(token);
    expect(noop.statusCode).toBe(207);
    expect(noop.body).toContain("sc-e3.ics");
    expect(noop.body).not.toContain("sc-e1.ics");
    expect(noop.body).not.toContain("sc-e2.ics");
    const token2 = extractToken(noop.body);

    // 改 e1、删 e2（软删 + bump updatedAt，和 cancelEvent 的信号一致）。
    const now = new Date();
    await db.update(schema.events).set({ summary: "Event sc-e1 (renamed)", updatedAt: now }).where(eq(schema.events.id, e1.id));
    await db.update(schema.events).set({ deletedAt: now, updatedAt: now }).where(eq(schema.events.id, e2.id));

    const inc = await report(token2);
    expect(inc.statusCode).toBe(207);
    expect(inc.body).toContain("sc-e1.ics");
    expect(inc.body).toContain("Event sc-e1 (renamed)");
    // 删除以 404 条目出现，href 指向被删的那条。
    expect(inc.body).toMatch(/sc-e2\.ics[\s\S]*?404 Not Found/);
    await app.close();
  });

  it("只要 etag 的增量不带正文", async () => {
    const { user, cal } = await seedUserWithEvents();
    const app = await buildApp();
    const auth = "Basic " + Buffer.from(`${user.email}:${PASSWORD}`).toString("base64");
    const inject = app.inject as unknown as InjectLike;
    const res = await inject({
      method: "REPORT", url: `/caldav/${user.id}/${cal.id}/`,
      headers: { authorization: auth, "content-type": "application/xml" },
      payload: syncBody(null, false),
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain("sc-e1.ics");
    expect(res.body).not.toContain("BEGIN:VCALENDAR");
    await app.close();
  });

  it("坏令牌与纪元不符的令牌都被 403 + valid-sync-token 拒绝", async () => {
    const { user, cal } = await seedUserWithEvents();
    const app = await buildApp();
    const auth = "Basic " + Buffer.from(`${user.email}:${PASSWORD}`).toString("base64");
    const inject = app.inject as unknown as InjectLike;
    const url = `/caldav/${user.id}/${cal.id}/`;
    const report = (token: string | null) =>
      inject({ method: "REPORT", url, headers: { authorization: auth, "content-type": "application/xml" }, payload: syncBody(token) });

    const bad = await report("not-a-real-token");
    expect(bad.statusCode).toBe(403);
    expect(bad.body).toContain("valid-sync-token");

    const first = await report(null);
    const token = extractToken(first.body);
    await bumpCaldavSyncEpoch();
    reloadSettings();
    const stale = await report(token);
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain("valid-sync-token");
    await app.close();
  });
});
