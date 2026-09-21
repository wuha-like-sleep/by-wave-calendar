import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// 守启动顺序：**跑完迁移之前，启动路径上不许读库**。
//
// 真实发生过（2026-09-21）：打印功能开关那段日志在迁移之前 SELECT 了一次
// site_settings。平时没事，直到这一版给 site_settings 加了两列 —— 用新代码去读
// 还没迁移的老库，驱动层直接报「列不存在」，未捕获异常，**服务端根本起不来**。
// 站长看到的是 pm2 反复重启，而那段迁移代码自己的注释写着
// 「开机自动迁移让这类故障不可能发生」。
//
// ── 这条断言管得到什么、管不到什么（别高估它）──────────────────────────
//
// 管得到：迁移那一段被挪到打印开关之后、或挪到 listen 之后。
// 管不到：**在启动路径上新加一处别的读库调用**（比如再写一段
//         `const s = await getSettings()` 放在迁移之前）。
//
// 为什么管不到：要判断「这个调用在模块顶层，还是在某个路由处理函数体里」，
// 就得有语法树。仓库里的 typescript 是 7.x，默认导出只有 version，没有
// createSourceFile 这类 API（test/no_direct_user_insert.test.ts 和
// test/signup_gate_callsites.test.ts 为此各自手写了词法器），而依赖不许动。
// 按文本找 getSettings 会把路由处理函数里那些每请求跑的调用一起算进来 ——
// 那些完全正常，算进来就是一条天天误报的门禁，而天天误报的门禁等于没有。
//
// 所以这里只钉死已经出过事的那个顺序。新增启动期读库的人，请照着上面那段
// 注释的提醒把它放在迁移之后。

const SERVER = new URL("../src/server.ts", import.meta.url).pathname;
const src = readFileSync(SERVER, "utf8");

/** 启动流程里几个位置的锚点。改名了就红 —— 那正是要的：改名的人得来看一眼这条。 */
const MARKERS = {
  migrate: "await runPendingMigrations();",
  // 打印功能开关那一段的唯一标志（它会 SELECT site_settings）。
  featureToggleLog: "[startup] feature toggles",
  listen: "await app.listen(",
} as const;

describe("启动顺序：迁移排在读库和 listen 之前", () => {
  it("三个锚点都还在（少一个说明启动流程被重构过，这条断言要跟着改）", () => {
    for (const [name, needle] of Object.entries(MARKERS)) {
      expect(
        src.includes(needle),
        `server.ts 里找不到锚点 ${name}（"${needle}"）。` +
          "启动流程被改过了 —— 请确认迁移仍然排在所有读库之前，然后更新这条断言的锚点。",
      ).toBe(true);
    }
  });

  it("迁移排在「打印功能开关」之前", () => {
    // 这一条就是 2026-09-21 那次线上起不来的形状。
    expect(
      src.indexOf(MARKERS.migrate),
      "打印功能开关那段会 SELECT site_settings，它排在迁移前面。" +
        "下一个给 site_settings 加列的版本，老库升级上来会直接起不来（列不存在）。",
    ).toBeLessThan(src.indexOf(MARKERS.featureToggleLog));
  });

  it("迁移排在 listen 之前", () => {
    expect(
      src.indexOf(MARKERS.migrate),
      "迁移跑在 listen 之后 —— 服务器会先开始接请求，再去改表结构。",
    ).toBeLessThan(src.indexOf(MARKERS.listen));
  });
});
