// Compile the natural-language parser (src/lib/nl_parse.ts) into a browser
// bundle at src/public/lib/nl-parse.js, exposing window.BWC_NL.parse().
//
// Why: the web app needs the parser client-side for the LIVE preview under the
// quick-add box (it re-parses on every keystroke, so a server round-trip is the
// wrong shape). It used to be a hand-maintained 231-line copy inside
// calendar-app.js, which meant every parser fix had to be made twice and every
// missed sync was a bug users could see. Now there is one source of truth and
// the copy is generated.
//
// Output is IIFE, no imports, ES2020 — the same baseline the rest of
// src/public/ targets. It lands in src/public/lib/ (gitignored, same as the
// other vendored bundles) and is served from /static/lib/nl-parse.js.

import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src", "public", "lib");
const outFile = path.join(outDir, "nl-parse.js");

mkdirSync(outDir, { recursive: true });

// A tiny entry that re-exports the parser onto window, so the bundle is
// usable from a plain <script> tag without a module loader.
const entry = path.join(root, "src", "lib", "nl_parse.browser-entry.ts");
writeFileSync(entry, `
import { parseNaturalLanguageEvent } from "./nl_parse.js";
declare global { interface Window { BWC_NL?: { parse: typeof parseNaturalLanguageEvent } } }
window.BWC_NL = { parse: parseNaturalLanguageEvent };
`.trimStart());

try {
  await build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: process.env.BWC_SKIP_MINIFY !== "1",
    legalComments: "none",
    logLevel: "warning",
  });
} finally {
  // The entry only exists for the duration of the build.
  const { rmSync } = await import("node:fs");
  rmSync(entry, { force: true });
}

// Fail loudly rather than shipping an empty file: a silently-broken bundle
// would degrade the live preview to "nothing happens as you type", which is
// easy to miss in review and annoying to debug from a bug report.
const size = readFileSync(outFile).length;
if (size < 1000) {
  console.error(`[nl-bundle] ERROR: ${outFile} is only ${size} bytes — the build produced nothing usable.`);
  process.exit(1);
}
if (!readFileSync(outFile, "utf8").includes("BWC_NL")) {
  console.error("[nl-bundle] ERROR: bundle does not define window.BWC_NL.");
  process.exit(1);
}
console.log(`[nl-bundle] src/lib/nl_parse.ts -> src/public/lib/nl-parse.js (${(size / 1024).toFixed(1)} KB)`);
