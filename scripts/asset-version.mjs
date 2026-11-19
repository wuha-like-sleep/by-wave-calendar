// Compute the static-asset version from file CONTENTS and stamp it into
// <projectRoot>/asset-version.txt, which src/server.ts reads at boot
// (src/lib/asset_version.ts — same algorithm; keep the two in sync).
//
// Why: the version used to be the boot timestamp, so every restart busted
// every ?v= URL and the whole Service Worker cache bucket even when no
// asset had changed. Content addressing makes the version stable across
// rebuilds/restarts and change exactly when an asset changes.
//
// Runs as the last step of `npm run build:assets`, after CSS / NL bundle /
// vendor / minify, so the hash covers the files exactly as they are served.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "src", "public");

// Not build output: user uploads change all the time and must not bust
// the shell cache for everyone.
const EXCLUDED_DIRS = new Set(["uploads"]);

function listAssetFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...listAssetFiles(full, base));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

const files = listAssetFiles(publicDir).sort();
const hash = createHash("sha256");
for (const rel of files) {
  hash.update(rel.split(path.sep).join("/"));
  hash.update("\0");
  hash.update(readFileSync(path.join(publicDir, rel)));
  hash.update("\0");
}
const version = hash.digest("hex").slice(0, 16);
writeFileSync(path.join(root, "asset-version.txt"), version + "\n");
console.log(`[asset-version] ${version} (${files.length} files)`);
