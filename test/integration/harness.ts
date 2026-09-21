// In-memory Postgres (PGlite) harness for integration tests that exercise real
// DB code paths (account merge, identity linking). NOT part of `npm test` — the
// main suite is pure-logic only. Run via `npm run test:int`.
//
// Each test file mocks ../../src/db/client.js to point `db`/`schema` at the
// PGlite instance below, so the production functions run unchanged against it.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import * as schema from "../../src/db/schema.js";

export const pg = new PGlite();
export const db = drizzle(pg, { schema });
export { schema };

let migrated = false;

/** Apply every migration SQL file (idempotent) to build the full schema. */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  const dir = "drizzle/migrations";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${dir}/${f}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  migrated = true;
}

/** Wipe every table between tests. */
export async function resetDb(): Promise<void> {
  await pg.exec(
    `DO $$ DECLARE r RECORD; BEGIN
       FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
         EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
       END LOOP;
     END $$;`,
  );
}

// ---- seed helpers ----
export async function makeUser(email: string, opts: { isAdmin?: boolean; disabledAt?: Date | null } = {}) {
  const [u] = await db
    .insert(schema.users)
    .values({ email, emailVerified: true, passwordHash: "x", isAdmin: opts.isAdmin ?? false, disabledAt: opts.disabledAt ?? null })
    .returning();
  return u!;
}

export async function makeCalendar(ownerId: string, name = "Cal") {
  const [c] = await db
    .insert(schema.calendars)
    .values({ ownerId, name, color: "#000000", timezone: "UTC" })
    .returning();
  return c!;
}

export async function makeEvent(calendarId: string, uid: string) {
  const [e] = await db
    .insert(schema.events)
    .values({ calendarId, uid, summary: "E", startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: new Date("2026-01-01T01:00:00Z") })
    .returning();
  return e!;
}

export async function makeBookingLink(userId: string, calendarId: string, slug: string) {
  const [b] = await db
    .insert(schema.bookingLinks)
    .values({ userId, calendarId, slug, title: slug, weeklyAvailability: {} })
    .returning();
  return b!;
}

export async function makeMembership(calendarId: string, userId: string) {
  const [m] = await db.insert(schema.calendarMembers).values({ calendarId, userId, role: "viewer" }).returning();
  return m!;
}

export async function makeIdentity(userId: string, provider: string, subject: string) {
  const [i] = await db.insert(schema.userIdentities).values({ userId, provider, subject, email: null }).returning();
  return i!;
}

export async function makeDevice(userId: string, label = "Phone") {
  const [d] = await db
    .insert(schema.devices)
    .values({ userId, label, kind: "ios", refreshTokenHash: "h", refreshTokenPrefix: "bwd_abc12345" })
    .returning();
  return d!;
}

// ---------------------------------------------------------------------------
// 以下为追加：从 HTTP 真实打进去所需的两件东西。上面已有的导出一个字没动
// （account_merge / events_query / external_idp / identities / caldav_alarms
//  五个文件都在用）。
// ---------------------------------------------------------------------------
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { newSessionId } from "../../src/lib/ids.js";

// 测试内部自洽即可：签名和验签都在同一个实例上（@fastify/cookie 注册时的 secret
// 同时供 reply.setCookie(signed) 和 req.unsignCookie 使用）。不读 env.SESSION_SECRET
// 是为了让这套测试在没有 .env 的 CI 上也能跑。
const TEST_COOKIE_SECRET = "integration-test-cookie-secret-32-chars-min";

// session.ts 里的 COOKIE_NAME 没有导出。写死在这里，配一条断言（见
// reminders_http.int.test.ts 的「会话 cookie 名」那条）盯着它别和源码脱节。
export const SESSION_COOKIE_NAME = "bwc_sid";

/**
 * 起一个只挂被测路由的真 Fastify 实例。
 *
 * 为什么不直接 import src/server.ts：那是个 top-level await 的副作用脚本，
 * import 的一瞬间就去连真库、监听端口、拉起 cron。这里只复刻会话鉴权真正依赖的
 * 那一件事 —— 用一个 secret 注册 @fastify/cookie，requireUserOrSend 走的
 * req.unsignCookie 才有东西可用。
 *
 * **它复刻不了的**：server.ts 在全局挂的 CSRF 钩子、rate limit、helmet、
 * onResponse 审计。测到这些的断言不能用这个函数。
 */
export async function buildRoutedApp(
  register: (app: FastifyInstance) => Promise<void> | void,
  opts: { prefix?: string } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: TEST_COOKIE_SECRET });
  await app.register(async (scoped) => { await register(scoped); }, { prefix: opts.prefix ?? "" });
  await app.ready();
  return app;
}

/**
 * 造一个「已登录的浏览器」：真的往 sessions 表插一行，返回可直接塞进
 * headers.cookie 的那个串。走的是生产同一条路 —— loadSession 会去查这一行、
 * 查 expiresAt、查 users.disabledAt，没有任何一处被绕过。
 */
export async function loginAs(app: FastifyInstance, userId: string): Promise<string> {
  const id = newSessionId();
  await db.insert(schema.sessions).values({
    id,
    userId,
    mfaSatisfied: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(app.signCookie(id))}`;
}
