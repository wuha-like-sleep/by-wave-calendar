// Copy npm-installed vendor libraries into src/public/lib/ so they can be
// self-served. Run via `npm run build:vendor`.
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const targetDir = join(root, "src", "public", "lib");
mkdirSync(targetDir, { recursive: true });

const items = [
  { from: "node_modules/htmx.org/dist/htmx.min.js",                              to: "htmx.min.js" },
  { from: "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js",   to: "simplewebauthn.umd.min.js" },
  // Must be served BEFORE toastui-calendar.min.js: that bundle embeds an old
  // DOMPurify (2.3.8, GHSA XSS bypass) but prefers window.DOMPurify when one is
  // already defined, so loading a current build first overrides the vulnerable
  // copy without patching or forking the vendored bundle.
  { from: "node_modules/dompurify/dist/purify.min.js",                           to: "purify.min.js" },
  { from: "node_modules/@toast-ui/calendar/dist/toastui-calendar.min.js",        to: "toastui-calendar.min.js" },
  { from: "node_modules/@toast-ui/calendar/dist/toastui-calendar.min.css",       to: "toastui-calendar.min.css" },
];

for (const { from, to } of items) {
  const src = join(root, from);
  const dst = join(targetDir, to);
  if (!existsSync(src)) {
    console.error(`[copy-vendor] MISSING: ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`[copy-vendor] ${from} -> src/public/lib/${to}`);
}
console.log("[copy-vendor] done");
