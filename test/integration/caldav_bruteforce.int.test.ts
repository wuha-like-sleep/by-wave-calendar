// CalDAV 能不能被无限次在线猜密码 —— 从 HTTP 打进去。
//
// 修之前的实情:CalDAV 的每一条路由都写着 config: { rateLimit: false }。
// 那不是「放宽」,是**根本没挂上限流钩子** —— 全站唯一一处完全不受限流
// 约束的认证入口。而两步验证关着时(绝大多数账号的默认状态),CalDAV
// 收的就是账号主密码。服务端不记失败、不触发账号锁定、后台也看不出
// 正在被打。猜中即完整账号沦陷。
//
// 另一半不需要猜中任何密码:每个请求都强制服务端在唯一的主线程上跑一次
// cost 12 的纯 JS bcrypt。用大量**不同**密码并发打(in-flight 去重只合并
// 完全相同的凭据,攻击者不会命中),单进程就能被拖死 —— 网页、API、
// 三端同步一起停。所以节流必须挡在 bcrypt **之前**。
//
// 这一档同时守另一个方向:**别把正常用户挡在外面**。iOS/macOS 日历和
// DAVx⁵ 一次同步打 10-20 个请求、约 10 个并发连接;Apple 的发现流程
// 第一个请求按设计就是不带凭据的 401。这些都不许计入失败。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import { ensureSchema, resetDb, db, schema, pg } from "./harness.js";
import { caldavRoutes } from "../../src/web/caldav.js";
import {
  __resetCalDavThrottleForTest, getCalDavThrottleStats, CALDAV_THROTTLE_LIMITS,
} from "../../src/lib/caldav_throttle.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";

const PASSWORD = "Correct-Horse-9";
const EMAIL = "victim@example.com";

let app: FastifyInstance;

async function buildApp() {
  const a = Fastify({ logger: false });
  a.addHttpMethod("PROPFIND", { hasBody: true });
  a.addHttpMethod("REPORT", { hasBody: true });
  // 和 server.ts:117 同一条正则 —— 少了它,PROPFIND 的 XML body 会在
  // **鉴权之前**被判 415,于是所有「被挡住了吗」的断言测的都是 415。
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

/** 打一次需要认证的 CalDAV 端点。用 PROPFIND / 是因为它是客户端第一个碰的。 */
async function probe(headers: Record<string, string>) {
  return app.inject({
    method: "PROPFIND", url: "/caldav/",
    // content-type 不能省:少了它请求在**鉴权之前**就 415 了,于是所有
    // 「被挡住了吗」的断言测的都是 415,一条都没走到闸门。
    headers: { depth: "0", "content-type": "application/xml", ...headers },
    payload: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>',
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
  // 认证缓存是模块级的,而 resetDb 会把用户删掉重建(新的 uuid)。不清的话
  // 上一条用例缓存下来的那条凭据仍然指着**旧的 user id**,下一条用例里
  // 正确密码会缓存命中 → 按旧 id 查不到人 → 401。
  // 这是夹具问题不是产品问题,但它长得和「节流把人误挡了」一模一样。
  invalidateCalDavAuthCache();
  const { hashPassword } = await import("../../src/lib/password.js");
  await db.insert(schema.users).values({
    email: EMAIL, emailVerified: true, passwordHash: await hashPassword(PASSWORD),
  });
});

describe("CalDAV 撞库要被挡住", () => {
  it("正确密码能通（presence —— 没有这条,下面全都可能是『本来就不通』）", async () => {
    const res = await probe({ authorization: basic(EMAIL, PASSWORD) });
    // 钉死 207 Multi-Status,不写成 not.toBe(401)。写成否定式的话,一个
    // 415(请求根本没走到鉴权)也能让它变绿 —— 这条用例第一版就是这么假绿的。
    expect(res.statusCode, `正确密码没拿到 207。响应: ${res.body.slice(0, 200)}`).toBe(207);
  });

  it("连试若干个不同的错误密码之后被 429 挡住,而且带 Retry-After", async () => {
    const max = CALDAV_THROTTLE_LIMITS.PER_ACCOUNT_MAX;
    const codes: number[] = [];
    for (let i = 0; i < max + 1; i++) {
      const res = await probe({ authorization: basic(EMAIL, `wrong-${i}`) });
      codes.push(res.statusCode);
      if (i === max) {
        expect(res.statusCode, `试了 ${max + 1} 个不同密码还没被挡`).toBe(429);
        expect(res.headers["retry-after"], "429 没带 Retry-After,客户端不知道该等多久").toBeTruthy();
      }
    }
    // 前 max 次必须是 401 而不是 429 —— 否则说明阈值比声明的紧,会误伤。
    expect(codes.slice(0, max).every((c) => c === 401), `前 ${max} 次里出现了非 401: ${codes}`).toBe(true);
  });

  it("被挡住之后,正确密码也进不来（挡的是这个 IP+账号,不是「密码对不对」）", async () => {
    for (let i = 0; i < CALDAV_THROTTLE_LIMITS.PER_ACCOUNT_MAX; i++) {
      await probe({ authorization: basic(EMAIL, `wrong-${i}`) });
    }
    const res = await probe({ authorization: basic(EMAIL, PASSWORD) });
    expect(res.statusCode).toBe(429);
  });

  it("同一个错误密码重复很多次,只算一次（客户端还攥着旧密码猛打的情形）", async () => {
    // 这是最容易把正常用户挡在外面的场景:用户改了密码,手机上那个客户端
    // 还拿着旧的,一次同步就打十几个并发请求。那是**同一个**错误凭据。
    for (let i = 0; i < 20; i++) {
      const res = await probe({ authorization: basic(EMAIL, "stale-password") });
      expect(res.statusCode, `第 ${i + 1} 次就被挡了 —— 同一个旧密码被当成了 20 次不同尝试`).toBe(401);
    }
  });

  it("不带 Authorization 头的那个 401 永远不计入（Apple 的发现流程就是这么开头的）", async () => {
    for (let i = 0; i < 50; i++) {
      const res = await probe({});
      expect(res.statusCode).toBe(401);
    }
    // 打了 50 次无凭据请求之后,正确密码必须照常能进。
    const ok = await probe({ authorization: basic(EMAIL, PASSWORD) });
    expect(
      ok.statusCode,
      "无凭据的探测请求被计入了失败 —— 每次正常同步都会自罚,正常用户会被自己的客户端锁在外面",
    ).not.toBe(429);
  });

  it("认证成功会清掉这个账号的失败记录（打错几次再打对,不该继续背着）", async () => {
    for (let i = 0; i < CALDAV_THROTTLE_LIMITS.PER_ACCOUNT_MAX - 1; i++) {
      await probe({ authorization: basic(EMAIL, `wrong-${i}`) });
    }
    const ok = await probe({ authorization: basic(EMAIL, PASSWORD) });
    expect(ok.statusCode).not.toBe(429);
    expect(ok.statusCode).not.toBe(401);

    // 清干净了的话,又能重新试满一轮而不被挡。
    for (let i = 0; i < CALDAV_THROTTLE_LIMITS.PER_ACCOUNT_MAX - 1; i++) {
      const res = await probe({ authorization: basic(EMAIL, `wrong-again-${i}`) });
      expect(res.statusCode, "成功之后失败计数没被清掉").toBe(401);
    }
  });

  it("不存在的邮箱同样被计入（否则「哪个邮箱会被节流」就成了注册与否的探测器）", async () => {
    const ghost = "nobody@example.com";
    for (let i = 0; i < CALDAV_THROTTLE_LIMITS.PER_ACCOUNT_MAX; i++) {
      const res = await probe({ authorization: basic(ghost, `wrong-${i}`) });
      expect(res.statusCode).toBe(401);
    }
    const res = await probe({ authorization: basic(ghost, "wrong-last") });
    expect(
      res.statusCode,
      "没注册的邮箱不被节流 —— 攻击者据此就能分辨哪些邮箱注册过",
    ).toBe(429);
  });

  it("被挡住这件事在后台是看得见的（以前服务端完全不可见）", async () => {
    for (let i = 0; i < CALDAV_THROTTLE_LIMITS.PER_ACCOUNT_MAX + 2; i++) {
      await probe({ authorization: basic(EMAIL, `wrong-${i}`) });
    }
    const stats = getCalDavThrottleStats();
    expect(stats.blockedRequests, "被挡下的请求没有被计数").toBeGreaterThan(0);
    expect(stats.lockedKeys, "触发锁定这件事没有被计数").toBeGreaterThan(0);
  });
});
