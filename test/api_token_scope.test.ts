// 只读 API token 不能写。
//
// 真实事故：这道判断原本写成一个 preHandler 钩子，读 req.authVia —— 而那个
// 标记是 requireUserOrSend() 在 **handler 阶段**才写进 request 的。preHandler
// 永远先跑，所以它读到的永远是 undefined，判断永远不成立，一行日志都没有。
// 后果：管理员发给第三方的「只读」凭据能建、能改、能删日历和事件，
// 面板上还显示着 scope=read。实测过 GET 200 / POST 201。
//
// 现在判断就写在 lib/session.ts 里认出 scope 的那一行旁边，阶段顺序无从出错。
// 这条测试守住两件事：常量表没被改坏，以及那道判断没被挪回钩子里。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SESSION = readFileSync(path.resolve("src/lib/session.ts"), "utf8");
const SERVER = readFileSync(path.resolve("src/server.ts"), "utf8");

describe("只读 token 的写拦截", () => {
  it("判断在 session.ts 里，紧挨着认出 scope 的地方", () => {
    expect(SESSION, "session.ts 里应有 token_is_read_only 的 403").toContain("token_is_read_only");
    // scope 判断与 authVia 赋值必须在同一段代码里——分开就说明又被挪走了
    const scopeIdx = SESSION.indexOf('verified.scope === "read"');
    const tagIdx = SESSION.indexOf('authVia = "api_token:"');
    expect(scopeIdx, "找不到 scope 判断").toBeGreaterThan(-1);
    expect(tagIdx, "找不到 authVia 赋值").toBeGreaterThan(-1);
    expect(Math.abs(scopeIdx - tagIdx), "两者相距过远，判断可能又被挪出了认证函数").toBeLessThan(800);
  });

  it("server.ts 里不再有读 authVia 的 preHandler（那是失效位置）", () => {
    const lines = SERVER.split("\n");
    const offenders: string[] = [];
    lines.forEach((l, i) => {
      if (/authVia/.test(l) && !/^\s*(\/\/|\*)/.test(l)) offenders.push(`server.ts:${i + 1}  ${l.trim()}`);
    });
    expect(
      offenders,
      `server.ts 里出现了对 authVia 的实际读取。\n` +
      `authVia 是 handler 阶段写的，任何 onRequest/preHandler/preValidation 里读它都恒为 undefined。\n` +
      `${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("只读允许的方法里不含任何写动词", () => {
    const m = SESSION.match(/READ_ONLY_METHODS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(m, "找不到 READ_ONLY_METHODS").not.toBeNull();
    const methods = m![1].split(",").map((x) => x.replace(/["'\s]/g, "")).filter(Boolean);
    expect(methods).toContain("GET");
    for (const writeVerb of ["POST", "PUT", "PATCH", "DELETE", "MKCALENDAR", "PROPPATCH"]) {
      expect(methods, `${writeVerb} 是写动词，不能出现在只读白名单里`).not.toContain(writeVerb);
    }
  });
});
