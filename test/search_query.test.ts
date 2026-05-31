import { describe, it, expect } from "vitest";
import {
  parseSearchTerms,
  likeNeedle,
  textMatchesAllTerms,
  eventRelevance,
  MAX_TERMS,
  MAX_TERM_LEN,
} from "../src/lib/search_query.js";

describe("parseSearchTerms", () => {
  it("splits on whitespace, trims, drops empties", () => {
    expect(parseSearchTerms("  team   lunch ")).toEqual(["team", "lunch"]);
  });
  it("dedupes case-insensitively (keeps first casing)", () => {
    expect(parseSearchTerms("Team team TEAM lunch")).toEqual(["Team", "lunch"]);
  });
  it("caps at MAX_TERMS", () => {
    expect(parseSearchTerms("a b c d e f g h i").length).toBe(MAX_TERMS);
  });
  it("clamps each term to MAX_TERM_LEN", () => {
    expect(parseSearchTerms("x".repeat(100))[0]!.length).toBe(MAX_TERM_LEN);
  });
  it("empty / whitespace / null → []", () => {
    expect(parseSearchTerms("")).toEqual([]);
    expect(parseSearchTerms("   ")).toEqual([]);
    expect(parseSearchTerms(null as unknown as string)).toEqual([]);
  });
});

describe("likeNeedle", () => {
  it("wraps in %…% for a contains match", () => {
    expect(likeNeedle("abc")).toBe("%abc%");
  });
  it("escapes LIKE metacharacters so a query can't widen its own match", () => {
    expect(likeNeedle("a%b_c\\d")).toBe("%a\\%b\\_c\\\\d%");
  });
});

describe("textMatchesAllTerms (AND across terms, case-insensitive)", () => {
  it("matches only when EVERY term is present", () => {
    expect(textMatchesAllTerms("Team Lunch Meeting", ["team", "lunch"])).toBe(true);
    expect(textMatchesAllTerms("Team Meeting", ["team", "lunch"])).toBe(false);
  });
  it("null / empty text never matches", () => {
    expect(textMatchesAllTerms(null, ["x"])).toBe(false);
    expect(textMatchesAllTerms("", ["x"])).toBe(false);
  });
});

describe("eventRelevance (title hits dominate)", () => {
  it("term at title start > in title > not in title", () => {
    expect(eventRelevance("Lunch with team", ["lunch"])).toBe(3);
    expect(eventRelevance("Team lunch", ["lunch"])).toBe(2);
    expect(eventRelevance("Weekly sync", ["lunch"])).toBe(0);
  });
  it("sums across terms", () => {
    expect(eventRelevance("Team lunch", ["team", "lunch"])).toBe(5);
  });
});
