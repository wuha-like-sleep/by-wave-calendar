import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalTimeZone } from "../zoned_time.js";
import { equivalentSyncZone } from "./zones.js";

const zoneSchema = z.string().max(100).refine(value => canonicalTimeZone(value) !== null).transform(value => canonicalTimeZone(value)!);

export const contentSchema = z.object({
  summary: z.string().max(500), description: z.string().max(20000).default(""),
  location: z.string().max(2000).default(""),
  startsAt: z.iso.datetime().transform(v => new Date(v).toISOString()),
  endsAt: z.iso.datetime().transform(v => new Date(v).toISOString()), allDay: z.boolean(),
  // Absent means the legacy adapter did not observe source metadata.
  timezone: zoneSchema.optional(), endTimezone: zoneSchema.nullable().optional(),
}).refine(v => v.endsAt > v.startsAt && (!v.allDay ||
  (v.startsAt.endsWith("T00:00:00.000Z") && v.endsAt.endsWith("T00:00:00.000Z"))), "invalid_event_dates");
export type SyncContent = z.infer<typeof contentSchema>;
export type SyncItem = { id: string; revision: string; content: SyncContent; origin?: string; timeZoneTransport?: { utcStart: boolean; utcEnd: boolean } };
const observedZoneSchema = z.object({ timezone: zoneSchema.optional(), endTimezone: zoneSchema.nullable().optional() });
type ObservedZones = z.infer<typeof observedZoneSchema>;
export const linkSchema = z.object({
  leftId: z.string(), rightId: z.string(), base: contentSchema,
  legacyZones: z.object({ left: observedZoneSchema, right: observedZoneSchema }).optional(),
});
export type SyncLink = z.infer<typeof linkSchema>;
export type Conflict = { key: string; left: SyncItem | null; right: SyncItem | null };
export const stateSchema = z.object({
  version: z.literal(1), links: z.array(linkSchema).max(20000),
  pending: z.object({ side: z.enum(["left", "right"]), sourceId: z.string(), origin: z.string(), content: contentSchema }).optional(),
  resolutions: z.record(z.string(), z.object({ side: z.enum(["left", "right"]), leftRevision: z.string().nullable(), rightRevision: z.string().nullable() })).default({}),
});
export type SyncState = z.infer<typeof stateSchema>;
export const emptyState = (): SyncState => ({ version: 1, links: [], resolutions: {} });
export function contentKey(content: SyncContent): string {
  return createHash("sha256").update(JSON.stringify(contentSchema.parse(content))).digest("hex");
}
const zoneFields = ["timezone", "endTimezone"] as const;
function comparedContent(content: SyncContent, base: SyncContent, observed?: ObservedZones): SyncContent {
  const copy = { ...content };
  for (const field of zoneFields) {
    if (base[field] === undefined) {
      if (observed?.[field] === undefined || copy[field] === undefined ||
          equivalentSyncZone(observed[field], copy[field], content.startsAt, content.endsAt)) delete copy[field];
    }
    else if (copy[field] === undefined || equivalentSyncZone(copy[field], base[field], content.startsAt, content.endsAt)) {
      Object.assign(copy, { [field]: base[field] });
    }
  }
  return copy;
}
/** Legacy links acquire a zone baseline only when both snapshots agree.
 * Unknown transport metadata must not turn into a newly edited UTC source. */
export function acknowledgedContent(base: SyncContent, left: SyncContent, right: SyncContent): SyncContent {
  const next = { ...left };
  for (const field of zoneFields) {
    if (base[field] === undefined && (left[field] === undefined || right[field] === undefined ||
        !equivalentSyncZone(left[field], right[field], left.startsAt, left.endsAt))) delete next[field];
    else if (next[field] === undefined) Object.assign(next, { [field]: right[field] !== undefined ? right[field] : base[field] });
  }
  return next;
}
/** Earlier mirrors often kept a local city and stored UTC in Outlook.
 * Record each side's starting value until a subsequent edit brings them
 * together. An unchanged old UTC value must never count as a user edit. */
export function acknowledgeLink(link: SyncLink, left: SyncContent, right: SyncContent): void {
  link.base = acknowledgedContent(link.base, left, right);
  const seen = link.legacyZones ?? { left: {}, right: {} };
  let needed = false;
  for (const field of zoneFields) {
    if (link.base[field] !== undefined) {
      delete seen.left[field]; delete seen.right[field];
      continue;
    }
    if (left[field] !== undefined) Object.assign(seen.left, { [field]: left[field] });
    if (right[field] !== undefined) Object.assign(seen.right, { [field]: right[field] });
    if (seen.left[field] !== undefined || seen.right[field] !== undefined) needed = true;
  }
  if (needed) link.legacyZones = seen;
  else delete link.legacyZones;
}
export function stableTransactionId(pairId: string, eventId: string): string {
  const hex = createHash("sha256").update(JSON.stringify([pairId, eventId])).digest("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-5" + hex.slice(13, 16) + "-a" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}
export function localOrigin(pairId: string, remoteId: string): string {
  return "outlook:" + createHash("sha256").update(JSON.stringify([pairId, remoteId])).digest("hex");
}
export type Decision = "equal" | "forget" | "to-left" | "to-right" | "conflict";
/** Compare both sides with their last acknowledged value. Missing is a deletion,
 *  but callers must obtain complete snapshots (including tracked out-of-range items). */
export function decide(link: SyncLink, left: SyncItem | undefined, right: SyncItem | undefined): Decision {
  if (!left && !right) return "forget";
  const base = contentKey(link.base);
  const l = left ? contentKey(comparedContent(left.content, link.base, link.legacyZones?.left)) : null;
  const r = right ? contentKey(comparedContent(right.content, link.base, link.legacyZones?.right)) : null;
  if (l === r) return "equal";
  if (l === base) return "to-left";
  if (r === base) return "to-right";
  return "conflict";
}
export class SyncConflictError extends Error { constructor() { super("sync_conflict"); } }
export class SyncUnavailableError extends Error {
  constructor(public readonly code: string) { super(code); }
}
