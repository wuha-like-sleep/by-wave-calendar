// IANA timezones. We expose ALL ~400 zones (sourced via
// `Intl.supportedValuesOf('timeZone')` at module load) so the user can
// pick anywhere in the world — picking a city from a curated list of
// 20 is too restrictive for a globally-deployed calendar. Curated
// zones with localized labels are sorted to the top of the list so the
// common case (Asia/Shanghai etc.) is one keystroke away.
//
// The current UTC offset is computed at runtime so DST shifts are accurate
// (e.g. America/New_York shows UTC-5 in winter, UTC-4 in summer).

import { translate, type LocaleCode } from "./i18n.js";

// Curated entries with friendly localized labels. The label is an i18n
// key under app.tz.city.* (translated per-request in listTimezones), so
// a German user sees "Peking" and a zh-CN user sees 北京. These appear
// first in the listTimezones() output and are tagged so the client UI
// can render them visually (e.g. as quick-pick chips at the top).
const CURATED: { id: string; labelKey: string }[] = [
  // ---- Greater China ----
  // IANA 只有 Asia/Shanghai 一个 zone 代表整个中国大陆（历史合并）。
  // 北京/上海/广州/深圳 用户写不同 label 但都映射到同一个 id，方便搜索时
  // 输入哪个城市名都能匹配到。
  { id: "Asia/Shanghai",     labelKey: "app.tz.city.shanghai" },
  { id: "Asia/Shanghai",     labelKey: "app.tz.city.beijing" },
  { id: "Asia/Shanghai",     labelKey: "app.tz.city.guangzhou" },
  { id: "Asia/Shanghai",     labelKey: "app.tz.city.shenzhen" },
  { id: "Asia/Shanghai",     labelKey: "app.tz.city.chengdu" },
  { id: "Asia/Hong_Kong",    labelKey: "app.tz.city.hongkong" },
  { id: "Asia/Macau",        labelKey: "app.tz.city.macau" },
  { id: "Asia/Taipei",       labelKey: "app.tz.city.taipei" },
  { id: "Asia/Urumqi",       labelKey: "app.tz.city.urumqi" },

  // ---- Asia-Pacific ----
  { id: "Asia/Tokyo",        labelKey: "app.tz.city.tokyo" },
  { id: "Asia/Seoul",        labelKey: "app.tz.city.seoul" },
  { id: "Asia/Singapore",    labelKey: "app.tz.city.singapore" },
  { id: "Asia/Kuala_Lumpur", labelKey: "app.tz.city.kualaLumpur" },
  { id: "Asia/Bangkok",      labelKey: "app.tz.city.bangkok" },
  { id: "Asia/Jakarta",      labelKey: "app.tz.city.jakarta" },
  { id: "Asia/Manila",       labelKey: "app.tz.city.manila" },
  { id: "Asia/Ho_Chi_Minh",  labelKey: "app.tz.city.hoChiMinh" },
  { id: "Asia/Kolkata",      labelKey: "app.tz.city.kolkata" },
  { id: "Asia/Karachi",      labelKey: "app.tz.city.karachi" },
  { id: "Asia/Dubai",        labelKey: "app.tz.city.dubai" },
  { id: "Asia/Riyadh",       labelKey: "app.tz.city.riyadh" },

  // ---- Oceania ----
  { id: "Australia/Sydney",    labelKey: "app.tz.city.sydney" },
  { id: "Australia/Melbourne", labelKey: "app.tz.city.melbourne" },
  { id: "Australia/Brisbane",  labelKey: "app.tz.city.brisbane" },
  { id: "Australia/Perth",     labelKey: "app.tz.city.perth" },
  { id: "Australia/Adelaide",  labelKey: "app.tz.city.adelaide" },
  { id: "Pacific/Auckland",    labelKey: "app.tz.city.auckland" },

  // ---- Europe ----
  { id: "Europe/London",     labelKey: "app.tz.city.london" },
  { id: "Europe/Paris",      labelKey: "app.tz.city.paris" },
  { id: "Europe/Berlin",     labelKey: "app.tz.city.berlin" },
  { id: "Europe/Madrid",     labelKey: "app.tz.city.madrid" },
  { id: "Europe/Rome",       labelKey: "app.tz.city.rome" },
  { id: "Europe/Amsterdam",  labelKey: "app.tz.city.amsterdam" },
  { id: "Europe/Zurich",     labelKey: "app.tz.city.zurich" },
  { id: "Europe/Stockholm",  labelKey: "app.tz.city.stockholm" },
  { id: "Europe/Moscow",     labelKey: "app.tz.city.moscow" },
  { id: "Europe/Istanbul",   labelKey: "app.tz.city.istanbul" },

  // ---- Americas ----
  { id: "America/New_York",    labelKey: "app.tz.city.newYork" },
  { id: "America/Toronto",     labelKey: "app.tz.city.toronto" },
  { id: "America/Chicago",     labelKey: "app.tz.city.chicago" },
  { id: "America/Denver",      labelKey: "app.tz.city.denver" },
  { id: "America/Los_Angeles", labelKey: "app.tz.city.losAngeles" },
  { id: "America/Vancouver",   labelKey: "app.tz.city.vancouver" },
  { id: "America/Mexico_City", labelKey: "app.tz.city.mexicoCity" },
  { id: "America/Sao_Paulo",   labelKey: "app.tz.city.saoPaulo" },
  { id: "America/Buenos_Aires", labelKey: "app.tz.city.buenosAires" },

  // ---- Africa ----
  { id: "Africa/Cairo",        labelKey: "app.tz.city.cairo" },
  { id: "Africa/Johannesburg", labelKey: "app.tz.city.johannesburg" },
  { id: "Africa/Lagos",        labelKey: "app.tz.city.lagos" },

  // ---- UTC ----
  { id: "UTC",               labelKey: "app.tz.city.utc" },
];

// Pull the full IANA list from the JS runtime so we don't have to ship
// (and maintain) a hardcoded 400-entry table. Falls back to the curated
// list on runtimes that don't support supportedValuesOf (Node < 18).
function allIanaZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof intl.supportedValuesOf === "function") {
      return intl.supportedValuesOf("timeZone");
    }
  } catch { /* fallthrough */ }
  return CURATED.map((z) => z.id);
}

function currentOffset(id: string): string {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: id,
      timeZoneName: "longOffset",
      hour: "2-digit",
    });
    const parts = fmt.formatToParts(now);
    const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // longOffset format is like "GMT+08:00" or "GMT-04:00"
    const match = offsetPart.match(/GMT([+-]\d{2}):?(\d{2})?/);
    if (!match) return "";
    const hours = match[1];
    const mins = match[2] && match[2] !== "00" ? `:${match[2]}` : "";
    return `UTC${hours}${mins}`;
  } catch {
    return "";
  }
}

export type TimezoneOption = { id: string; label: string; offset: string; curated: boolean };

// Return ALL IANA zones, with the curated ones first (in their hand-picked
// order so Shanghai stays at the top) and the rest alphabetically. Each
// entry carries `curated: true/false` so the UI can render the curated ones
// as a quick-pick row above the searchable input. Curated labels are
// localized into the given locale (defaults to zh-CN, the site's hard
// fallback, for callers that don't resolve a request locale).
export function listTimezones(locale: LocaleCode = "zh-CN"): TimezoneOption[] {
  const curatedIds = new Set(CURATED.map((z) => z.id));
  const curated: TimezoneOption[] = CURATED.map(({ id, labelKey }) => ({
    id, label: translate(locale, labelKey), offset: currentOffset(id), curated: true,
  }));
  const rest = allIanaZones()
    .filter((id) => !curatedIds.has(id))
    .sort()
    .map<TimezoneOption>((id) => ({
      // No friendly localized label for these — show the IANA id (e.g.
      // "America/Toronto"). The offset is appended in the UI.
      id, label: id, offset: currentOffset(id), curated: false,
    }));
  return [...curated, ...rest];
}
