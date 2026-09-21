// 谁有资格告诉我们「访客是谁」。
//
// req.ip 在这个项目里不是一条日志字段：全站限流的 key（server.ts 的
// keyGenerator）、登录/注册/验证邮件重发的限流、网页注册的人机验证
// （verifyCaptcha(..., req.ip)）、审计日志的 ip 列（lib/audit.ts —— 站长正是
// 拿这一列判断谁在建号）、登录历史的 ip 列（lib/login_history.ts），全部取自它。
//
// 修之前 server.ts 写的是 trustProxy: true。true 的含义是「X-Forwarded-For 链
// 上每一跳都可信」，于是 req.ip 取链条**最左边**那一项 —— 而最左边那一项是客户端
// 自己写进请求头的。配套的 nginx 示例用 $proxy_add_x_forwarded_for（追加，不是
// 覆盖），真实地址只会被追加在伪造值后面，永远排在右边。
//
// 下面每一档都对应一种「配错了会怎样」，而不是对着实现复述一遍。
//   - forged：伪造头必须被忽略。这条在 trustProxy: true 下是红的。
//   - 限流：把后果测出来 —— 换着伪造值连打，必须挡得下。
//   - N 跳：信任名单覆盖到第 N 跳时，第 N 跳写的地址被采纳、更左边的被忽略。
//   - 门禁：server.ts 不许再出现 trustProxy 字面量；nginx 示例的生效行不许
//     再出现 $proxy_add_x_forwarded_for。
//   - 配置：听起来像「全信」的值、以及跳数写法，必须启动就报错而不是静默退化。
//   - 自检：配错时要有一行日志，且不刷屏。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  parseTrustProxy,
  describeTrustProxy,
  trustProxyConfigError,
  createProxyShapeWatcher,
  trustProxyOption,
  type TrustProxyOption,
} from "../src/env.js";

/** 起一个只暴露 req.ip 的最小实例，trustProxy 用被测配置算出来的值。 */
async function ipOf(
  trustProxy: TrustProxyOption,
  headers: Record<string, string>,
  remoteAddress: string,
): Promise<string> {
  const app = Fastify({ logger: false, trustProxy });
  app.get("/whoami", async (req) => ({ ip: req.ip }));
  try {
    const res = await app.inject({ method: "GET", url: "/whoami", headers, remoteAddress });
    return JSON.parse(res.body).ip as string;
  } finally {
    await app.close();
  }
}

function read(rel: string): string {
  return readFileSync(path.resolve(rel), "utf8");
}

// ---------------------------------------------------------------------------
// 伪造的 X-Forwarded-For 不许生效
// ---------------------------------------------------------------------------

describe("客户端不能自己指定自己的来访地址", () => {
  // 默认配置（TRUST_PROXY 不填）= 只信本机回环，也就是宝塔那种
  // proxy_pass http://127.0.0.1:3000 的部署。
  const DEFAULT = parseTrustProxy(undefined);

  it("默认配置下,本机 nginx 追加写法里的伪造值被忽略,采纳 nginx 追加的真实地址", async () => {
    // $proxy_add_x_forwarded_for 的产物：客户端伪造的 9.9.9.9 在左，
    // nginx 见到的真实对端 203.0.113.7 被追加在右。
    const ip = await ipOf(
      DEFAULT,
      { "x-forwarded-for": "9.9.9.9, 203.0.113.7" },
      "127.0.0.1",
    );
    expect(ip).toBe("203.0.113.7");
    expect(ip).not.toBe("9.9.9.9");
  });

  it("直连的客户端塞 X-Forwarded-For 完全无效,req.ip 仍是 TCP 对端地址", async () => {
    const ip = await ipOf(DEFAULT, { "x-forwarded-for": "9.9.9.9" }, "198.18.0.9");
    expect(ip).toBe("198.18.0.9");
  });

  it("TRUST_PROXY=off 时任何 X-Forwarded-For 都被忽略", async () => {
    const ip = await ipOf(
      parseTrustProxy("off"),
      { "x-forwarded-for": "9.9.9.9, 203.0.113.7" },
      "127.0.0.1",
    );
    expect(ip).toBe("127.0.0.1");
  });

  it("不信任的对端也伪造不了 X-Forwarded-Host / Proto", async () => {
    // req.hostname / req.protocol 走的是同一套信任判定。全信时它们也能被伪造,
    // 而它们参与拼外发链接。
    const app = Fastify({ logger: false, trustProxy: parseTrustProxy(undefined) });
    app.get("/o", async (req) => ({ host: req.hostname, proto: req.protocol }));
    const res = await app.inject({
      method: "GET",
      url: "/o",
      headers: { host: "cal.example.com", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      remoteAddress: "198.18.0.9",
    });
    await app.close();
    expect(JSON.parse(res.body).host).toBe("cal.example.com");
    expect(JSON.parse(res.body).proto).toBe("http");
  });
});

// ---------------------------------------------------------------------------
// 后果：限流真的挡得下来
// ---------------------------------------------------------------------------

describe("换着伪造 X-Forwarded-For 连打,限流必须挡得下", () => {
  async function hammer(trustProxy: TrustProxyOption): Promise<number> {
    const app = Fastify({ logger: false, trustProxy });
    await app.register(rateLimit, {
      global: true,
      max: 3,
      timeWindow: "1 minute",
      hook: "preHandler",
      keyGenerator: (req) => req.ip, // 和 server.ts 同一条
    });
    app.get("/limited", async () => ({ ok: true }));
    let blocked = 0;
    try {
      for (let i = 0; i < 12; i++) {
        const res = await app.inject({
          method: "GET",
          url: "/limited",
          headers: { "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` }, // 每次换一个伪造值
          remoteAddress: "127.0.0.1",
        });
        if (res.statusCode === 429) blocked += 1;
      }
    } finally {
      await app.close();
    }
    return blocked;
  }

  it("默认配置下 12 次里挡下 9 次(前 3 次放行)", async () => {
    expect(await hammer(parseTrustProxy(undefined))).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 信任 N 跳
// ---------------------------------------------------------------------------

describe("信任名单覆盖到第 N 跳时,第 N 跳的地址被采纳、更左边的被忽略", () => {
  // 链条（从右往左就是从近到远）：
  //   TCP 对端 127.0.0.1  ← 本机 nginx
  //   203.0.113.7         ← 第 1 跳:nginx 见到的对端(比如 CDN 回源节点)
  //   198.51.100.4        ← 第 2 跳:CDN 见到的对端(真实访客)
  //   9.9.9.9             ← 再往左,谁都能写
  const CHAIN = { "x-forwarded-for": "9.9.9.9, 198.51.100.4, 203.0.113.7" };

  it("只信 1 跳(本机 nginx):采纳第 1 跳,更左边两项忽略", async () => {
    expect(await ipOf(parseTrustProxy("loopback"), CHAIN, "127.0.0.1")).toBe("203.0.113.7");
  });

  it("信 2 跳(本机 nginx + CDN 回源地址):采纳第 2 跳,9.9.9.9 忽略", async () => {
    const ip = await ipOf(parseTrustProxy("loopback,203.0.113.7"), CHAIN, "127.0.0.1");
    expect(ip).toBe("198.51.100.4");
    expect(ip).not.toBe("9.9.9.9");
  });

  it("多信一跳就会开始采纳伪造值 —— 名单写多了同样有代价", async () => {
    // 这一条不是「期望的行为」,是把代价钉在测试里:信任名单每多一项,可被伪造
    // 的位置就往左移一格。写这行是为了让以后往 TRUST_PROXY 里乱加网段的人
    // 看见后果。
    const ip = await ipOf(parseTrustProxy("loopback,203.0.113.7,198.51.100.4"), CHAIN, "127.0.0.1");
    expect(ip).toBe("9.9.9.9");
  });

  it("网段写法和单个地址等价", async () => {
    expect(await ipOf(parseTrustProxy("loopback,203.0.113.0/24"), CHAIN, "127.0.0.1")).toBe("198.51.100.4");
  });
});

// ---------------------------------------------------------------------------
// 门禁:改回去要当场红
// ---------------------------------------------------------------------------

describe("门禁", () => {
  it("server.ts 的 trustProxy 必须来自配置,不许写字面量", () => {
    const src = read("src/server.ts");
    expect(src).toMatch(/trustProxy:\s*trustProxyOption\s*,/);
    expect(src).not.toMatch(/trustProxy:\s*(true|1|\d+)\s*,/);
  });

  it("nginx 示例的生效行不许再出现 $proxy_add_x_forwarded_for", () => {
    // 注释里可以讲它(而且必须讲清为什么不能用),生效行不行。
    const active = read("deploy/bt-panel/nginx.conf.example")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(active).not.toContain("$proxy_add_x_forwarded_for");
    // 反代给 Node 的两个 location 都要覆盖写入真实地址。
    expect(active.match(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/g)?.length).toBe(2);
  });

  it("默认(TRUST_PROXY 不填)就是安全的,不用客户改配置", () => {
    expect(parseTrustProxy(undefined)).toEqual(["loopback"]);
    expect(parseTrustProxy("")).toEqual(["loopback"]);
    // env.ts 导出的生效值也必须是安全形态:绝不是 true。
    expect(trustProxyOption).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 配置校验:配错要启动就报错,不要静默退化
// ---------------------------------------------------------------------------

describe("TRUST_PROXY 的取值校验", () => {
  it("合法取值不报错", () => {
    for (const v of ["loopback", "off", "false", "uniquelocal", "linklocal",
                     "10.8.0.0/24", "203.0.113.7", "2400:cb00::/32",
                     "loopback, 173.245.48.0/20", "10.0.0.0/255.0.0.0", "", undefined]) {
      expect(trustProxyConfigError(v)).toBeNull();
    }
  });

  it("听起来像「全信」的值一律拒绝 —— 全信正是要修的洞", () => {
    for (const v of ["true", "TRUE", "yes", "all", "*", "any"]) {
      const err = trustProxyConfigError(v);
      expect(err).toBeTruthy();
      expect(err).toContain("TRUST_PROXY");
    }
  });

  it("跳数写法被拒绝:fastify 5 对数字型信任是 fail-closed 的", () => {
    // 这不是洁癖。@fastify/proxy-addr 在 getTrustProxyFn 里对
    // `typeof tp === 'number'` 直接 return false。实测 trustProxy: 1 配
    // X-Forwarded-For: "9.9.9.9, 203.0.113.7",req.ip 拿到 127.0.0.1 ——
    // 所有访客被记成同一个地址、共用一个限流桶,而且一声不吭。
    for (const v of ["1", "2", "0"]) {
      expect(trustProxyConfigError(v) ?? "").toContain("跳数");
    }
  });

  it("/0 这种覆盖整个地址空间的网段被拒绝 —— 它等于全信", () => {
    // 不只是洁癖:@fastify/proxy-addr 自己也不收 0.0.0.0/0,会抛
    // "invalid range on address: 0.0.0.0/0",结果是进程直接起不来。
    for (const v of ["0.0.0.0/0", "::/0", "loopback,0.0.0.0/0.0.0.0"]) {
      expect(trustProxyConfigError(v) ?? "").toContain("整个地址空间");
    }
  });

  it("非法地址被点名", () => {
    expect(trustProxyConfigError("loopback,notanip") ?? "").toContain("notanip");
    expect(trustProxyConfigError("10.0.0.0/999") ?? "").toContain("10.0.0.0/999");
    expect(trustProxyConfigError("::1/300") ?? "").toContain("::1/300");
  });

  it("启动日志那句话能分辨出两种形态", () => {
    expect(describeTrustProxy(false)).toContain("不信任任何反向代理");
    expect(describeTrustProxy(["loopback"])).toContain("loopback");
  });
});

// ---------------------------------------------------------------------------
// 自检:配错能被发现,而且不刷屏
// ---------------------------------------------------------------------------

describe("部署形态自检", () => {
  const OPTS = { sample: 4, cooldownMs: 1000 };

  it("代理那一跳没被信任时报出来:req.ip 恒定而链条右端在变", () => {
    const w = createProxyShapeWatcher(OPTS);
    // nginx 在另一台机器上,它的地址不在 TRUST_PROXY 里 → req.ip 恒为 10.8.0.2
    const visitors = ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"];
    const reports = visitors.map((v) =>
      w.note({ ip: "10.8.0.2", forwardedFor: `${v}` }, 0),
    );
    expect(reports.slice(0, 3).every((r) => r === null)).toBe(true);
    const last = reports[3];
    expect(last?.issue).toBe("proxy_header_ignored");
    expect(last?.observedIp).toBe("10.8.0.2");
    expect(last?.message).toContain("TRUST_PROXY");
  });

  it("配置正确时永远不报:req.ip 跟着访客变", () => {
    const w = createProxyShapeWatcher(OPTS);
    for (let i = 0; i < 40; i++) {
      const visitor = `203.0.113.${i % 20}`;
      expect(w.note({ ip: visitor, forwardedFor: visitor }, i * 10)).toBeNull();
    }
  });

  it("一个访客把窗口打满也不报 —— 恒定但链条右端没变,不是配错", () => {
    const w = createProxyShapeWatcher(OPTS);
    for (let i = 0; i < 40; i++) {
      expect(w.note({ ip: "203.0.113.9", forwardedFor: "203.0.113.9" }, i * 10)).toBeNull();
    }
  });

  it("反代没转发地址时报出来:全是回环且一条 X-Forwarded-For 都没有", () => {
    const w = createProxyShapeWatcher(OPTS);
    let report = null;
    for (let i = 0; i < 4; i++) report = w.note({ ip: "127.0.0.1" }, 0) ?? report;
    expect(report?.issue).toBe("proxy_header_missing");
    expect(report?.message).toContain("X-Forwarded-For");
  });

  it("不刷屏:冷却期内同一个问题只出一行", () => {
    const w = createProxyShapeWatcher(OPTS);
    const feed = (t: number) => {
      let out = null;
      for (let i = 0; i < 4; i++) {
        out = w.note({ ip: "10.8.0.2", forwardedFor: `203.0.113.${i}` }, t) ?? out;
      }
      return out;
    };
    expect(feed(0)).not.toBeNull();       // 第一次
    expect(feed(100)).toBeNull();         // 冷却期内:哑火
    expect(feed(500)).toBeNull();
    expect(feed(1000)).not.toBeNull();    // 冷却到期:再出一行
  });

  it("窗口没满不判 —— 零星几个请求不该触发", () => {
    const w = createProxyShapeWatcher({ sample: 200, cooldownMs: 1000 });
    for (let i = 0; i < 199; i++) {
      expect(w.note({ ip: "10.8.0.2", forwardedFor: `203.0.113.${i % 50}` }, 0)).toBeNull();
    }
  });
});
