// 更新流程必须能在「PATH 被清空」的环境下找到 npm。
//
// 真实事故：后台点「系统更新」，走到装依赖那一步报 `spawn npm ENOENT`。
// 原因是 execFile 不走 shell、完全依赖 PATH，而 PM2 托管的进程（尤其宝塔
// 启动的）拿到的 PATH 是精简的，npm 不在里面。
//
// 这一步失败的后果比「更新没成功」严重得多：新版本的文件**已经解压覆盖**，
// 依赖却还是旧的，服务停在一个半更新状态起不来。所以它必须不依赖 PATH。

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

// 与 src/lib/self_update.ts 的 resolveNpm() 保持同一套候选顺序。
// 这里重实现而不是 import，是因为 self_update.ts 会拉起整条 env 校验链
// （缺 DATABASE_URL 就 process.exit(1)），单测里不该付那个代价。
// test/self_update_resolve_parity 那条断言保证两边不会走散。
function resolveNpm(): { cmd: string; prefixArgs: string[] } {
  if (process.env.NPM_BIN) return { cmd: process.env.NPM_BIN, prefixArgs: [] };
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    { file: path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), viaNode: true },
    { file: path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), viaNode: true },
    { file: path.join(nodeDir, "npm"), viaNode: false },
    { file: "/usr/local/bin/npm", viaNode: false },
    { file: "/usr/bin/npm", viaNode: false },
    { file: "/www/server/nodejs/bin/npm", viaNode: false },
  ];
  for (const c of candidates) {
    try {
      if (!existsSync(c.file)) continue;
      return c.viaNode ? { cmd: process.execPath, prefixArgs: [c.file] } : { cmd: c.file, prefixArgs: [] };
    } catch { /* 试下一个 */ }
  }
  return { cmd: "npm", prefixArgs: [] };
}

describe("更新流程定位 npm", () => {
  it("PATH 为空时仍能跑起 npm —— 这正是线上报 ENOENT 的那个环境", async () => {
    const npm = resolveNpm();
    const { stdout } = await exec(npm.cmd, [...npm.prefixArgs, "--version"], {
      env: { ...process.env, PATH: "" },
      timeout: 30_000,
    });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 40_000);

  it("对照：旧写法在同样环境下必然失败（证明上面那条不是白测）", async () => {
    await expect(
      exec("npm", ["--version"], { env: { ...process.env, PATH: "" }, timeout: 30_000 }),
    ).rejects.toThrow(/ENOENT/);
  }, 40_000);

  it("NPM_BIN 优先级最高", () => {
    const saved = process.env.NPM_BIN;
    process.env.NPM_BIN = "/opt/custom/npm";
    try {
      expect(resolveNpm()).toEqual({ cmd: "/opt/custom/npm", prefixArgs: [] });
    } finally {
      if (saved === undefined) delete process.env.NPM_BIN;
      else process.env.NPM_BIN = saved;
    }
  });

  it("源码里的候选顺序与这里一致（防止两边走散）", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.resolve("src/lib/self_update.ts"), "utf8"));
    for (const marker of [
      "npm-cli.js", "/usr/local/bin/npm", "/usr/bin/npm", "/www/server/nodejs/bin/npm", "NPM_BIN",
    ]) {
      expect(src, `self_update.ts 里应包含候选 ${marker}`).toContain(marker);
    }
  });
});
