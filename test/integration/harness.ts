// In-memory Postgres (PGlite) harness for integration tests that exercise real
// DB code paths (account merge, identity linking). NOT part of `npm test` — the
// main suite is pure-logic only. Run via `npm run test:int`.
//
// Each test file mocks ../../src/db/client.js to point `db`/`schema` at the
// PGlite instance below, so the production functions run unchanged against it.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import * as schema from "../../src/db/schema.js";

export const pg = new PGlite();
export const db = drizzle(pg, { schema });
export { schema };

let migrated = false;

/** Apply every migration SQL file (idempotent) to build the full schema. */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  const dir = "drizzle/migrations";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${dir}/${f}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  migrated = true;
}

/** Wipe every table between tests. */
export async function resetDb(): Promise<void> {
  await pg.exec(
    `DO $$ DECLARE r RECORD; BEGIN
       FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
         EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
       END LOOP;
     END $$;`,
  );
}

// ---- seed helpers ----
export async function makeUser(email: string, opts: { isAdmin?: boolean; disabledAt?: Date | null } = {}) {
  const [u] = await db
    .insert(schema.users)
    .values({ email, emailVerified: true, passwordHash: "x", isAdmin: opts.isAdmin ?? false, disabledAt: opts.disabledAt ?? null })
    .returning();
  return u!;
}

export async function makeCalendar(ownerId: string, name = "Cal") {
  const [c] = await db
    .insert(schema.calendars)
    .values({ ownerId, name, color: "#000000", timezone: "UTC" })
    .returning();
  return c!;
}

export async function makeEvent(calendarId: string, uid: string) {
  const [e] = await db
    .insert(schema.events)
    .values({ calendarId, uid, summary: "E", startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: new Date("2026-01-01T01:00:00Z") })
    .returning();
  return e!;
}

export async function makeBookingLink(userId: string, calendarId: string, slug: string) {
  const [b] = await db
    .insert(schema.bookingLinks)
    .values({ userId, calendarId, slug, title: slug, weeklyAvailability: {} })
    .returning();
  return b!;
}

export async function makeMembership(calendarId: string, userId: string) {
  const [m] = await db.insert(schema.calendarMembers).values({ calendarId, userId, role: "viewer" }).returning();
  return m!;
}

export async function makeIdentity(userId: string, provider: string, subject: string) {
  const [i] = await db.insert(schema.userIdentities).values({ userId, provider, subject, email: null }).returning();
  return i!;
}

export async function makeDevice(userId: string, label = "Phone") {
  const [d] = await db
    .insert(schema.devices)
    .values({ userId, label, kind: "ios", refreshTokenHash: "h", refreshTokenPrefix: "bwd_abc12345" })
    .returning();
  return d!;
}
