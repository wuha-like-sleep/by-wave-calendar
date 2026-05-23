// scripts/set-site-flag.ts — used by install.sh to flip boolean site_settings
// flags from the shell without requiring psql on the host.
//
// Usage:
//   node dist/scripts/set-site-flag.js apps_enabled true
//   node dist/scripts/set-site-flag.js api_enabled false
//
// Only boolean flags are supported; anything else exits non-zero.

import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

const ALLOWED = new Set([
  "apps_enabled",
  "api_enabled",
  "embed_enabled",
  "risk_login_enabled",
  "lockout_enabled",
  "force_admin_mfa",
]);

function fail(msg: string): never {
  console.error(`set-site-flag: ${msg}`);
  process.exit(1);
}

async function main() {
  const [, , col, val] = process.argv;
  if (!col || !val) fail("usage: set-site-flag <column> <true|false>");
  if (!ALLOWED.has(col!)) fail(`unknown flag: ${col} (allowed: ${[...ALLOWED].join(", ")})`);
  if (val !== "true" && val !== "false") fail(`bool must be 'true' or 'false', got '${val}'`);
  // Raw SQL because the column name is dynamic; we validated against the
  // allow-list above so no injection.
  await db.execute(sql.raw(`UPDATE site_settings SET ${col} = ${val}, updated_at = now() WHERE id = 1`));
  console.log(`set-site-flag: ${col} = ${val}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("set-site-flag failed:", err);
  process.exit(1);
});
