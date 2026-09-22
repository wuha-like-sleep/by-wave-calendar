import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 守 iOS 的版本号：Debug 和 Release 两套配置必须一致。
//
// ── 为什么需要 ────────────────────────────────────────────────────────
//
// project.pbxproj 里 MARKETING_VERSION 和 CURRENT_PROJECT_VERSION 各出现
// **两次**（Debug 一次、Release 一次）。手改的时候很容易只改到一处 ——
// Xcode 的界面上只显示当前选中的那套，所以看上去是对的。
//
// 分家之后的表现：编译不报错、本地跑起来显示的是一个版本号、而 Archive
// 出来的包是另一个。真正被发现通常是在 App Store Connect 上传时报
// 「build 号必须递增」，或者更晚 —— 用户装上之后版本号和发版说明对不上。
//
// 另外守两条格式：
// · CFBundleVersion（build 号）必须是纯数字且递增，App Store 认这个。
// · CFBundleShortVersionString 必须是 1-3 段、每段是数字，且第一段 > 0。

const PBXPROJ = path.resolve("apps/ios/ByWaveCalendar.xcodeproj/project.pbxproj");
const src = readFileSync(PBXPROJ, "utf8");

function allValues(key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^\\s*${key}\\s*=\\s*([^;]+);`, "gm");
  for (const m of src.matchAll(re)) out.push(m[1]!.trim());
  return out;
}

const marketing = allValues("MARKETING_VERSION");
const build = allValues("CURRENT_PROJECT_VERSION");

describe("iOS 版本号", () => {
  it("两套配置里都读到了（presence）", () => {
    // 少了这条，改了 key 名或者文件结构变了会让下面的比较变成
    // 「空数组里当然没有不一致」，永远绿。
    expect(
      marketing.length,
      "pbxproj 里没读到 MARKETING_VERSION —— 结构变了？这条断言要跟着改",
    ).toBeGreaterThanOrEqual(2);
    expect(build.length, "pbxproj 里没读到 CURRENT_PROJECT_VERSION").toBeGreaterThanOrEqual(2);
  });

  it("Debug 和 Release 的版本号一致", () => {
    expect(
      [...new Set(marketing)],
      "两套配置的 MARKETING_VERSION 不一样 —— 本地跑的和 Archive 出来的会是两个版本，" +
        "而编译一句都不会报。Xcode 界面上只显示当前选中的那套，所以看上去是对的。",
    ).toHaveLength(1);
  });

  it("Debug 和 Release 的 build 号一致", () => {
    expect(
      [...new Set(build)],
      "两套配置的 CURRENT_PROJECT_VERSION 不一样。App Store Connect 认的是这个值，" +
        "分家之后最常见的表现是上传时报「build 号必须递增」。",
    ).toHaveLength(1);
  });

  it("build 号是纯数字", () => {
    // App Store Connect 要求 CFBundleVersion 是一串用点分隔的数字。
    // 这个项目一直用单个整数，保持这个约定 —— 便于「必须比上次大」的人工核对。
    expect(/^\d+$/.test(build[0]!), `build 号不是纯数字：${build[0]}`).toBe(true);
  });

  it("版本号形状合法（1-3 段、第一段 > 0）", () => {
    const v = marketing[0]!;
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v);
    expect(m, `版本号 ${v} 不是 1-3 段的数字形式 —— 苹果不收`).toBeTruthy();
    expect(Number(m![1]), "第一段必须 > 0").toBeGreaterThan(0);
  });
});
