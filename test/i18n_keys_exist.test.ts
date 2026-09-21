import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { en } from "../src/lib/i18n/locales/en.js";

// 守「模板和代码里用到的文案键，语言包里真的有」。
//
// ── 为什么 i18n:check 拦不住这一类 ────────────────────────────────────────
//
// 那道检查比的是「每种语言 vs 英文源」：某种语言少一个键会红。
// 但**一个所有语言都没有的键，它看不见** —— 英文源里也没有，参照系本身就缺。
// 于是覆盖率照样是八门 100%。
//
// 实际踩到的（2026-09-21）：后台那一整套新界面用了 60 个键，
// 八种语言一个都没加。t() 找不到时的回落是 `dict[k] ?? en[k] ?? key`，
// 最后那一级把**键名本身**渲染出去 —— 站长打开页面看到的是
// `adminUsers.col.source` 这样一串字符当表头。不报错，不影响构建，
// 只有真打开那一页的人才会看见。
//
// 这条把参照系换成「模板在用什么」，正好补上那个方向。

const ROOTS = ["src/views", "src/web", "src/routes", "src/lib"];

/** t("key") / tr(req, "key") / translatePlain(locale, "key") —— 只认字面量。
 *  变量形式（t(someKey)）本来就查不了，跳过。 */
const PATTERNS = [
  /\bt\(\s*["']([A-Za-z][\w.]*)["']/g,
  /\btr\(\s*req\s*,\s*["']([A-Za-z][\w.]*)["']/g,
  /translatePlain\([^,)]+,\s*["']([A-Za-z][\w.]*)["']/g,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(path.resolve(dir), { withFileTypes: true })) {
    const full = `${dir}/${ent.name}`;
    // private/ 是站点私有扩展，不在公开仓库里。
    if (ent.isDirectory()) { if (ent.name !== "private") walk(full, out); continue; }
    if (ent.name.endsWith(".ejs") || ent.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

type Use = { key: string; file: string };

function collectUses(): Use[] {
  const uses: Use[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      // 语言包自己不算「使用」。
      if (file.includes("/i18n/locales/")) continue;
      const src = readFileSync(path.resolve(file), "utf8");
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) uses.push({ key: m[1]!, file });
      }
    }
  }
  return uses;
}

const uses = collectUses();
const known = new Set(Object.keys(en));

describe("模板里用到的文案键必须存在", () => {
  it("确实扫到了一批用法（presence）", () => {
    // 少了这条，正则一失配就变成「空集合里没有缺失的键」，永远绿。
    // 这个仓库的门禁踩过不止一次同一个形状。
    expect(
      uses.length,
      "一个 t(\"...\") 都没扫到 —— 正则失配了，这条断言已经瞎了",
    ).toBeGreaterThan(500);
  });

  it("英文源本身是个像样的参照系（presence）", () => {
    expect(known.size, "英文源里的键少得不像话，参照系有问题").toBeGreaterThan(800);
  });

  it("每一个用到的键在英文源里都有", () => {
    const missing = new Map<string, string[]>();
    for (const { key, file } of uses) {
      // `t(key)` 这种把形参名当字面量扫进来的，跳过。
      if (key === "key") continue;
      if (known.has(key)) continue;
      const list = missing.get(key) ?? [];
      if (!list.includes(file)) list.push(file);
      missing.set(key, list);
    }
    const report = [...missing.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, files]) => `${k}  ←  ${files.join(", ")}`);
    expect(
      report,
      "这些键在模板/代码里用着，但英文源里没有 —— 页面上会把键名本身当文字显示给用户。" +
        "i18n:check 拦不住这一类（它只比各语言和英文的差异，参照系本身缺了它看不见）。",
    ).toEqual([]);
  });
});
