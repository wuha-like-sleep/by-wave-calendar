import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 守「5xx 的响应体里永远不带 err.message」。
//
// 这条曾经被修过一次，然后又自己打开了：当时的写法是按 NODE_ENV 分档 ——
// 生产不外送、开发照常显示。听起来合理，但 src/env.ts 里 NODE_ENV 的**默认值
// 是 development**，而这是个自建产品：客户 `npm start` 起来、不专门设这个变量，
// 跑的就是「照常显示」那一档。于是这道防线**默认是关着的**。
//
// 泄的是什么：PG 的报错原文里带 SQL 语句、服务器上的绝对路径、内网 IP 和端口。
// 一条 500 就够把这些送到任何一个访客手上。而且它不报错、不告警 ——
// 只有真出 500 的那一刻才会被看见，而那时已经送出去了。
//
// 判据钉在错误处理器那一段的源码上：这段代码的正确性没有办法靠「跑一个用例」
// 证明（要造出一个真的 5xx 且能看到响应体，得把整个 app 拉起来还得让它出错），
// 而这类「条件写错就默认泄露」的东西最需要的恰恰是不让它悄悄变回去。

const SRC = readFileSync(path.resolve("src/server.ts"), "utf8");

/** 截出 setErrorHandler 的回调体。 */
function errorHandlerBody(): string {
  const at = SRC.indexOf("app.setErrorHandler(");
  expect(at, "找不到 setErrorHandler —— 改写法了？这条断言要跟着改").toBeGreaterThan(-1);
  // 到下一个顶格语句为止就够用了：这段回调里没有顶格的东西。
  const rest = SRC.slice(at);
  const end = rest.search(/\n\/\/ ---- Security headers ----/);
  return end === -1 ? rest.slice(0, 4000) : rest.slice(0, end);
}

const body = errorHandlerBody();

/**
 * 剥掉整行注释再判。
 *
 * 不剥的话会踩这个仓库记过的那个坑：**解释这个坑的注释自己触发门禁**。
 * 上面那段注释里就写着「以前这里按 NODE_ENV 分档」，按原文扫必然命中，
 * 于是修好了它照样红 —— 一条天天误报的门禁和没有门禁一样，人会直接不看它。
 * 换成等量空行而不是删掉，行号不会错位。
 */
const codeOnly = body
  .split("\n")
  .map((l) => (l.trim().startsWith("//") || l.trim().startsWith("*") ? "" : l))
  .join("\n");

describe("5xx 不许把服务端的报错细节送出去", () => {
  it("确实找到了那段处理器，并且它真的在发响应（presence）", () => {
    // 少了这条，下面两条在「截取失败拿到空串」时会因为「什么都没匹配到」
    // 而全部恒成立 —— 这个仓库踩过不止一次。
    expect(body.length, "截出来的处理器体是空的，判据已经瞎了").toBeGreaterThan(200);
    expect(
      /reply\.code\(status\)/.test(body),
      "处理器里没有 reply.code(status) —— 结构变了，这条断言要跟着改",
    ).toBe(true);
  });

  it("响应体里不出现 err.message", () => {
    // err.message 只许出现在 log 里。这里连变量赋值都不许，
    // 因为赋给 safeMessage 之后就分不清它会不会被送出去了。
    const offenders = codeOnly.split("\n").filter((l) => /err\.message/.test(l));
    expect(
      offenders.map((l) => l.trim()),
      "错误处理器里出现了 err.message。它可能含 SQL、服务器绝对路径、内网 IP —— " +
        "记进日志可以，绝不能进响应体。",
    ).toEqual([]);
  });

  it("不再按 NODE_ENV 决定要不要外送细节", () => {
    expect(
      /NODE_ENV/.test(codeOnly),
      "错误处理器里又按 NODE_ENV 分档了。NODE_ENV 的默认值是 development，" +
        "自建客户不设这个变量就跑在「照常显示细节」那一档 —— 这道防线会默认关着。",
    ).toBe(false);
  });
});
