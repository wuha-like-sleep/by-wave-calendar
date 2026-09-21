// i18n 翻译完整性门禁 + 覆盖率报表。
//
// 跑法:npm run i18n:check   (列出未翻译的键:npm run i18n:check -- --missing)
//
// 英文是源语言(永远 100%)。其余每门语言报「翻了多少 / 覆盖率 / 还差哪些键」。
// 需要它的两个时候:
//   - 新加一门语言:看还有哪些键要翻。
//   - 新功能上线之后给存量语言补翻:只看新长出来的那些键。
//
// ── 这道门以前永远不会失败 ────────────────────────────────────────────────
// 两处叠在一起:
//   1. 不带 --min-coverage 时阈值取 0,`pct < 0` 永远为假,belowThreshold 永远
//      是 false,最后 process.exit(0)。也就是说 `npm run i18n:check` 无论少多少
//      键都退 0。
//   2. CI 那一步写的是 `npm run i18n:check || true` 再加 continue-on-error ——
//      就算它想红也红不出来。
// 于是它一直是个报表,不是门。现在两处都改了。
//
// ── 默认阈值为什么定 100% ─────────────────────────────────────────────────
// 「缺一个键」在线上不报错、不打日志、页面照常打开 —— 只是一个日语用户在满屏
// 日语里看到一句英文。英文回落是**运行时的兜底**,不是**发版的标准**:兜底的
// 意思是「万一漏了别把页面搞崩」,不是「漏了也算过」。
// 阈值定 98 或 95 的实际含义是「我们接受 N 句看不见的英文」,而 N 从来没有人
// 去清。定 100 之后,少一个键当场红,补上就完事;这跟发版说明必须写满六门
// 语言是同一条规矩 —— 那批用户本来能看到自己的话。
// 唯一正当的部分翻译场景是「新加一门语言、边翻边上」,那条路还留着:
//   npm run i18n:check -- --min-coverage=60
// 显式写出来,而不是默认就松。
//
// 退出码:
//   0  — 每门非源语言都达到阈值(默认 100%)。
//   1  — 有语言没达到。
//
// 拼错的键 / 过期的键不归这个脚本管 —— 每个语言字典的类型是
// `Partial<Record<TranslationKey, string>>`,TypeScript 编译期就会报。
// 这里只管「翻没翻」,那是类型系统看不见的。

import { i18nCoverage, LOCALES } from "../src/lib/i18n.js";

const args = process.argv.slice(2);
const showMissing = args.includes("--missing");
const minArg = args.find((a) => a.startsWith("--min-coverage="));
/** 默认 100:见文件头「默认阈值为什么定 100%」。 */
const DEFAULT_MIN_COVERAGE = 100;
const parsedMin = minArg ? Number(minArg.split("=")[1]) : DEFAULT_MIN_COVERAGE;
if (!Number.isFinite(parsedMin) || parsedMin < 0 || parsedMin > 100) {
  // 写错一个字母(--min-coverage=ninety)就变成 NaN,而 `pct < NaN` 永远为假 ——
  // 又是一道静默全绿的门。宁可当场退 1。
  console.error(`✗ --min-coverage 不是 0–100 的数字：${minArg}`);
  process.exit(1);
}
const minCoverage = parsedMin;

const report = i18nCoverage();
const sourceLocale = "en"; // 约定:永远完整的那本字典

console.log(`\ni18n coverage — ${report[0]?.total ?? 0} keys total (source: ${sourceLocale})\n`);

let belowThreshold = false;
const offenders: string[] = [];

for (const r of report) {
  const pct = r.total === 0 ? 100 : Math.round((r.translated / r.total) * 1000) / 10;
  const isSource = r.locale === sourceLocale;
  const bar = makeBar(pct);
  const short = pct < minCoverage;
  const flag = isSource ? "(source)" : short ? `⚠️ below ${minCoverage}%` : "";
  if (!isSource && short) {
    belowThreshold = true;
    offenders.push(`${r.locale}（${pct}%，差 ${r.missing.length} 个键${r.blank.length ? `，其中 ${r.blank.length} 个是空值` : ""}）`);
  }

  console.log(
    `  ${r.locale.padEnd(7)} ${r.label.padEnd(12)} ${bar} ${String(pct).padStart(5)}%  ` +
    `${r.translated}/${r.total}${r.missing.length ? ` · ${r.missing.length} missing` : ""}` +
    `${r.blank.length ? ` · ${r.blank.length} blank` : ""}  ${flag}`,
  );

  if (showMissing && !isSource && r.missing.length > 0) {
    for (const k of r.missing) console.log(`           · ${k}${r.blank.includes(k) ? "   ← 键在，值是空白" : ""}`);
    console.log("");
  }
}

// 「键在、值是空白」单独再喊一遍:它在报表里跟「缺键」混在一起很容易被当成
// 「还没轮到翻」,而它的实际后果是**线上真的渲染成一片空白**,比缺键严重。
const blankTotal = report.reduce((n, r) => n + r.blank.length, 0);
if (blankTotal > 0) {
  console.error(`\n⚠️ 有 ${blankTotal} 处「键在、值是空白」——这些位置在页面上会渲染成空的，不是回落成英文。`);
  for (const r of report) {
    if (r.blank.length === 0) continue;
    for (const k of r.blank) console.error(`   ${r.locale}  ${k}`);
  }
}

if (!showMissing) {
  const anyMissing = report.some((r) => r.locale !== sourceLocale && r.missing.length > 0);
  if (anyMissing) {
    console.log(`\nRun with --missing to list the untranslated keys per locale.`);
  }
}

console.log(
  `\nLocales registered: ${LOCALES.map((l) => l.code).join(", ")}\n` +
  `Add a language: see the "Adding a new language" block in src/lib/i18n.ts.\n`,
);

if (belowThreshold) {
  console.error(`✗ 未达到 ${minCoverage}% 的翻译完整性要求：${offenders.join("、")}`);
  console.error(`  用 npm run i18n:check -- --missing 看具体缺哪些键。`);
  console.error(`  确实要边翻边上(新加一门语言)时，显式放宽：npm run i18n:check -- --min-coverage=60`);
  process.exit(1);
}
process.exit(0);

function makeBar(pct: number): string {
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}
