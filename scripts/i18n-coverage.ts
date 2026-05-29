// i18n translation coverage report.
//
// Run: npm run i18n:check
//
// English is the source of truth (always 100%). For every other locale this
// prints how many keys are translated, the coverage %, and (with --missing)
// the exact list of keys still falling back to English. This is the tool you
// use when:
//   - Adding a new language: see the full list of keys you still need to do.
//   - Topping up an existing language after new features land: see only the
//     newly-added keys that haven't been translated yet.
//
// Exit codes:
//   0  — every NON-source locale is at or above the threshold (default 0%,
//        i.e. always passes; partial translations are allowed by design).
//   1  — a locale is below --min-coverage (use in CI to enforce a floor,
//        e.g. `npm run i18n:check -- --min-coverage=90`).
//
// Typos / stale keys are NOT this script's job — TypeScript already catches
// them at compile time because each locale dict is typed
// `Partial<Record<TranslationKey, string>>`. This script is purely about
// completeness (how much is translated), which the type system can't see.

import { i18nCoverage, LOCALES } from "../src/lib/i18n.js";

const args = process.argv.slice(2);
const showMissing = args.includes("--missing");
const minArg = args.find((a) => a.startsWith("--min-coverage="));
const minCoverage = minArg ? Number(minArg.split("=")[1]) : 0;

const report = i18nCoverage();
const sourceLocale = "en"; // by convention; the dict that's always complete

console.log(`\ni18n coverage — ${report[0]?.total ?? 0} keys total (source: ${sourceLocale})\n`);

let belowThreshold = false;

for (const r of report) {
  const pct = r.total === 0 ? 100 : Math.round((r.translated / r.total) * 1000) / 10;
  const isSource = r.locale === sourceLocale;
  const bar = makeBar(pct);
  const flag = isSource
    ? "(source)"
    : pct < minCoverage
      ? `⚠️ below ${minCoverage}%`
      : "";
  if (!isSource && pct < minCoverage) belowThreshold = true;

  console.log(
    `  ${r.locale.padEnd(7)} ${r.label.padEnd(12)} ${bar} ${String(pct).padStart(5)}%  ` +
    `${r.translated}/${r.total}${r.missing.length ? ` · ${r.missing.length} missing` : ""}  ${flag}`,
  );

  if (showMissing && !isSource && r.missing.length > 0) {
    for (const k of r.missing) console.log(`           · ${k}`);
    console.log("");
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
  console.error(`✗ One or more locales are below the --min-coverage=${minCoverage}% floor.`);
  process.exit(1);
}
process.exit(0);

function makeBar(pct: number): string {
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}
