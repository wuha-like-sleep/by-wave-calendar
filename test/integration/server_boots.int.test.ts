// 服务端到底起不起得来。
//
// ── 为什么非有这一条不可 ───────────────────────────────────────────────
//
// 整个测试套件没有任何一处会真的把 src/server.ts 跑起来：集成测试都是
// 自己拿 Fastify 拼一个实例、只注册被测的那一两个 plugin。于是
// **「注册顺序/重复路由/插件参数写错」这一整类问题对门禁是完全透明的** ——
// 全绿，然后站长部署上去，pm2 反复重启，页面全挂。
//
// 这个仓库已经踩过一次：给下载路由加 HEAD 的时候撞上 Fastify 自动生成的
// HEAD，报 "Method 'HEAD' already declared"。本地单文件测试全绿，是人肉
// 启动才发现的。
//
// ── 判据怎么立的 ─────────────────────────────────────────────────────
//
// server.ts 里每一处 app.register 都是 await 的，所以 avvio 是**增量启动**：
// 注册出错会当场抛，而这些 await 全都排在最后那段「跑迁移」之前。
// 因此把 DATABASE_URL 指向一个连不上的端口去启动：
//   · 能走到「跑迁移失败」= 前面所有 plugin / 路由注册都过了 ✅
//   · 在那之前就死于注册错误 = 这个版本部署上去起不来 ❌
// 不需要数据库，也不会真的监听端口（listen 在迁移之后）。
//
// 两条断言缺一不可：既要「没有注册错误」，也要「确实走到了迁移那一步」——
// 只写前一条的话，进程因为任何原因提前死掉都会让它恒绿。

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");

/** 启动真实服务端，收集输出，直到走到迁移那一步或进程退出。 */
async function bootUntilDatabase(timeoutMs = 90_000): Promise<string> {
  return await new Promise<string>((resolve) => {
    const child = spawn("npx", ["tsx", "src/server.ts"], {
      cwd: REPO,
      env: {
        ...process.env,
        // 连不上的库：让启动停在「跑迁移」那一步，前面的注册全部照常执行。
        DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:59999/nonexistent",
        // 迁移在 listen 之前，所以这里其实永远不会真的去占端口。
        PORT: "58731",
        HOST: "127.0.0.1",
        USE_HTTPS: "false",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(out);
    };
    const onData = (b: Buffer) => {
      out += b.toString();
      // 走到迁移 = 注册阶段全过了，不用再等。
      if (/auto-migrate|Failed query|ECONNREFUSED/i.test(out)) setTimeout(finish, 800);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => setTimeout(finish, 200));
    const timer = setTimeout(finish, timeoutMs);
  });
}

describe("这个版本部署上去起得来", () => {
  it("所有 plugin 和路由都注册得上（走得到连库那一步）", async () => {
    const log = await bootUntilDatabase();

    // ① 先看注册错误。**顺序很重要**：注册挂了的时候进程根本走不到连库那一步，
    //    如果先断言 presence，真出了重复路由这种问题，报出来的会是
    //    「这条用例什么也没验到」—— 指着判据本身，而不是指着真凶。
    const registrationErrors = [
      /already declared/i,
      /FST_ERR_DUPLICATED_ROUTE/,
      /FST_ERR_PLUGIN/,
      /AVV_ERR_/,
      /Root plugin has already booted/i,
      /FST_ERR_INSTANCE_ALREADY_LISTENING/,
    ];
    const hit = registrationErrors.find((re) => re.test(log));
    expect(
      hit,
      "服务端在注册 plugin / 路由这一步就挂了 —— 这个版本部署上去起不来，" +
        "站长看到的是 pm2 反复重启、页面全挂。整个测试套件其余部分都看不见这一类问题，" +
        `因为它们都是自己拼实例、只注册被测的那几个 plugin。\n实际输出:\n${log.slice(0, 3000)}`,
    ).toBeUndefined();

    // ② presence：必须真的走到了连库那一步。少了这条，进程因为别的原因提前死掉
    //    （tsx 没装、env 解析不过直接 process.exit）会让上面那条恒绿 ——
    //    一个错误模式都匹配不上，看起来就像「注册得好好的」。
    expect(
      /auto-migrate|ECONNREFUSED|Failed query/i.test(log),
      "启动没走到连库那一步，而且也不是注册错误 —— 说明这条用例根本没验到东西" +
        `（比如进程起都没起来）。实际输出:\n${log.slice(0, 1500)}`,
    ).toBe(true);

  }, 120_000);
});
