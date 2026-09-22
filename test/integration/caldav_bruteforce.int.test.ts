// CalDAV 的两道闸：**猜密码** 和 **烧 CPU** —— 从 HTTP 打进去。
//
// 这两件事必须分开测。第一版用一个判据（不同凭据个数）同时管两件事，
// 结果 DoS 那一半完全没挡住，而**这个文件的第一版把那个行为钉成了期望**：
// 连发 20 次同一个错误密码、断言每次都是 401，也就是断言「每次都跑了 bcrypt」。
// 门禁是绿的，洞是开的。
//
// 第一版还有一个结构性盲区：**所有用例都是 `for` 里 `await probe(...)` 的串行请求**。
// 而第一版的闸门是 check-then-act（读的计数要等 await 之后才写），并发一波
// 全部穿过去 —— 串行测试永远看不见这件事。所以下面有一条 Promise.all 的用例，
// 它是这个文件里最要紧的一条。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, pg } from "./harness.js";
import { caldavRoutes } from "../../src/web/caldav.js";
import {
  __resetCalDavThrottleForTest, getCalDavThrottleStats, CALDAV_THROTTLE_LIMITS,
} from "../../src/lib/caldav_throttle.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";

const PASSWORD = "Correct-Horse-9";
const EMAIL = "victim@example.com";
const L = CALDAV_THROTTLE_LIMITS;
const BODY = '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>';

let app: FastifyInstance;

async function buildApp() {
  const a = Fastify({ logger: false });
  a.addHttpMethod("PROPFIND", { hasBody: true });
  a.addHttpMethod("REPORT", { hasBody: true });
  // 和 server.ts:117 同一条正则 —— 少了它，PROPFIND 的 XML body 会在
  // **鉴权之前**被判 415，于是所有「被挡住了吗」的断言测的都是 415。
  a.addContentTypeParser(
    /^(application\/xml|text\/xml|text\/calendar)\b/i,
    { parseAs: "string" },
    (_req, body, done) => done(null, body as string),
  );
  await a.register(caldavRoutes);
  await a.ready();
  return a;
}

function basic(email: string, pw: string): string {
  return "Basic " + Buffer.from(`${email}:${pw}`).toString("base64");
}

async function probe(headers: Record<string, string>, remoteAddress?: string) {
  return app.inject({
    method: "PROPFIND", url: "/caldav/",
    ...(remoteAddress ? { remoteAddress } : {}),
    headers: { depth: "0", "content-type": "application/xml", ...headers },
    payload: BODY,
  });
}

beforeAll(async () => {
  await ensureSchema();
  app = await buildApp();
});
afterAll(async () => { await app?.close(); await pg?.close(); });

beforeEach(async () => {
  await resetDb();
  __resetCalDavThrottleForTest();
  // 认证缓存是模块级的，而 resetDb 会把用户删掉重建（新的 uuid）。不清的话
  // 上一条用例缓存下来的那条凭据仍然指着**旧的 user id**，下一条用例里
  // 正确密码会缓存命中 → 按旧 id 查不到人 → 401。
  // 夹具问题不是产品问题，但它长得和「节流把人误挡了」一模一样。
  invalidateCalDavAuthCache();
  const { hashPassword } = await import("../../src/lib/password.js");
  await db.insert(schema.users).values({
    email: EMAIL, emailVerified: true, passwordHash: await hashPassword(PASSWORD),
  });
});

describe("正常用户不许被挡（先钉这一头）", () => {
  it("正确密码拿到 207（presence）", async () => {
    const res = await probe({ authorization: basic(EMAIL, PASSWORD) });
    // 钉死 207，不写成 not.toBe(401)。写成否定式的话，一个 415（请求根本没走到
    // 鉴权）也能让它变绿 —— 这条用例第一版就是这么假绿的。
    expect(res.statusCode, `正确密码没拿到 207。响应: ${res.body.slice(0, 200)}`).toBe(207);
  });

  it("不带 Authorization 头的那个 401 永远不计入（Apple 的发现流程就是这么开头的）", async () => {
    for (let i = 0; i < 50; i++) {
      expect((await probe({})).statusCode).toBe(401);
    }
    const ok = await probe({ authorization: basic(EMAIL, PASSWORD) });
    expect(
      ok.statusCode,
      "无凭据的探测请求被计入了 —— 每次正常同步都会自罚，用户会被自己的客户端锁在外面",
    ).toBe(207);
  });

  it("一次正常同步的并发（同一条正确凭据 × 10）不会被算力闸挡住", async () => {
    // iOS 日历一次同步开约 10 个并发连接，但那 10 个是**同一条凭据**，
    // 走 in-flight 去重只占一个 bcrypt 名额。并发上限是 4，所以一旦把
    // 「每条凭据占一个名额」写错成「每个请求占一个」，这条就会红。
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => probe({ authorization: basic(EMAIL, PASSWORD) })),
    );
    const bad = rs.filter((r) => r.statusCode !== 207).map((r) => r.statusCode);
    expect(bad, `一次正常同步被挡了：${bad}`).toEqual([]);
  });

  it("认证成功会清掉这个邮箱的失败记录", async () => {
    for (let i = 0; i < L.GUESS_MAX - 1; i++) {
      await probe({ authorization: basic(EMAIL, `wrong-${i}`) });
    }
    expect((await probe({ authorization: basic(EMAIL, PASSWORD) })).statusCode).toBe(207);
    for (let i = 0; i < L.GUESS_MAX - 1; i++) {
      const res = await probe({ authorization: basic(EMAIL, `again-${i}`) });
      expect(res.statusCode, "成功之后失败计数没被清掉").toBe(401);
    }
  });
});

describe("闸二：猜密码", () => {
  it("同一个邮箱试满不同密码之后被 429", async () => {
    for (let i = 0; i < L.GUESS_MAX; i++) {
      const res = await probe({ authorization: basic(EMAIL, `wrong-${i}`) });
      expect(res.statusCode, `第 ${i + 1} 次就被挡了，阈值比声明的紧`).toBe(401);
    }
    const res = await probe({ authorization: basic(EMAIL, "wrong-last") });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"], "429 没带 Retry-After，客户端不知道该等多久").toBeTruthy();
  });

  it("换来源地址换不掉 —— 猜密码那一层的键里不含 IP", async () => {
    // 第一版的键是 `${ip}\0${email}`：换个 IP 计数就从 0 开始，
    // 一个 IPv6 /64 就是 2^64 个键，等于没有上限。
    for (let i = 0; i < L.GUESS_MAX; i++) {
      await probe({ authorization: basic(EMAIL, `wrong-${i}`) }, `10.0.0.${i + 1}`);
    }
    const res = await probe({ authorization: basic(EMAIL, "from-another-ip") }, "203.0.113.77");
    expect(res.statusCode, "换个来源地址就把这个账号的猜测计数清零了").toBe(429);
  });

  it("不存在的邮箱同样被计入（否则「哪个邮箱会被节流」就成了注册与否的探测器）", async () => {
    const ghost = "nobody@example.com";
    for (let i = 0; i < L.GUESS_MAX; i++) {
      expect((await probe({ authorization: basic(ghost, `wrong-${i}`) })).statusCode).toBe(401);
    }
    expect(
      (await probe({ authorization: basic(ghost, "wrong-last") })).statusCode,
      "没注册的邮箱不被节流 —— 攻击者据此就能分辨哪些邮箱注册过",
    ).toBe(429);
  });

  it("被网页端撞库锁掉的账号，从 CalDAV 也猜不动", async () => {
    // 修之前 CalDAV 完全不看全站的账号锁定：网页那边锁了，这边照样接着猜。
    await db.update(schema.users)
      .set({ lockedUntil: new Date(Date.now() + 15 * 60 * 1000) })
      .where(eq(schema.users.email, EMAIL));
    const res = await probe({ authorization: basic(EMAIL, "whatever") });
    expect(res.statusCode).toBe(401);
    expect(String(res.body), "锁定状态没有被 CalDAV 认").toContain("locked");
  });
});

describe("闸一：算力（这一半第一版完全没挡住）", () => {
  it("重复同一个错误密码也会被挡 —— 烧 CPU 不需要换密码", async () => {
    // 第一版的判据是「不同凭据个数」：同一个密码重复发，集合永远是 1、
    // 永远不触发，而每一发都跑一次 bcrypt。
    const codes: number[] = [];
    for (let i = 0; i < L.BCRYPT_PER_IP_PER_MIN + 5; i++) {
      const c = (await probe({ authorization: basic(EMAIL, "same-wrong-password") })).statusCode;
      codes.push(c);
      if (c === 429) break;
    }
    expect(
      codes.includes(429),
      `连发 ${codes.length} 次同一个错误密码都没被挡 —— 每一次都跑了一遍 bcrypt。尾部状态码: ${codes.slice(-5)}`,
    ).toBe(true);
  });

  it("并发一波不同密码不能全部穿过去（第一版就是在这儿漏的）", async () => {
    // 第一版是 check-then-act：闸门同步读计数，而写计数排在 `await verify` 之后。
    // 并发一波请求全部在计数还是 0 的时候通过 —— 闸门位置对（在 bcrypt 之前），
    // 判据却在它要守的那个窗口里恒为 0。
    //
    // 这条是这个文件里最要紧的一条：串行的 for 循环永远看不见它。
    const N = 40;
    const rs = await Promise.all(
      Array.from({ length: N }, (_, i) => probe({ authorization: basic(EMAIL, `burst-${i}`) })),
    );
    const passed = rs.filter((r) => r.statusCode !== 429).length;
    expect(
      passed,
      `并发 ${N} 条不同密码，有 ${passed} 条穿过了闸门去跑 bcrypt —— ` +
        `并发上限是 ${L.BCRYPT_INFLIGHT_PER_IP}，不该有这么多`,
    ).toBeLessThan(N);
  });

  it("被算力闸挡下之后，退避一下正常用户还能回来（429 不是封禁）", async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => probe({ authorization: basic(EMAIL, `burst-${i}`) })),
    );
    // 并发名额是瞬时的，爆发结束就还回来了。换一个没被猜过的邮箱，
    // 避开闸二（猜密码）的影响，单独验闸一会自己恢复。
    const { hashPassword } = await import("../../src/lib/password.js");
    await db.insert(schema.users).values({
      email: "other@example.com", emailVerified: true, passwordHash: await hashPassword(PASSWORD),
    });
    const res = await probe({ authorization: basic("other@example.com", PASSWORD) });
    expect(res.statusCode, "爆发结束之后并发名额没还回来").toBe(207);
  });
});

describe("后台看得见", () => {
  it("被挡这件事有计数（以前服务端完全不可见）", async () => {
    for (let i = 0; i < L.GUESS_MAX + 2; i++) {
      await probe({ authorization: basic(EMAIL, `wrong-${i}`) });
    }
    const s = getCalDavThrottleStats();
    expect(s.blockedRequests, "被挡下的请求没有被计数").toBeGreaterThan(0);
    expect(s.lockedAccounts, "「这个账号被猜到上限了」没有被计数").toBeGreaterThan(0);
  });
});
