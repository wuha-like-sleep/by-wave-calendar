// 静态资源内容哈希版本号：版本必须「内容不变就不变、任一资源变就变」，
// 而且构建脚本（scripts/asset-version.mjs）和服务端读取（src/lib/asset_version.ts）
// 两条路径算出来必须一致 —— 不一致的话构建戳就是个摆设，启动兜底会给出另一个版本。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheControlForVersionedStatic, computeAssetVersion, loadAssetVersion, VERSIONED_STATIC_CACHE_CONTROL } from "../src/lib/asset_version.js";

let root: string;
let pub: string;

function write(rel: string, content: string): void {
  const full = path.join(pub, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "bwc-asset-version-"));
  pub = path.join(root, "src", "public");
  mkdirSync(pub, { recursive: true });
  write("app.js", "console.log('a');\n");
  write("css/styles.css", "body { color: #000; }\n");
  write("lib/vendor.min.js", "/* vendor */\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("computeAssetVersion", () => {
  it("同一份内容算两次结果一样，且是 16 位十六进制", () => {
    const v1 = computeAssetVersion(pub);
    const v2 = computeAssetVersion(pub);
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("改任一资源的内容，版本就变", () => {
    const before = computeAssetVersion(pub);
    write("app.js", "console.log('a2');\n");
    expect(computeAssetVersion(pub)).not.toBe(before);
  });

  it("新增一个资源文件，版本就变", () => {
    const before = computeAssetVersion(pub);
    write("extra.js", "console.log('new');\n");
    expect(computeAssetVersion(pub)).not.toBe(before);
  });

  it("uploads/ 下的变化不影响版本（用户上传不能作废全站壳缓存）", () => {
    const before = computeAssetVersion(pub);
    write("uploads/avatar-1.png", "fake-png-bytes");
    expect(computeAssetVersion(pub)).toBe(before);
  });
});

describe("loadAssetVersion", () => {
  it("有构建戳时读戳，没戳时现算且结果一致", () => {
    const computed = computeAssetVersion(pub);
    // 没戳：现算兜底。
    expect(loadAssetVersion(root)).toBe(computed);
    // 有戳：读戳（戳就是构建时写下的同一个哈希）。
    writeFileSync(path.join(root, "asset-version.txt"), computed + "\n");
    expect(loadAssetVersion(root)).toBe(computed);
  });

  it("戳文件内容损坏时不信任它，回落到现算", () => {
    writeFileSync(path.join(root, "asset-version.txt"), "not-a-version\n");
    expect(loadAssetVersion(root)).toBe(computeAssetVersion(pub));
  });
});

describe("cacheControlForVersionedStatic", () => {
  it("带 v 的静态资源给一年 immutable", () => {
    expect(cacheControlForVersionedStatic("/static/_built/app.js?v=4af6afc9639c4f6e"))
      .toBe(VERSIONED_STATIC_CACHE_CONTROL);
    expect(VERSIONED_STATIC_CACHE_CONTROL).toContain("immutable");
    expect(VERSIONED_STATIC_CACHE_CONTROL).toContain("max-age=31536000");
  });

  it("没带 v（或 v 为空）不接管，保持 fastifyStatic 自己的 7 天", () => {
    expect(cacheControlForVersionedStatic("/static/lib/htmx.min.js")).toBeNull();
    expect(cacheControlForVersionedStatic("/static/app.js?v=")).toBeNull();
    expect(cacheControlForVersionedStatic("/static/app.js?x=1")).toBeNull();
  });

  it("uploads 哪怕误带 v 也绝不给长缓存（管理员上传内容没有版本语义）", () => {
    expect(cacheControlForVersionedStatic("/static/uploads/logo.svg?v=4af6afc9639c4f6e")).toBeNull();
  });

  it("非 /static/ 路径不接管（API、页面 HTML 的缓存语义各有主人）", () => {
    expect(cacheControlForVersionedStatic("/api/v1/events?v=1")).toBeNull();
    expect(cacheControlForVersionedStatic("/app?v=1")).toBeNull();
    expect(cacheControlForVersionedStatic("/staticx/app.js?v=1")).toBeNull();
  });
});

describe("构建脚本与服务端算法一致", () => {
  it("scripts/asset-version.mjs 在同一棵目录上写出的戳 == computeAssetVersion", () => {
    const scriptsDir = path.join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(
      path.resolve(__dirname, "..", "scripts", "asset-version.mjs"),
      path.join(scriptsDir, "asset-version.mjs"),
    );
    execFileSync(process.execPath, [path.join(scriptsDir, "asset-version.mjs")], { stdio: "pipe" });
    const stamped = readFileSync(path.join(root, "asset-version.txt"), "utf8").trim();
    expect(stamped).toBe(computeAssetVersion(pub));
  });
});
