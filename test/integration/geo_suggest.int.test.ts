// 地址联想在线兜底的 HTTP 口径（GET /api/v1/geo/suggest）：
//   一、未登录 → 401（这不是给全网用的匿名代理）；
//   二、登录后查得到 → 服务端整形好的 { suggestions: [{ label }] }；
//   三、上游（Photon）失败 → 仍回 200 + 空列表（客户端静默退回本地）；
//   四、查询太短 / 不合法 → 200 + 空列表，不打上游。
// 上游用本文件起的一个本地 stub 代替真 Photon（GEO_PROVIDER_BASE_URL
// 在 import 路由前指过去）。限流插件是 server.ts 全局挂的，harness 复刻
// 不了，不在这里断言 429——路由 config 里的 rateLimit 与 /search 同款，
// 靠真实服务器装配。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { ensureSchema, resetDb, makeUser, buildRoutedApp, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

// Photon stub：q 含 "boom" 时回 500，其余回一份固定 GeoJSON。
// 必须在 import 路由之前就位：env.ts 在模块加载时就把 PHOTON_BASE_URL
// 定死了，放到 beforeAll 里设就来不及（那样会真打公网 Photon）。
let stubHits = 0;
const stub: Server = createServer((req, res) => {
  stubHits++;
  const url = new URL(req.url ?? "/", "http://stub");
  if ((url.searchParams.get("q") ?? "").includes("boom")) {
    res.writeHead(500).end("upstream exploded");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    features: [
      { properties: { name: "Melbourne Central", street: "La Trobe Street", city: "Melbourne", postcode: "3000", state: "Victoria", country: "Australia" }, geometry: { coordinates: [144.9628, -37.8104] } },
      { properties: { name: "Melbourne Central", street: "La Trobe Street", city: "Melbourne", postcode: "3000", state: "Victoria", country: "Australia" }, geometry: { coordinates: [144.9628, -37.8104] } },
    ],
  }));
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.GEO_PROVIDER_BASE_URL = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;

const { geoRoutes } = await import("../../src/routes/geo.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  stubHits = 0;
  app = await buildRoutedApp(async (a) => { await geoRoutes(a); }, { prefix: "/api/v1" });
});
afterEach(async () => { await app.close(); });

describe("geo suggest (HTTP)", () => {
  it("未登录回 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/geo/suggest?q=Melbourne" });
    expect(res.statusCode).toBe(401);
    expect(stubHits).toBe(0);
  });

  it("登录后回整形好的建议（去重后一条）", async () => {
    const user = await makeUser("geo@example.com");
    const cookie = await loginAs(app, user.id);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/geo/suggest?q=Melbourne%20Central&lang=zh-CN",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      suggestions: [{
        label: "Melbourne Central, La Trobe Street, Melbourne 3000, Victoria, Australia",
        name: "Melbourne Central",
        street: "La Trobe Street",
        city: "Melbourne",
        state: "Victoria",
        postcode: "3000",
        country: "Australia",
        lat: -37.8104,
        lon: 144.9628,
      }],
    });
    expect(stubHits).toBe(1);
    // 同一个查询再问一次：走进程内缓存，不再打上游。
    const again = await app.inject({
      method: "GET",
      url: "/api/v1/geo/suggest?q=Melbourne%20Central&lang=zh-CN",
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);
    expect(stubHits).toBe(1);
  });

  it("上游失败回 200 + 空列表", async () => {
    const user = await makeUser("geo2@example.com");
    const cookie = await loginAs(app, user.id);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/geo/suggest?q=boomtown",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suggestions: [] });
  });

  it("查询太短回 200 + 空列表且不打上游", async () => {
    const user = await makeUser("geo3@example.com");
    const cookie = await loginAs(app, user.id);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/geo/suggest?q=x",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suggestions: [] });
    expect(stubHits).toBe(0);
  });
});
