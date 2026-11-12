import { createHash } from "node:crypto";
import { z } from "zod";

export const contentSchema = z.object({
  summary: z.string().max(500), description: z.string().max(20000).default(""),
  location: z.string().max(2000).default(""),
  startsAt: z.iso.datetime().transform(v => new Date(v).toISOString()),
  endsAt: z.iso.datetime().transform(v => new Date(v).toISOString()), allDay: z.boolean(),
}).refine(v => v.endsAt > v.startsAt && (!v.allDay ||
  (v.startsAt.endsWith("T00:00:00.000Z") && v.endsAt.endsWith("T00:00:00.000Z"))), "invalid_event_dates");
export type SyncContent = z.infer<typeof contentSchema>;
export type SyncItem = { id: string; revision: string; content: SyncContent; origin?: string };
export const linkSchema = z.object({ leftId: z.string(), rightId: z.string(), base: contentSchema });
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
  const l = left ? contentKey(left.content) : null;
  const r = right ? contentKey(right.content) : null;
  if (l === r) return "equal";
  if (l === base) return "to-left";
  if (r === base) return "to-right";
  return "conflict";
}
export class SyncConflictError extends Error { constructor() { super("sync_conflict"); } }
export class SyncUnavailableError extends Error {
  constructor(public readonly code: string) { super(code); }
}
