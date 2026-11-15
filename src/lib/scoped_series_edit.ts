import { sameRule, planSeriesEdit } from "./series_edit.js";
import { seriesStartsBetween } from "./rrule_expand.js";

export type ScopedSeries = {
  startsAt: Date; endsAt: Date; rrule: string | null; allDay: boolean; exdates: unknown;
};
type Changes = { startsAt?: string; endsAt?: string; rrule?: string; allDay?: boolean };
const COUNT_SCAN_LIMIT = 10_000;

export function truncateSeriesBefore(rule: string, occurrence: Date): string {
  const until = new Date(occurrence.getTime() - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  // COUNT and UNTIL are mutually exclusive. The validated occurrence bounds
  // the old prefix, so retaining COUNT would be redundant and invalid.
  return rule.split(";").filter((part) => !/^(COUNT|UNTIL)=/i.test(part.trim())).join(";") + ";UNTIL=" + until;
}

export function activeSeriesOccurrence(master: ScopedSeries, zone: string, occurrence: Date): boolean {
  const hit = seriesStartsBetween({ ...master, timeZone: zone }, occurrence, occurrence, 1);
  if (!hit?.some((d) => d.getTime() === occurrence.getTime())) return false;
  return !Array.isArray(master.exdates) || !master.exdates.some((value) =>
    typeof value === "string" && Math.floor(new Date(value).getTime() / 1000) === Math.floor(occurrence.getTime() / 1000));
}

/** Preserve the remaining count, original end and deleted future occurrences
 *  when editing a suffix. Refuse ambiguous/bounded-out plans before any writes. */
export function planFutureSeries(
  master: ScopedSeries,
  sent: Changes,
  occurrence: Date,
  newStart: Date,
  fromZone: string,
  toZone: string,
): { rrule: string | null; exdates: string[] } | null {
  if (!master.rrule) return null;
  const rawExdates = Array.isArray(master.exdates) ? master.exdates.filter((v): v is string => typeof v === "string") : [];
  const futureExdates = rawExdates.filter((v) => +new Date(v) >= +occurrence);
  const unchangedRule = sent.rrule == null || sameRule(sent.rrule, master.rrule);
  if (!unchangedRule) {
    // A user-selected new pattern has no unambiguous identity mapping for
    // existing cancellations. Keep dates only when they can be kept as-is.
    if (futureExdates.length && (newStart.getTime() !== occurrence.getTime() || fromZone !== toZone || (sent.allDay ?? master.allDay) !== master.allDay)) return null;
    return { rrule: sent.rrule || null, exdates: sent.rrule ? futureExdates : [] };
  }
  if ((sent.allDay ?? master.allDay) !== master.allDay) return null;
  // A timezone-only suffix edit keeps its selected instant and original end
  // boundary. There is no cancellation identity to remap when the suffix has
  // no EXDATEs. Combined time/zone moves or deleted future instances need an
  // explicit mapping; refuse those rather than resurrect cancelled events.
  if (fromZone !== toZone && (futureExdates.length > 0 || +newStart !== +occurrence)) return null;
  const plan = planSeriesEdit({ master, zone: fromZone, sent, recurrenceId: occurrence.toISOString() });
  let rule = plan?.rrule ?? master.rrule;
  const countPart = master.rrule.split(";").find((p) => /^COUNT=/i.test(p.trim()));
  if (countPart) {
    const count = Number(countPart.trim().split("=")[1]);
    const prefix = seriesStartsBetween({ ...master, timeZone: fromZone }, new Date(Math.floor(master.startsAt.getTime() / 1000) * 1000), occurrence, COUNT_SCAN_LIMIT + 1);
    if (!Number.isSafeInteger(count) || count < 1 || !prefix || prefix.length > COUNT_SCAN_LIMIT || prefix.at(-1)?.getTime() !== occurrence.getTime()) return null;
    const remaining = count - (prefix.length - 1);
    if (remaining < 1) return null;
    rule = rule.split(";").map((p) => /^COUNT=/i.test(p.trim()) ? `COUNT=${remaining}` : p).join(";");
  }
  // Some exotic rules lock the weekday/hour. Do not silently save a start
  // that the resulting rule cannot actually display.
  const first = seriesStartsBetween({ startsAt: newStart, rrule: rule, allDay: master.allDay, timeZone: toZone }, newStart, newStart, 1);
  if (!first?.some((v) => +v === +newStart)) return null;
  const shifted = plan?.exdates ?? rawExdates;
  return {
    rrule: rule,
    exdates: rawExdates.flatMap((value, index) => +new Date(value) >= +occurrence ? [shifted[index] ?? value] : []),
  };
}

/** updatedAt alone can collide within a millisecond. Compare every field read
 *  for the plan so an intervening EXDATE/recurrence change cannot be lost. */
export function unchangedEventForWrite(expected: Record<string, unknown>, current: Record<string, unknown>): boolean {
  return Object.keys(expected).every((key) => JSON.stringify(expected[key]) === JSON.stringify(current[key]));
}
