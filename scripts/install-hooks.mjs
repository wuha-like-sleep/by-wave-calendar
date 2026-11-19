#!/usr/bin/env node
// Runs on `npm install` / `npm ci` via the "prepare" script: points git at
// the versioned hooks in scripts/git-hooks so every clone gets the
// commit-msg trace check with no manual step and no extra dependency.
// Silently skips when this is not a git work tree (production installs,
// tarballs, CI checkouts that do not need hooks).

import { execFileSync } from "node:child_process";

try {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (top) {
    execFileSync("git", ["config", "core.hooksPath", "scripts/git-hooks"], {
      stdio: "ignore",
    });
  }
} catch {
  // Not a git checkout: nothing to install.
}
