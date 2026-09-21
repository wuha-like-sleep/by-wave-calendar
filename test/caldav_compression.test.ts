// CalDAV 的 XML 响应在客户端声明压缩时不能变成空文档。
//
// 真实事故：Apple 日历报「目前不能刷新账户」，或者账户加上了却一个日历都没有。
// 根因是 handler 调完 reply.send() 没有 return，Fastify 认为「没人处理」，
// 而响应其实已经发了 —— 走到 @fastify/compress 的 onSend 之后 body 被丢掉，
// 客户端拿到 207 Multi-Status + content-encoding: gzip + **0 字节**。
//
// 只在两个条件同时满足时发作：客户端声明了压缩，且响应超过 compress 的
// 1024 字节阈值。于是小响应（OPTIONS、principal 查询）一切正常，一到
// 「列日历」「列事件」就空 —— 正好是「能连上、密码对、就是没有日历」。
//
// 这个 bug 躲过了两轮人工排查，因为 **curl 默认不发 Accept-Encoding**。
// 所以这条测试的关键不在断言，而在那个请求头：去掉它，测试永远是绿的，
// 而线上永远是坏的。下面第二条用例专门守住这一点。

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import compress from "@fastify/compress";

/** 复刻 src/web/caldav.ts 的 sendXml —— 正确写法是返回 reply。 */
function sendXml(reply: any, body: string, code = 207) {
  return reply.code(code)
    .header("Content-Type", 'application/xml; charset="utf-8"')
    .header("DAV", "1, 2, 3, calendar-access")
    .send(body);
}

// 必须大于 compress 的 1024 阈值，否则根本不会被压缩，也就测不出问题。
const BIG_XML =
  `<?xml version="1.0"?><multistatus xmlns="DAV:">` +
  Array.from({ length: 40 }, (_, i) => `<response><href>/caldav/x/cal-${i}/</href></response>`).join("") +
  `</multistatus>`;

async function buildApp(returnsReply: boolean) {
  const app = Fastify({ logger: false });
  await app.register(compress, { global: true, threshold: 1024 });
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.route({
    method: "PROPFIND", url: "/caldav/home/",
    handler: async (_req, reply) => {
      if (returnsReply) return sendXml(reply, BIG_XML);
      sendXml(reply, BIG_XML);            // ← 出事故的写法：发了但不 return
      return undefined as any;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { app, base: `http://127.0.0.1:${addr.port}` };
}

describe("CalDAV 响应在压缩下不能为空", () => {
  it("XML 样本必须超过压缩阈值（否则这条测试测不到任何东西）", () => {
    expect(Buffer.byteLength(BIG_XML)).toBeGreaterThan(1024);
  });

  it("声明 gzip 时，body 解压后仍然完整", async () => {
    const { app, base } = await buildApp(true);
    try {
      const res = await fetch(`${base}/caldav/home/`, {
        method: "PROPFIND",
        headers: { "Accept-Encoding": "gzip", Depth: "1" },
      });
      expect(res.status).toBe(207);
      const text = await res.text();          // fetch 会自动解压
      expect(text.length, "解压后 body 不能是空的").toBeGreaterThan(0);
      expect((text.match(/<response>/g) || []).length).toBe(40);
    } finally { await app.close(); }
  }, 20_000);

  it("反向验证：漏掉 return 的写法必须让上面那条变红", async () => {
    const { app, base } = await buildApp(false);
    try {
      const res = await fetch(`${base}/caldav/home/`, {
        method: "PROPFIND",
        headers: { "Accept-Encoding": "gzip", Depth: "1" },
      });
      const text = await res.text();
      // 正是线上的形状：状态码对、头对、body 空。
      expect(text.length, "漏 return 的写法本应产出空 body —— 若这里非空，说明测试环境没复现出问题，上面那条绿了也不算数").toBe(0);
    } finally { await app.close(); }
  }, 20_000);

  it("明确不压缩时两种写法都正常 —— 这解释了人工诊断为什么会漏掉它", async () => {
    // 必须显式写 identity：Node 的 fetch（undici）**默认就会带**
    // "accept-encoding: gzip, deflate"，所以「不写这个头」不等于「不压缩」。
    // 真正默认不带的是 curl —— 两轮人工排查全用 curl，所以一路绿灯。
    for (const ok of [true, false]) {
      const { app, base } = await buildApp(ok);
      try {
        const res = await fetch(`${base}/caldav/home/`, {
          method: "PROPFIND",
          headers: { Depth: "1", "Accept-Encoding": "identity" },
        });
        expect((await res.text()).length, `returnsReply=${ok} 在不压缩时应当正常`).toBeGreaterThan(1024);
      } finally { await app.close(); }
    }
  }, 30_000);

  it("源码里 sendXml 的每个调用点都带 return", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.resolve("src/web/caldav.ts"), "utf8");
    const offenders = src.split("\n")
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /\bsendXml\(/.test(l) && !/return sendXml\(|function sendXml/.test(l))
      .map(({ l, n }) => `caldav.ts:${n}  ${l.trim()}`);
    expect(offenders, `sendXml 必须 return，否则压缩下 body 会被丢掉：\n${offenders.join("\n")}`).toEqual([]);
  });
});
