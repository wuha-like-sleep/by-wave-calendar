import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 守「客户端更新清单真的能随发版包到达服务器」。
//
// ── 为什么这条特别容易漏 ──────────────────────────────────────────────
//
// 这件事需要**两处同时改**，而少改任何一处都不会报错：
//
//   1. scripts/release.sh —— 把清单打进 tarball；
//   2. src/lib/self_update.ts 的 APPLY_FILES —— 上传更新时把它从解压目录
//      覆盖到项目根。
//
// 只改 1：包里有文件，而白名单不认它 —— 上传更新会**验签、解压、体检、
// npm ci、迁移五步全绿**，而文件静默落不了地。站长看到的是一次完美的更新。
// 只改 2：白名单认，但包里根本没有这个文件，那一步 `continue` 掉，同样静默。
//
// 这正是本仓库反复付账的那个形状：跑了、绿了、洞还开着。
//
// ── 判据为什么钉在源码上 ──────────────────────────────────────────────
//
// 理想的判据是「应用完一次真实更新之后，服务器上那份清单的 versionCode 是新的」。
// 那需要打一个真包、起一个真服务、走一遍上传流程 —— 属于 release 流程里的
// 端到端检查，不属于每次 npm test。
// 而这条门禁要防的是「有人改了其中一处、忘了另一处」，源码判据正好对得上，
// 且每次 npm test 都跑。

const RELEASE_SH = readFileSync(path.resolve("scripts/release.sh"), "utf8");
const SELF_UPDATE = readFileSync(path.resolve("src/lib/self_update.ts"), "utf8");

/** 剥掉整行注释 —— 否则上面解释这个坑的注释自己会满足断言。 */
function codeOnly(src: string, commentPrefix: string[]): string {
  return src
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return commentPrefix.some((p) => t.startsWith(p)) ? "" : l;
    })
    .join("\n");
}

const sh = codeOnly(RELEASE_SH, ["#"]);
const ts = codeOnly(SELF_UPDATE, ["//", "*", "/*"]);

const MANIFESTS = [
  "apps/android/releases/latest.json",
  "apps/desktop/releases/latest.json",
];

describe("客户端更新清单要随发版包到达服务器", () => {
  it("两个文件都读到了（presence）", () => {
    // 少了这条，读文件失败会变成「空串里当然找不到」→ 断言恒不成立 →
    // 报错信息看着像真问题，但其实门禁已经瞎了。
    expect(sh.length, "release.sh 读进来是空的").toBeGreaterThan(500);
    expect(ts.length, "self_update.ts 读进来是空的").toBeGreaterThan(2000);
  });

  it("APPLY_FILES 的位置确实还在（presence）", () => {
    // 判据钉在这个常量上。改了名字而这条不跟着改的话，下面会恒成立。
    expect(
      /const APPLY_FILES\s*=/.test(ts),
      "self_update.ts 里找不到 APPLY_FILES —— 改名了？这条断言要跟着改",
    ).toBe(true);
  });

  it("每份清单在 release.sh（打进包）和 APPLY_FILES（应用到盘）里都出现", () => {
    const missing: string[] = [];
    for (const m of MANIFESTS) {
      if (!sh.includes(m)) missing.push(`${m} —— 没被打进 tarball（scripts/release.sh）`);
      if (!ts.includes(m)) missing.push(`${m} —— 不在 APPLY_FILES 里（src/lib/self_update.ts）`);
    }
    expect(
      missing,
      "两处必须同时有。只有其中一处的话，上传更新会五步全绿而清单静默落不了地 —— " +
        "站长看到一次完美的更新，而 /api/app/*/latest 和 /download 页面照旧是旧版本。",
    ).toEqual([]);
  });

  it("清单走的是 APPLY_FILES 而不是 APPLY_DIRS", () => {
    // APPLY_DIRS 对非 dist 的目录会先 rm -rf 整个目标目录。把 "apps" 加进去
    // 会把站长服务器上 apps/ 下的其它东西一起删掉。
    const dirs = /const APPLY_DIRS\s*=\s*\[([^\]]*)\]/.exec(ts)?.[1] ?? "";
    expect(dirs.length, "找不到 APPLY_DIRS —— 结构变了，这条断言要跟着改").toBeGreaterThan(0);
    expect(
      /["']apps/.test(dirs),
      "apps 被加进了 APPLY_DIRS。那一段对非 dist 的目录是先 rm -rf 再拷贝 —— " +
        "会把站长自己放在 apps/ 下的东西整个删掉。清单要走 APPLY_FILES。",
    ).toBe(false);
  });

  it("拷贝前建了父目录", () => {
    // copyFile 不会自己建父目录。package.json 那两个的父目录就是项目根、
    // 一定存在；但 apps/*/releases/ 在 tarball 模式部署上压根不存在 ——
    // 少这一行的话它们会静默失败。
    const at = ts.indexOf("for (const rel of APPLY_FILES)");
    expect(at, "找不到 APPLY_FILES 的拷贝循环").toBeGreaterThan(-1);
    const body = ts.slice(at, at + 600);
    expect(
      /mkdir\(path\.dirname\(to\)/.test(body),
      "APPLY_FILES 的拷贝循环里没有 mkdir(path.dirname(to)) —— " +
        "apps/*/releases/ 这种多层路径在 tarball 模式部署上不存在，copyFile 会失败。",
    ).toBe(true);
  });

  it("不是把整个 apps/ 打进包（那是几百 MB 的构建产物）", () => {
    // apps/ 下有 gradle / Xcode 的构建产物，整个打进去会直接撞上后台上传的
    // 100MB 上限 —— 而那个失败发生在站长上传的时候，不是发版的时候。
    expect(
      /cp\s+-R\s+apps\b/.test(sh),
      "release.sh 在整个拷贝 apps/。里面有 gradle/Xcode 的构建产物，" +
        "包会从 1.6MB 膨胀到几百 MB，撞上上传上限。只打那两个 JSON。",
    ).toBe(false);
  });
});
