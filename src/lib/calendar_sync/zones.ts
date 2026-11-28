import { canonicalTimeZone, toWallClock, zoneOffsetMs } from "../zoned_time.js";
import { windowsZones } from "./windows_zones.js";

const windowsToIana = new Map(windowsZones.map(([windows, iana]) => [windows, iana]));
const ianaToWindows = new Map<string, string>();
for (const [windows, , zones] of windowsZones) {
  for (const zone of zones.split(" ")) {
    const canonical = canonicalTimeZone(zone);
    if (canonical) ianaToWindows.set(canonical, windows);
  }
}
export function microsoftSourceZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return canonicalTimeZone(value) ?? canonicalTimeZone(windowsToIana.get(value)) ?? undefined;
}
export function windowsZone(value: string): string | undefined { return ianaToWindows.get(canonicalTimeZone(value) ?? ""); }
export function equivalentSyncZone(a: string | null | undefined, b: string | null | undefined, start: string, end: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ca = canonicalTimeZone(a), cb = canonicalTimeZone(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const group = windowsZone(ca);
  // Outlook's Windows zone may represent several cities. Keep an existing
  // exact IANA city only when the Windows group AND endpoint offsets match.
  return !!group && group === windowsZone(cb) && [start, end].every(value =>
    zoneOffsetMs(new Date(value).getTime(), ca) === zoneOffsetMs(new Date(value).getTime(), cb));
}
export function sourceZoneFields(extra: unknown, calendarZone: string | null | undefined, allDay: boolean): { timezone?: string; endTimezone?: string | null } {
  if (allDay) return {};
  const obj = extra && typeof extra === "object" && !Array.isArray(extra) ? extra as Record<string, unknown> : {};
  const timezone = canonicalTimeZone(typeof obj.timezone === "string" ? obj.timezone.trim() : null)
    ?? canonicalTimeZone(calendarZone?.trim()) ?? undefined;
  const end = canonicalTimeZone(obj.endTimezone);
  return { ...(timezone ? { timezone } : {}), endTimezone: end && end !== timezone ? end : null };
}
/** Convert an instant once, rejecting a repeated wall clock before a provider
 * could silently choose the other DST occurrence. Existing unchanged dates
 * are omitted from PATCH and never reach this ambiguous-create boundary. */
export function unambiguousWallTime(iso: string, zone: string): string | null {
  const value = new Date(iso), wall = toWallClock(value, zone);
  const offset = zoneOffsetMs(value.getTime(), zone)!;
  const offsets = new Set([-172800000, -86400000, 0, 86400000, 172800000].map(delta => zoneOffsetMs(value.getTime() + delta, zone)));
  for (const alternative of offsets) {
    if (alternative === null || alternative === offset) continue;
    const other = new Date(value.getTime() + offset - alternative);
    if (toWallClock(other, zone).getTime() === wall.getTime()) return null;
  }
  return wall.toISOString().replace(/Z$/, "");
}
