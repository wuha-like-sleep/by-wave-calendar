// Pure, DB-free helpers for the user search (events / calendars / booking
// links). Kept separate from the route so the parsing + escaping + matching +
// ranking logic is unit-tested without a database.
//
// SECURITY NOTE: these helpers do NOT enforce isolation. The isolation boundary
// — which calendars / booking links a caller may see — lives in the route
// (scoped to owned + member calendars, and booking links owned by the caller).
// These functions only ever run on rows the query already scoped to the caller.

/** Hard caps that bound query cost regardless of input. */
export const MAX_TERMS = 6;
export const MAX_TERM_LEN = 50;

/**
 * Split a raw query into normalized search terms: whitespace-separated,
 * trimmed, de-duplicated (case-insensitive), each clamped to MAX_TERM_LEN, at
 * most MAX_TERMS. Returning [] means "don't search" (caller short-circuits).
 */
export function parseSearchTerms(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of String(raw ?? "").trim().split(/\s+/)) {
    const t = piece.trim().slice(0, MAX_TERM_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/**
 * Build an ILIKE needle for one term: escape the LIKE metacharacters (\ % _)
 * so user input can't widen the match (e.g. typing "a%" must match a literal
 * "a%", not every row), then wrap in %…% for a contains match. The value is
 * still bound as a parameter by the query builder — this only neutralizes
 * wildcard semantics, it is NOT the injection defense (the ORM parameterizes).
 */
export function likeNeedle(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => "\\" + c);
  return `%${escaped}%`;
}

/** True iff EVERY term appears (case-insensitive substring) in `text`. */
export function textMatchesAllTerms(text: string | null | undefined, terms: string[]): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  return terms.every((t) => hay.includes(t.toLowerCase()));
}

/**
 * Relevance score for an event given the query terms. Higher = better. Title
 * (summary) hits dominate so "the meeting titled X" ranks above "an event whose
 * description happens to mention X". A term at the very start of the title
 * scores highest. Terms that only matched description/location add nothing here
 * — recency is the tie-breaker for those (applied by the caller).
 */
export function eventRelevance(summary: string | null | undefined, terms: string[]): number {
  const s = String(summary ?? "").toLowerCase();
  let score = 0;
  for (const t of terms) {
    const idx = s.indexOf(t.toLowerCase());
    if (idx === 0) score += 3;
    else if (idx > 0) score += 2;
  }
  return score;
}
