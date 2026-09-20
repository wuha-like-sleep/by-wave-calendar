// 门禁：setErrorHandler 必须注册在任何 await app.register(...) 之前。
//
// Fastify 在注册路由时就把当时的 errorHandler 按值快照进 route context，
// 而 `await app.register(...)` 会当场抽干 boot 队列。于是一个写在所有
// register 之后的 setErrorHandler，对每一条路由都是死代码——**不报任何错**，
// 启动正常、日志干净、测试全绿。
//
// 这不是假想：它在本仓库真实发生过，代价是线上每个 5xx 都把 err.message
// 原样回给客户端（PG 的报错里带 SQL 语句、服务器绝对路径和内网 IP），
// 持续到 2026-09 才被发现。
//
// 这条只能靠源码顺序来守：运行时看不出差别——除非你恰好去打一个会 5xx 的
// 请求，并且恰好注意到响应体形状不对。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SERVER = path.resolve("src/server.ts");

describe("错误处理器的注册顺序", () => {
  const src = readFileSync(SERVER, "utf8");
  const lines = src.split("\n");

  const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const setErrorHandlerLine = idx(/^\s*app\.setErrorHandler\s*\(/);
  const firstRegisterLine = idx(/^\s*await\s+app\.register\s*\(/);

  it("两处锚点都还在（防止改名后空跑变绿）", () => {
    expect(setErrorHandlerLine, "找不到 app.setErrorHandler(").toBeGreaterThan(-1);
    expect(firstRegisterLine, "找不到 await app.register(").toBeGreaterThan(-1);
  });

  it("setErrorHandler 在第一个 await app.register 之前", () => {
    expect(
      setErrorHandlerLine,
      `setErrorHandler 在第 ${setErrorHandlerLine + 1} 行，而第一个 await app.register 在第 ${firstRegisterLine + 1} 行。\n` +
      `注册在 register 之后 = 对每条路由都是死代码，且不会报任何错。\n` +
      `后果：5xx 响应会把 err.message（可能含 SQL、文件路径、内网 IP）直接回给客户端。\n`,
    ).toBeLessThan(firstRegisterLine);
  });
});
