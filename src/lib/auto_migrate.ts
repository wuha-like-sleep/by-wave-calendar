// Auto-apply pending drizzle migrations at server boot.
//
// Why this exists: we shipped v1.3.10 (notifyEmail column on
// booking_links) and the production server did a normal
// `git pull && pm2 reload` without running `npm run migrate` first.
// Result: every hit on /app/booking-links 500'd with
// `column "notify_email" does not exist`. Easy mistake — install.sh
// runs migrate, but in-place rolling reloads don't go through
// install.sh. Auto-migrate-on-boot makes the failure class impossible
// to hit again.
//
// Safe properties:
//   - drizzle's migrator skips already-applied migrations (tracked in
//     a __drizzle_migrations table), so this is a no-op on normal
//     restarts — costs one SELECT per boot.
//   - Migrations are written with `ADD COLUMN IF NOT EXISTS` / similar
//     defenses, so even if the migrator gets confused about which were
//     applied (e.g. a snapshot was lost), the SQL itself is idempotent.
//   - On migration failure we log loudly and continue starting up. A
//     partially-broken endpoint (the one that needs the new column) is
//     better than zero availability.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { env } from "../env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runPendingMigrations(): Promise<void> {
  // Use a separate single-connection client for migrations — the main
  // pool shouldn't be pinned during the (typically <1s) migration run,
  // and after we close this client the pool keeps serving requests.
  const client = postgres(env.DATABASE_URL, {
    max: 1,
    prepare: false,
  });
  const db = drizzle(client);

  // Resolve the migrations folder relative to the project root rather
  // than __dirname — in dev (tsx) we're in src/lib/, in prod build
  // we're in dist/src/lib/. Walk up to the package root either way.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/lib/auto_migrate.ts → src/lib → src → projectRoot
  // dist/src/lib/auto_migrate.js → dist/src/lib → dist/src → dist → projectRoot
  const projectRoot = path.resolve(
    here,
    here.includes(`${path.sep}dist${path.sep}`) ? "../../.." : "../..",
  );
  const migrationsFolder = path.join(projectRoot, "drizzle", "migrations");

  try {
    const t0 = Date.now();
    await migrate(db, { migrationsFolder });
    const elapsed = Date.now() - t0;
    // Only log when something actually happened — drizzle is silent on
    // no-op runs, so seeing the line in logs is a signal of activity.
    // 50ms is a reasonable "nothing to apply" threshold; real migrations
    // typically take 200ms+ for any ADD COLUMN against a non-trivial table.
    if (elapsed > 50) {
      console.log(`[auto-migrate] applied pending migrations in ${elapsed}ms`);
    }
  } catch (err) {
    // Don't fatally crash the server. Logging here goes to pm2's log
    // file where the admin can find + recover (drop column manually,
    // hand-edit __drizzle_migrations, re-run migrate, etc).
    console.error("[auto-migrate] failed — continuing startup anyway:", err);
  } finally {
    await client.end({ timeout: 5 });
  }
}
