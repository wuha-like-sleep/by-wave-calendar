import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 守桌面端的版本号：四处必须一致，而且安装器的版本号**不许写死**。
//
// ── 为什么需要这条 ────────────────────────────────────────────────────
//
// `nativeDistributions.packageVersion` 曾经硬编码成 "1.0.0"，后果是
// **Windows 用户从装上第一版起就没收到过任何更新**，而程序每次都告诉他们
// 「更新成功」。
//
// jpackage 的 ProductCode 是从版本号算出来的：
//   ProductCode = UUIDv3( MD5("ProductCode/<vendor>/<appName>/<version>") )
// 版本号钉死 → 每一版的 ProductCode 逐字节相同 → msiexec 认为「同一个产品
// 已经装过了」，既不升级也不并排安装；而 Upgrade 表的可升级区间是
// 「严格小于 1.0.0」，装着 1.0.0 的机器正好掉在两行中间的缝里。
// 安装命令没带 REINSTALL=ALL，所以维护模式一个文件都不换，大概率还返回 0 ——
// 更新器于是写「update ok」，把**旧版** exe 拉起来。
//
// 这个坑最难发现的地方：**构建照常成功，产物看起来完全正常**。
// 本机 DMG 能装能跑，CI 绿，签名公证全过。只有真去一台装过旧版的 Windows
// 上装一次才看得见。所以必须有东西盯着源码本身。
//
// 判据钉在源码上而不是产物上：要从产物验，得解 MSI 的 OLE 复合文档再解码
// MSI 表，那套东西只能在有相应工具的机器上跑；而这条要防的是「有人又把
// 那一行加回来」，源码判据正好对得上，而且在每次 npm test 时都跑。

const GRADLE = path.resolve("apps/desktop/build.gradle.kts");
const BUILDINFO = path.resolve(
  "apps/desktop/src/main/kotlin/cn/bywave/calendar/desktop/BuildInfo.kt",
);
const MANIFEST = path.resolve("apps/desktop/releases/latest.json");

/** 剥掉整行注释再判 —— 不剥的话，上面解释这个坑的注释自己会触发门禁。
 *  本仓库为这件事红过一次：一条天天误报的门禁和没有门禁是一样的。 */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

const gradleSrc = readFileSync(GRADLE, "utf8");
const gradle = codeOnly(gradleSrc);
const buildInfo = codeOnly(readFileSync(BUILDINFO, "utf8"));
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  versionCode: number; versionName: string;
};

const gradleVersion = /^version\s*=\s*"([^"]+)"/m.exec(gradle)?.[1];
const nameInBuildInfo = /VERSION_NAME\s*=\s*"([^"]+)"/.exec(buildInfo)?.[1];
const codeInBuildInfo = Number(/VERSION_CODE\s*=\s*(\d+)/.exec(buildInfo)?.[1]);

describe("桌面端版本号", () => {
  it("三个文件都读到了（presence）", () => {
    // 少了这条，任何一个正则失配都会让下面的比较变成 undefined === undefined，
    // 永远绿。本仓库的门禁踩过不止一次同一个形状。
    expect(gradleVersion, "build.gradle.kts 里没读到 version = \"...\"").toBeTruthy();
    expect(nameInBuildInfo, "BuildInfo.kt 里没读到 VERSION_NAME").toBeTruthy();
    expect(Number.isFinite(codeInBuildInfo), "BuildInfo.kt 里没读到 VERSION_CODE").toBe(true);
  });

  it("安装器版本号不许写死", () => {
    // Compose 的回落链是 format-specific → OS-specific → packageVersion →
    // project.version。不设 packageVersion 就自动拿 project.version；
    // 一旦写死，Windows 的自动更新就静默失效。
    const hit = /\bpackageVersion\s*=/.exec(gradle);
    expect(
      hit ? gradle.slice(Math.max(0, hit.index - 40), hit.index + 60).trim() : null,
      "build.gradle.kts 里又出现了 packageVersion = ...。" +
        "写死它会让每一版 MSI 的 ProductCode 相同 —— msiexec 认为「同一个产品已装过」，" +
        "既不升级也不并排安装，而更新器还会报「更新成功」并把旧版拉起来。" +
        "删掉这一行，让它回落到 project.version。",
    ).toBeNull();
  });

  it("build.gradle 的 version 和 BuildInfo.VERSION_NAME 一致", () => {
    expect(nameInBuildInfo, "两处版本号不一致 —— 装出来的包和程序里显示的会对不上").toBe(gradleVersion);
  });

  it("更新清单的 versionCode 和 BuildInfo.VERSION_CODE 一致", () => {
    // 更新器比的就是 versionCode。两处脱节的后果是「检查更新」误报
    // 「已是最新版本」——1.0.13 之前就是这么坏的。
    expect(
      manifest.versionCode,
      "清单里的 versionCode 和 BuildInfo 对不上 —— 更新器比的就是这个值，" +
        "脱节会让所有人的「检查更新」误报「已是最新版本」",
    ).toBe(codeInBuildInfo);
  });

  it("更新清单的 versionName 和 BuildInfo.VERSION_NAME 一致", () => {
    expect(manifest.versionName).toBe(nameInBuildInfo);
  });

  it("版本号形状满足三个平台的交集（第一段 > 0 的三段式）", () => {
    // Windows：正好 3 段，MAJOR 0-255 / MINOR 0-255 / BUILD 0-65535。
    // macOS：1-3 段，第一段必须 > 0。
    // Linux deb：宽松得多。
    // 交集就是「第一段 > 0 的三段式」。写错的话是打包时才炸，而那时
    // 通常已经在发版流程里了。
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(gradleVersion));
    expect(m, `版本号 ${gradleVersion} 不是三段式 —— Windows 的 MSI 只收正好 3 段`).toBeTruthy();
    const [maj, min, bld] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(maj, "第一段必须 > 0 —— macOS 那边的硬约束").toBeGreaterThan(0);
    expect(maj, "MAJOR 上限 255（Windows）").toBeLessThanOrEqual(255);
    expect(min, "MINOR 上限 255（Windows）").toBeLessThanOrEqual(255);
    expect(bld, "BUILD 上限 65535（Windows）").toBeLessThanOrEqual(65535);
  });
});
