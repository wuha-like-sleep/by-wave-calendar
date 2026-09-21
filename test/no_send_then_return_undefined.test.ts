import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// test/no_send_then_throw.test.ts 的姊妹篇。
//
// 那一档守的是「发了响应再抛异常」—— 那是**致命**的那一种：异常传到全局错误
// 处理器时响应字节已经出去了，处理器返回 undefined，Fastify 转去调内置兜底，
// 兜底第二次 writeHead 再抛一次，从一条没人接的 promise 链里逃出去，进程就死了。
// 那次的表现是「任何人一个普通 GET 就能把服务器打死」。
//
// 这一档守的是同一族里**不致命**的那一种：发了响应再 `return;`（返回 undefined）。
// Fastify 只会打一行
//
//     Reply was already sent, did you forget to "return reply" in the "/app" (GET) route?
//
// 不崩，但每一次未登录访问都刷一行 —— 真正的警告就埋在这些噪音里了。
// 而且形状和致命那一种一模一样：鉴权辅助已经把响应发出去了，处理器却告诉
// Fastify「我没处理」。写法一旦被当成惯例，下一个人照抄的时候就会抄成抛异常那种。
//
// 判据：`if (!x) return;` 的前一行如果是「会发响应的鉴权辅助」，就必须写成
// `return reply;`。

const AUTH_HELPERS = ["requireAdmin", "loadAuthedUser", "basicAuth", "requireUserOrSend"];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(path.resolve(dir), { withFileTypes: true })) {
    const full = `${dir}/${ent.name}`;
    // private/ 是站点私有扩展，不在公开仓库里。
    if (ent.isDirectory()) { if (ent.name !== "private") out.push(...tsFilesUnder(full)); continue; }
    if (ent.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const HELPER_CALL = new RegExp(
  String.raw`const\s+(\w+)\s*=\s*await\s+(?:${AUTH_HELPERS.join("|")})\s*\(`,
);

type Site = { file: string; line: number; text: string; guarded: boolean };

function authGuardSites(): Site[] {
  const sites: Site[] = [];
  for (const file of [...tsFilesUnder("src/web"), ...tsFilesUnder("src/routes")]) {
    const lines = readFileSync(path.resolve(file), "utf8").split("\n");
    lines.forEach((ln, i) => {
      // 整行注释掉的不算（解释这个坑的注释自己会触发判据）。
      if (ln.trim().startsWith("//") || ln.trim().startsWith("*")) return;
      const m = /^\s*if \(!(\w+)\) return(\s+reply)?;\s*$/.exec(ln);
      if (!m) return;
      const varName = m[1]!;
      // 往上找最近的非空行，必须是同名变量接住某个鉴权辅助。
      let j = i - 1;
      while (j >= 0 && !lines[j]!.trim()) j -= 1;
      if (j < 0) return;
      const prev = lines[j]!;
      const call = HELPER_CALL.exec(prev);
      if (!call || call[1] !== varName) return;
      sites.push({ file, line: i + 1, text: ln.trim(), guarded: Boolean(m[2]) });
    });
  }
  return sites;
}

const sites = authGuardSites();

describe("鉴权辅助发了响应之后，处理器必须 return reply", () => {
  it("确实扫到了这些调用点（扫不到说明判据瞎了，不能就这么绿着）", () => {
    // presence。少了这条，辅助函数一改名、正则一失配，下面那条就变成
    // 空集合恒成立 —— 这个仓库踩过不止一次。
    expect(
      sites.length,
      `一个「鉴权辅助 + if (!x) return」的调用点都没扫到。` +
        `辅助函数改名了？（现在认的是 ${AUTH_HELPERS.join(" / ")}）`,
    ).toBeGreaterThanOrEqual(100);
  });

  it("每一处都写成了 return reply", () => {
    const bad = sites.filter((s) => !s.guarded);
    expect(
      bad.map((s) => `${s.file}:${s.line}  ${s.text}`),
      "这些地方鉴权辅助已经把响应发出去了，处理器却返回 undefined。" +
        "Fastify 会认为「你没处理」，每次未登录访问都打一行警告把真正的告警淹掉；" +
        "而且这个写法和曾经把生产打死的「发了再抛异常」是同一族。改成 return reply。",
    ).toEqual([]);
  });
});
