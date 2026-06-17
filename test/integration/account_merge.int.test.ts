import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

// Point the production `db`/`schema` at the in-memory PGlite instance.
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { eq } from "drizzle-orm";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, makeEvent, makeBookingLink, makeMembership, makeIdentity, makeDevice,
} from "./harness.js";
import { mergeAccounts, mergeSummary, mergeDeleteCounts, resolveUserRef } from "../../src/lib/account_merge.js";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); });

describe("mergeAccounts", () => {
  it("moves calendars+events+booking links+identities to target, deletes source (cascade)", async () => {
    const src = await makeUser("src@x.com");
    const tgt = await makeUser("tgt@x.com");
    const cal = await makeCalendar(src.id, "Src Cal");
    await makeEvent(cal.id, "e1");
    await makeEvent(cal.id, "e2");
    await makeBookingLink(src.id, cal.id, "meet");
    await makeIdentity(src.id, "keycloak", "sub-1");
    await makeDevice(src.id);

    const res = await mergeAccounts(src.id, tgt.id);
    expect(res.ok).toBe(true);

    expect((await db.select().from(schema.calendars).where(eq(schema.calendars.ownerId, tgt.id))).length).toBe(1);
    // events stay on the (now target-owned) calendar
    expect((await db.select().from(schema.events).where(eq(schema.events.calendarId, cal.id))).length).toBe(2);
    expect((await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.userId, tgt.id))).length).toBe(1);
    expect((await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, tgt.id))).length).toBe(1);
    // source gone → its device cascade-deleted
    expect((await db.select().from(schema.users).where(eq(schema.users.id, src.id))).length).toBe(0);
    expect((await db.select().from(schema.devices).where(eq(schema.devices.userId, src.id))).length).toBe(0);
  });

  it("suffixes a colliding booking-link slug instead of violating the unique index", async () => {
    const src = await makeUser("s@x.com");
    const tgt = await makeUser("t@x.com");
    const sc = await makeCalendar(src.id);
    const tc = await makeCalendar(tgt.id);
    await makeBookingLink(tgt.id, tc.id, "demo");
    await makeBookingLink(src.id, sc.id, "demo");

    const res = await mergeAccounts(src.id, tgt.id);
    expect(res.ok).toBe(true);
    const slugs = (await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.userId, tgt.id)))
      .map((l) => l.slug).sort();
    expect(slugs.length).toBe(2);
    expect(slugs[0]).toBe("demo");
    expect(slugs[1]).toMatch(/^demo-m/);
  });

  it("drops a colliding calendar membership rather than duplicating it", async () => {
    const owner = await makeUser("o@x.com");
    const shared = await makeCalendar(owner.id, "Shared");
    const src = await makeUser("s@x.com");
    const tgt = await makeUser("t@x.com");
    await makeMembership(shared.id, src.id);
    await makeMembership(shared.id, tgt.id);

    const res = await mergeAccounts(src.id, tgt.id);
    expect(res.ok).toBe(true);
    const mems = await db.select().from(schema.calendarMembers).where(eq(schema.calendarMembers.calendarId, shared.id));
    expect(mems.length).toBe(1);
    expect(mems[0]!.userId).toBe(tgt.id);
  });

  it("refuses to merge away an admin source (and leaves it intact)", async () => {
    const src = await makeUser("admin@x.com", { isAdmin: true });
    const tgt = await makeUser("t@x.com");
    const res = await mergeAccounts(src.id, tgt.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("管理员");
    expect((await db.select().from(schema.users).where(eq(schema.users.id, src.id))).length).toBe(1);
  });

  it("refuses source === target", async () => {
    const u = await makeUser("u@x.com");
    expect((await mergeAccounts(u.id, u.id)).ok).toBe(false);
  });
});

describe("mergeSummary / mergeDeleteCounts", () => {
  it("counts migrated content and to-be-deleted credentials", async () => {
    const src = await makeUser("s@x.com");
    const cal = await makeCalendar(src.id);
    await makeEvent(cal.id, "e1");
    await makeBookingLink(src.id, cal.id, "m");
    await makeIdentity(src.id, "kc", "sub");
    await makeDevice(src.id);

    expect(await mergeSummary(src.id)).toMatchObject({ calendars: 1, events: 1, bookingLinks: 1, memberships: 0, identities: 1 });
    expect((await mergeDeleteCounts(src.id)).devices).toBe(1);
  });
});

describe("resolveUserRef", () => {
  it("resolves by email and by uuid, null otherwise", async () => {
    const u = await makeUser("findme@x.com");
    expect((await resolveUserRef("findme@x.com"))?.id).toBe(u.id);
    expect((await resolveUserRef(u.id))?.id).toBe(u.id);
    expect(await resolveUserRef("nope@x.com")).toBeNull();
  });
});
