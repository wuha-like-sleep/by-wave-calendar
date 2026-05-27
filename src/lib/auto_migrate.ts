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
import { sql } from "drizzle-orm";
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

  // Try drizzle's normal migrator first. May fail if production's
  // __drizzle_migrations table is out of sync with our committed
  // _journal.json (which happens any time someone runs `db:push` or
  // a hand ALTER TABLE without going through migrate). Failures here
  // shouldn't block startup — defensiveSchemaPatches() below catches
  // the columns we care about regardless.
  try {
    const t0 = Date.now();
    await migrate(db, { migrationsFolder });
    const elapsed = Date.now() - t0;
    if (elapsed > 50) {
      console.log(`[auto-migrate] applied pending migrations in ${elapsed}ms`);
    }
  } catch (err) {
    console.error("[auto-migrate] drizzle migrator failed — falling through to defensive patches:", err);
  }

  // Defensive schema patches. Pure raw SQL with `IF NOT EXISTS` clauses
  // — fully idempotent, runs on every boot, costs ~5ms total. This is
  // the safety net for the class of bugs where drizzle's migrator state
  // disagrees with the actual DB schema (because of historical db:push
  // usage, manual hotfixes, lost _journal.json snapshots, etc).
  //
  // Add a line here whenever a release adds a column the runtime code
  // depends on. The migration file is still the canonical record for
  // fresh installs; this is just the "fix the broken-deploy case"
  // safety net. Remove entries once they've been live long enough that
  // no surviving production DB could still be missing the column.
  try {
    const t0 = Date.now();
    await db.execute(sql`
      ALTER TABLE booking_links
        ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT true
    `);
    const elapsed = Date.now() - t0;
    if (elapsed > 50) {
      console.log(`[auto-migrate] defensive schema patches applied in ${elapsed}ms`);
    }
  } catch (err) {
    console.error("[auto-migrate] defensive patches FAILED — /app/booking-links may 500:", err);
  } finally {
    await client.end({ timeout: 5 });
  }
}
