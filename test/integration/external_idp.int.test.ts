import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema } from "./harness.js";
import { provisionAccountByEmail } from "../../src/lib/external_idp.js";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); });

describe("provisionAccountByEmail (service-client bulk provision)", () => {
  it("creates a new account + default calendar, created:true", async () => {
    const r = await provisionAccountByEmail("new@x.com", "New User");
    expect(r.created).toBe(true);
    expect(r.user?.email).toBe("new@x.com");
    expect(r.user?.emailVerified).toBe(true);
    // a default calendar was seeded for the new account
    const cals = await db.select().from(schema.calendars).where(eq(schema.calendars.ownerId, r.user!.id));
    expect(cals.length).toBe(1);
    // password hash is a real (unguessable) bcrypt stub, never a sentinel string
    expect(r.user!.passwordHash.length).toBeGreaterThan(20);
    expect(r.user!.passwordHash).not.toBe("!idp-provisioned");
  });

  it("is idempotent — second call returns the existing account with created:false", async () => {
    const first = await provisionAccountByEmail("dup@x.com", null);
    const second = await provisionAccountByEmail("dup@x.com", null);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.user?.id).toBe(first.user?.id);
    // not duplicated
    expect((await db.select().from(schema.users).where(eq(schema.users.email, "dup@x.com"))).length).toBe(1);
    // and exactly one default calendar (not two)
    expect((await db.select().from(schema.calendars).where(eq(schema.calendars.ownerId, first.user!.id))).length).toBe(1);
  });

  it("falls back to the email local-part when no display name given", async () => {
    const r = await provisionAccountByEmail("alice@example.com", null);
    expect(r.user?.displayName).toBe("alice");
  });
});
