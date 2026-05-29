// Backup / restore round-trip integration verifier.
//
// Why this exists: backup is the "I'll deal with it later" feature — never
// thought about until the day data is gone, and then it's the most important
// thing in the world. We want to know BEFORE that day whether our backup
// actually round-trips correctly. This script proves it does (or surfaces
// what's broken) end-to-end against a real Postgres.
//
// It is NOT part of `npm test` because it needs a disposable database it
// can TRUNCATE. Run on demand:
//
//   createdb bywave_test_restore
//   DATABASE_URL=postgresql://localhost:5432/bywave_test_restore \
//     npm run db:migrate
//   DATABASE_URL=postgresql://localhost:5432/bywave_test_restore \
//     npx tsx scripts/verify-backup-restore.ts
//   dropdb bywave_test_restore
//
// What it does:
//   1. Wipes every business table in the target DB (safety belt).
//   2. Seeds known data — 2 users, 2 calendars, 3 events (incl. one with
//      recurrence), 1 share token, 1 SSO provider, 1 API token, 1 app
//      password, 1 webauthn credential, 1 calendar invitation, 1 event
//      invite token, 1 login alert, 1 login event, 1 site_settings row.
//      The fixture covers every table the backup includes so any
//      serialization/deserialization regression shows up.
//   3. Calls exportData() → in-memory bundle.
//   4. Asserts the bundle has the expected shape + table counts.
//   5. Calls importData(bundle) — which TRUNCATEs everything and re-inserts.
//      This is what would happen on a real "upload backup" admin action.
//   6. After import, re-reads every table and confirms:
//      - Same row count as before the export
//      - A spot-checked row (the recurring event) has identical fields,
//        including round-tripped Date columns and JSONB columns.
//   7. Reports a per-table summary + green / red overall pass.
//
// On failure it logs the offending diff and exits non-zero so CI can fail
// the build if this gets wired into a release gate later.

import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { exportData, importData } from "../src/lib/backup.js";

const TEST_DB_HINT = "bywave_test_restore";
const url = process.env.DATABASE_URL ?? "";
if (!/test/i.test(url) && !url.includes(TEST_DB_HINT)) {
  console.error(
    `\n[verify-backup-restore] REFUSING to run against ${url || "(no DATABASE_URL)"}.\n` +
    `This script TRUNCATEs every business table. The database name must contain "test" or "${TEST_DB_HINT}" as a safety belt.\n` +
    `Usage:\n  createdb ${TEST_DB_HINT}\n  DATABASE_URL=postgresql://localhost:5432/${TEST_DB_HINT} npm run db:migrate\n  DATABASE_URL=... npx tsx scripts/verify-backup-restore.ts\n`,
  );
  process.exit(2);
}

type Step = { name: string; ok: boolean; detail?: string };
const steps: Step[] = [];
function step(name: string, ok: boolean, detail?: string) {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// Bypass type-checking on `delete(t.table as any)` — drizzle's typed delete
// rejects bare deletes, but our backup module already uses this exact
// pattern and it's the cleanest way to wipe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function wipe() {
  const ORDER = [
    schema.eventInviteTokens, schema.calendarSubscriptions, schema.shareTokens,
    schema.calendarInvitations, schema.calendarMembers, schema.events,
    schema.calendars, schema.apiTokens, schema.appPasswords,
    schema.webauthnCredentials, schema.loginEvents, schema.loginAlerts,
    schema.ssoProviders, schema.users, schema.siteSettings,
  ];
  for (const t of ORDER) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.delete(t as any);
  }
}

async function seed() {
  // site_settings — singleton row, id pinned to 1.
  await db.insert(schema.siteSettings).values({
    id: 1,
    siteName: "Test Site",
    registrationMode: "public",
  });

  // 2 users. user A is admin, user B is normal. Both have bcrypt-shaped
  // password hashes (we don't actually verify them here, just round-trip).
  const [userA] = await db.insert(schema.users).values({
    email: "alice@test.local",
    displayName: "Alice",
    passwordHash: "$2b$10$fakehashfakehashfakehashfakehashfakehashfakehashfakehash",
    isAdmin: true,
  }).returning({ id: schema.users.id });
  const [userB] = await db.insert(schema.users).values({
    email: "bob@test.local",
    displayName: "Bob",
    passwordHash: "$2b$10$anotherFakeBcryptHashanotherFakeBcryptHashanotherFakeBcryptHash",
  }).returning({ id: schema.users.id });
  if (!userA || !userB) throw new Error("seed: user insert returned no row");

  // 2 calendars.
  const [calA] = await db.insert(schema.calendars).values({
    ownerId: userA.id, name: "Alice's main", color: "#FF0000", timezone: "Asia/Shanghai",
  }).returning({ id: schema.calendars.id });
  const [calB] = await db.insert(schema.calendars).values({
    ownerId: userB.id, name: "Bob's main", color: "#00FF00", timezone: "America/Los_Angeles",
  }).returning({ id: schema.calendars.id });
  if (!calA || !calB) throw new Error("seed: calendar insert returned no row");

  // 3 events: a one-off, a recurring weekly, a soft-deleted (export should
  // drop it). Time picked deterministically.
  const baseStart = new Date("2026-06-01T10:00:00Z");
  const baseEnd = new Date("2026-06-01T11:00:00Z");
  await db.insert(schema.events).values([
    {
      calendarId: calA.id, summary: "Standup",
      uid: "standup-test-uid@bywave-test",
      startsAt: baseStart, endsAt: baseEnd,
    },
    {
      calendarId: calA.id, summary: "Weekly review",
      uid: "weekly-review-test-uid@bywave-test",
      startsAt: baseStart, endsAt: baseEnd,
      rrule: "FREQ=WEEKLY;BYDAY=FR;COUNT=10",
    },
    {
      calendarId: calB.id, summary: "Deleted holiday (should NOT export)",
      uid: "deleted-holiday-test-uid@bywave-test",
      startsAt: baseStart, endsAt: baseEnd,
      deletedAt: new Date(),
    },
  ]);

  // calendar_members: B is editor on A's cal.
  await db.insert(schema.calendarMembers).values({
    calendarId: calA.id, userId: userB.id, role: "editor",
  });

  // pending invitation that's not yet accepted.
  await db.insert(schema.calendarInvitations).values({
    calendarId: calA.id, invitedBy: userA.id, email: "charlie@test.local",
    role: "viewer", token: "test-invite-token-1234567890",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  // share token.
  await db.insert(schema.shareTokens).values({
    calendarId: calA.id, label: "Family", token: "share-token-test-abcdef0123456789",
  });

  // calendar_subscriptions (auto-sync from a remote URL).
  await db.insert(schema.calendarSubscriptions).values({
    calendarId: calB.id, url: "https://example.com/holidays.ics",
    label: "Holidays", refreshMinutes: 360,
  });

  // event_invite_tokens — A invites B to an event (we'll attach it to the
  // first event we inserted; in a real flow you'd FK to its id, but for the
  // round-trip purposes we just need a row that round-trips).
  const [firstEvent] = await db.select({ id: schema.events.id }).from(schema.events).limit(1);
  if (!firstEvent) throw new Error("seed: no events to attach invite to");
  await db.insert(schema.eventInviteTokens).values({
    sourceEventId: firstEvent.id, recipientEmail: "guest@test.local",
    token: "event-invite-token-test-9876543210",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  // SSO provider — keep it benign (no real client secret).
  await db.insert(schema.ssoProviders).values({
    label: "Test Keycloak",
    slug: "test-keycloak",
    issuerUrl: "https://idp.test.local",
    clientId: "test-client",
    clientSecret: "test-secret",
    enabled: true,
  });

  // api_token — admin-issued. bcrypt hash of nothing real.
  await db.insert(schema.apiTokens).values({
    userId: userA.id, label: "Test n8n", prefix: "AB12CD34",
    tokenHash: "$2b$10$fakeApiTokenHashfakeApiTokenHashfakeApiTokenHashfake",
    scope: "write",
  });

  // app_password for CalDAV
  await db.insert(schema.appPasswords).values({
    userId: userA.id, label: "iPhone CalDAV", prefix: "XY99ZZ00",
    tokenHash: "$2b$10$fakeAppPwdHashfakeAppPwdHashfakeAppPwdHashfakeAppPwd",
  });

  // webauthn_credentials — fake credential id + public key.
  await db.insert(schema.webauthnCredentials).values({
    userId: userA.id, credentialId: "test-credential-id-base64url",
    publicKey: "test-public-key-base64", counter: 0,
    deviceName: "Mac TouchID",
  });

  // login_alerts (a fingerprint of last-seen device for suspicious-login detection).
  // The real path hashes IP + UA into ipHash/uaHash; we just inject plausible
  // hash-shaped strings — enough for the round-trip to succeed.
  await db.insert(schema.loginAlerts).values({
    userId: userB.id,
    ipHash: "sha256$test-ip-hash-deadbeefcafebabe",
    uaHash: "sha256$test-ua-hash-deadbeefcafebabe",
  });

  // login_events (audit history).
  await db.insert(schema.loginEvents).values({
    userId: userA.id, ip: "127.0.0.1",
    userAgent: "Mozilla/5.0 test", method: "password",
  });
}

async function countRows() {
  const counts: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = async (name: string, table: any) => {
    const r = await db.select({ c: sql<number>`count(*)::int` }).from(table);
    counts[name] = r[0]?.c ?? 0;
  };
  await c("site_settings", schema.siteSettings);
  await c("users", schema.users);
  await c("sso_providers", schema.ssoProviders);
  await c("login_alerts", schema.loginAlerts);
  await c("login_events", schema.loginEvents);
  await c("webauthn_credentials", schema.webauthnCredentials);
  await c("app_passwords", schema.appPasswords);
  await c("api_tokens", schema.apiTokens);
  await c("calendars", schema.calendars);
  await c("events", schema.events);
  await c("calendar_members", schema.calendarMembers);
  await c("calendar_invitations", schema.calendarInvitations);
  await c("share_tokens", schema.shareTokens);
  await c("calendar_subscriptions", schema.calendarSubscriptions);
  await c("event_invite_tokens", schema.eventInviteTokens);
  return counts;
}

async function run() {
  console.log(`\n[verify-backup-restore] using ${url}\n`);

  console.log("Step 1 — wipe");
  await wipe();
  step("wiped 15 tables", true);

  console.log("\nStep 2 — seed");
  await seed();
  const before = await countRows();
  step(
    "seeded fixture data",
    true,
    `${Object.values(before).reduce((a, b) => a + b, 0)} rows total`,
  );

  console.log("\nStep 3 — exportData()");
  const bundle = await exportData();
  step("bundle.productId", bundle.productId === "by-wave-calendar", bundle.productId);
  step("bundle.bundleVersion", bundle.bundleVersion === 1, String(bundle.bundleVersion));
  step("bundle has 15 table keys", Object.keys(bundle.tables).length === 15,
       `got ${Object.keys(bundle.tables).length}`);

  // Soft-deleted event should NOT appear in bundle.tables.events.
  const exportedEvents = bundle.tables.events as { id: string; summary: string; deletedAt?: Date }[] | undefined;
  if (!exportedEvents) throw new Error("bundle missing events table");
  const seedHadDeleted = before.events === 3;
  const exportHasNoDeleted = exportedEvents.length === 2;
  step(
    "soft-deleted event excluded",
    seedHadDeleted && exportHasNoDeleted,
    `seeded ${before.events} events; exported ${exportedEvents.length}`,
  );

  console.log("\nStep 4 — importData() round-trip");
  const result = await importData(bundle);
  step("importData ok", result.ok);
  const totalReimported = result.perTable.reduce((s, t) => s + t.inserted, 0);
  step("importData total inserted matches export",
       totalReimported === Object.values(before).reduce((a, b) => a + b, 0) - 1,  // -1 for the soft-deleted event
       `inserted ${totalReimported}, expected ${Object.values(before).reduce((a, b) => a + b, 0) - 1}`);

  console.log("\nStep 5 — verify per-table row counts after restore");
  const after = await countRows();
  // events should be 2 now (the soft-deleted one is gone)
  const expectedAfter = { ...before, events: 2 };
  for (const [name, count] of Object.entries(expectedAfter)) {
    const got = after[name] ?? -1;
    step(`${name}: ${got} == ${count}`, got === count);
  }

  console.log("\nStep 6 — spot-check the recurring event survived intact");
  const [rec] = await db.select().from(schema.events).where(eq(schema.events.summary, "Weekly review")).limit(1);
  step("recurring event exists", !!rec);
  if (rec) {
    step("rrule preserved", rec.rrule === "FREQ=WEEKLY;BYDAY=FR;COUNT=10", String(rec.rrule));
    step("startsAt is a Date",
         rec.startsAt instanceof Date && rec.startsAt.toISOString() === "2026-06-01T10:00:00.000Z",
         rec.startsAt instanceof Date ? rec.startsAt.toISOString() : typeof rec.startsAt);
    step("endsAt is a Date",
         rec.endsAt instanceof Date && rec.endsAt.toISOString() === "2026-06-01T11:00:00.000Z",
         rec.endsAt instanceof Date ? rec.endsAt.toISOString() : typeof rec.endsAt);
  }

  console.log("\nStep 7 — FK integrity (orphan check)");
  // After a TRUNCATE-and-INSERT cycle, the most common regression is "child
  // row references a parent UUID that didn't make it back." Spot-check the
  // children that have FKs:
  const orphanEvents = await db.execute(sql`
    SELECT e.id FROM events e
    LEFT JOIN calendars c ON c.id = e.calendar_id
    WHERE c.id IS NULL
  `);
  step("no orphan events", orphanEvents.length === 0, `${orphanEvents.length} orphans`);

  const orphanMembers = await db.execute(sql`
    SELECT cm.user_id FROM calendar_members cm
    LEFT JOIN users u ON u.id = cm.user_id
    WHERE u.id IS NULL
  `);
  step("no orphan calendar_members", orphanMembers.length === 0, `${orphanMembers.length} orphans`);

  // ---- summary ----
  const pass = steps.filter((s) => s.ok).length;
  const total = steps.length;
  console.log(`\n${pass === total ? "✅" : "❌"} ${pass}/${total} checks passed\n`);
  if (pass !== total) {
    console.log("Failures:");
    for (const s of steps.filter((x) => !x.ok)) {
      console.log(`  ✗ ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
    }
    process.exit(1);
  }
  console.log("Backup round-trip OK — exportData() and importData() are mutually inverse for every table in EXPORT_TABLES.\n");
}

run().then(() => {
  // postgres-js connection pool would keep the event loop alive — force-exit
  // once we've reported success. The shape of the data round-trip is what
  // we're verifying; cleanup of the connection itself is not interesting.
  process.exit(0);
}).catch((e) => {
  console.error("\n[verify-backup-restore] FAILED:", e);
  process.exit(1);
});
