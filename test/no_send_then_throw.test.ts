// 门禁：禁止「先 reply.send()、再 throw」的写法。
//
// 为什么它必须是一条测试而不是一句注释：这个写法把服务器打死过两次
// （2026-08、2026-09）。响应已经在线上时抛出的异常会走到 Fastify 的
// fallbackErrorHandler，那里第二次 writeHead 没有包 try/catch，异常从一条
// 没人接的 promise 链里逃出去 → 未捕获异常 → 进程退出。一个未认证的
// GET /api/calendars 就够了，不需要任何凭据。
//
// 它在本地几乎不可能被发现：精简的 Fastify 实例复现不出来，app.inject 的
// 时序也不同。只有完整应用跑在真实 socket 上才会炸。所以靠人眼 review 和
// 单元测试都拦不住——只能在源码层面禁掉这个形状。
//
// 正确写法见 src/lib/session.ts 的 requireUserOrSend()：发完响应返回 null，
// 调用方 `if (!user) return reply;`。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");

function listSources(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // private/ 是站点私有扩展，不在公开仓库里，但同样受这条约束——扫到就查。
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const SENDS = /\breply\s*(?:\.\s*(?:code|status)\s*\([^)]*\)\s*)?\.\s*send\s*\(/;
const THROWS = /^\s*throw\b/;

describe("源码里不存在「先 send 再 throw」", () => {
  it("扫到了源文件（防止 glob 坏掉后空跑变绿）", () => {
    expect(listSources().length).toBeGreaterThan(30);
  });

  it("每个 reply.send() 之后的 3 行内都没有 throw", () => {
    const offenders: string[] = [];
    for (const file of listSources()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!SENDS.test(line)) return;
        // send 之后若干行内出现 throw，就是这个形状。只看紧邻的几行，
        // 避免把「同一个函数里稍后另有一条独立的 throw」误判进来。
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          if (/^\s*}/.test(lines[j])) break;   // 出了这个块就不算
          if (THROWS.test(lines[j])) {
            offenders.push(
              `${path.relative(process.cwd(), file)}:${i + 1}\n` +
              `    ${line.trim().slice(0, 100)}\n` +
              `    ${lines[j].trim().slice(0, 100)}   ← 就是这里`,
            );
            break;
          }
        }
      });
    }
    expect(
      offenders,
      `发现「先 send 再 throw」——这个写法会让未认证请求打死进程。\n` +
      `改成：发完响应 return null / return reply，让调用方显式退出。\n` +
      `参考 src/lib/session.ts 的 requireUserOrSend()。\n\n${offenders.join("\n\n")}\n`,
    ).toEqual([]);
  });
});
