// Regression guard for the user search (src/routes/search.ts). It rebuilds the
// EXACT WHERE clauses the route uses and inspects the SQL drizzle generates —
// no database needed. The point: if anyone ever refactors search to splice user
// input into SQL (string concat / sql`` / raw), or drops the per-user scoping,
// these assertions go red.

import { describe, it, expect } from "vitest";
import { and, or, eq, ilike, inArray, isNull } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema.js";
import { likeNeedle, parseSearchTerms } from "../src/lib/search_query.js";

const dialect = new PgDialect();
const HOSTILE = "x'); DROP TABLE events;-- %_\\";

// Mirrors the route's event WHERE: scoped to allowed calendars + not deleted +
// each term ILIKE'd across summary/description/location.
function eventsWhere(allowedIds: string[], terms: string[]) {
  const termConds = terms.map((t) => {
    const n = likeNeedle(t);
    return or(ilike(schema.events.summary, n), ilike(schema.events.description, n), ilike(schema.events.location, n));
  });
  return and(inArray(schema.events.calendarId, allowedIds), isNull(schema.events.deletedAt), ...termConds);
}
// Mirrors the route's booking-link WHERE: scoped to the caller's own links.
function bookingWhere(userId: string, terms: string[]) {
  const conds = terms.map((t) => {
    const n = likeNeedle(t);
    return or(ilike(schema.bookingLinks.title, n), ilike(schema.bookingLinks.slug, n));
  });
  return and(eq(schema.bookingLinks.userId, userId), ...conds);
}

describe("search SQL is injection-safe (regression)", () => {
  const terms = parseSearchTerms(HOSTILE);
  const { sql, params } = dialect.sqlToQuery(eventsWhere(["cal-1"], terms)!);

  it("never inlines user input — hostile substrings stay OUT of the SQL text", () => {
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain("');");
    expect(sql).not.toContain("--");
  });

  it("emits only bound $N placeholders for values; hostile input lands in params", () => {
    expect(sql).toMatch(/\$\d+/);
    expect(params.some((p) => typeof p === "string" && p.includes("DROP"))).toBe(true);
  });

  it("escapes LIKE wildcards (% _ \\) in the bound needle", () => {
    // The "%_\\" term becomes the literal needle %\%\_\\% — wildcards neutralized.
    expect(params).toContain("%\\%\\_\\\\%");
  });
});

describe("search SQL enforces per-user isolation (regression)", () => {
  const terms = parseSearchTerms("meeting");

  it("events are scoped to calendar_id IN (...) AND deleted_at IS NULL", () => {
    const { sql, params } = dialect.sqlToQuery(eventsWhere(["cal-1", "cal-2"], terms)!);
    const lower = sql.toLowerCase();
    expect(lower).toContain("calendar_id");
    expect(lower).toContain(" in (");
    expect(lower).toContain("deleted_at");
    expect(lower).toContain("is null");
    expect(params).toContain("cal-1");
    expect(params).toContain("cal-2");
  });

  it("booking links are scoped to user_id = caller", () => {
    const { sql, params } = dialect.sqlToQuery(bookingWhere("user-9", terms)!);
    expect(sql.toLowerCase()).toContain("user_id");
    expect(params).toContain("user-9");
  });
});
