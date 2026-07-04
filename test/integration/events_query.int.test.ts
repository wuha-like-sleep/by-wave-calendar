import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

// Point the production `db`/`schema` at the in-memory PGlite instance.
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar } from "./harness.js";
import { fetchEventMastersInWindow } from "../../src/lib/events_query.js";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); });

async function insertEvent(
  calendarId: string,
  uid: string,
  opts: { startsAt: string; endsAt: string; rrule?: string | null; deletedAt?: string | null },
) {
  const [e] = await db
    .insert(schema.events)
    .values({
      calendarId, uid, summary: uid,
      startsAt: new Date(opts.startsAt), endsAt: new Date(opts.endsAt),
      rrule: opts.rrule ?? null,
      deletedAt: opts.deletedAt ? new Date(opts.deletedAt) : null,
    })
    .returning();
  return e!;
}

describe("fetchEventMastersInWindow", () => {
  const FROM = new Date("2026-07-01T00:00:00Z");
  const TO = new Date("2026-07-31T23:59:59Z");
  const uids = (rows: { uid: string }[]) => rows.map((r) => r.uid);

  it("keeps a recurring master whose own start/end predates the window by >1 year", async () => {
    // Regression guard: the old widened-window query (`endsAt >= fromDate-1y`)
    // dropped this row entirely, so its July-2026 occurrences vanished.
    const c = await makeCalendar((await makeUser("a@x.com")).id);
    await insertEvent(c.id, "old-weekly", {
      startsAt: "2024-01-01T02:00:00Z", endsAt: "2024-01-01T03:00:00Z", rrule: "FREQ=WEEKLY;BYDAY=MO",
    });
    expect(uids(await fetchEventMastersInWindow([c.id], FROM, TO))).toContain("old-weekly");
  });

  it("keeps a non-recurring event overlapping the window", async () => {
    const c = await makeCalendar((await makeUser("b@x.com")).id);
    await insertEvent(c.id, "in-window", { startsAt: "2026-07-10T02:00:00Z", endsAt: "2026-07-10T03:00:00Z" });
    expect(uids(await fetchEventMastersInWindow([c.id], FROM, TO))).toContain("in-window");
  });

  it("drops a non-recurring event that ended before the window (no 1-year over-fetch)", async () => {
    const c = await makeCalendar((await makeUser("c@x.com")).id);
    await insertEvent(c.id, "stale", { startsAt: "2026-05-01T02:00:00Z", endsAt: "2026-05-01T03:00:00Z" });
    expect(uids(await fetchEventMastersInWindow([c.id], FROM, TO))).not.toContain("stale");
  });

  it("drops soft-deleted events even inside the window", async () => {
    const c = await makeCalendar((await makeUser("d@x.com")).id);
    await insertEvent(c.id, "gone", {
      startsAt: "2026-07-10T02:00:00Z", endsAt: "2026-07-10T03:00:00Z", deletedAt: "2026-07-05T00:00:00Z",
    });
    expect(uids(await fetchEventMastersInWindow([c.id], FROM, TO))).not.toContain("gone");
  });

  it("drops a master starting after the window end", async () => {
    const c = await makeCalendar((await makeUser("e@x.com")).id);
    await insertEvent(c.id, "future", { startsAt: "2026-09-01T02:00:00Z", endsAt: "2026-09-01T03:00:00Z" });
    expect(uids(await fetchEventMastersInWindow([c.id], FROM, TO))).not.toContain("future");
  });
});
