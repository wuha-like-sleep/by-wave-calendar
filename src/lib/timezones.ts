// IANA timezones. We expose ALL ~400 zones (sourced via
// `Intl.supportedValuesOf('timeZone')` at module load) so the user can
// pick anywhere in the world — picking a city from a curated list of
// 20 is too restrictive for a globally-deployed calendar. Curated
// zones with Chinese labels are sorted to the top of the list so the
// common case (Asia/Shanghai etc.) is one keystroke away.
//
// The current UTC offset is computed at runtime so DST shifts are accurate
// (e.g. America/New_York shows UTC-5 in winter, UTC-4 in summer).

// Curated entries with friendly Chinese labels. These appear first in
// the listTimezones() output and are tagged so the client UI can render
// them visually (e.g. as quick-pick chips at the top).
const CURATED: { id: string; label: string }[] = [
  // ---- 大中华区 ----
  // IANA 只有 Asia/Shanghai 一个 zone 代表整个中国大陆（历史合并）。
  // 北京/上海/广州/深圳 用户写不同 label 但都映射到同一个 id，方便搜索时
  // 输入哪个城市名都能匹配到。
  { id: "Asia/Shanghai",     label: "上海" },
  { id: "Asia/Shanghai",     label: "北京" },
  { id: "Asia/Shanghai",     label: "广州" },
  { id: "Asia/Shanghai",     label: "深圳" },
  { id: "Asia/Shanghai",     label: "成都" },
  { id: "Asia/Hong_Kong",    label: "香港" },
  { id: "Asia/Macau",        label: "澳门" },
  { id: "Asia/Taipei",       label: "台北" },
  { id: "Asia/Urumqi",       label: "乌鲁木齐 (新疆)" },

  // ---- 亚太 ----
  { id: "Asia/Tokyo",        label: "东京" },
  { id: "Asia/Seoul",        label: "首尔" },
  { id: "Asia/Singapore",    label: "新加坡" },
  { id: "Asia/Kuala_Lumpur", label: "吉隆坡" },
  { id: "Asia/Bangkok",      label: "曼谷" },
  { id: "Asia/Jakarta",      label: "雅加达" },
  { id: "Asia/Manila",       label: "马尼拉" },
  { id: "Asia/Ho_Chi_Minh",  label: "胡志明市" },
  { id: "Asia/Kolkata",      label: "印度（加尔各答）" },
  { id: "Asia/Karachi",      label: "卡拉奇" },
  { id: "Asia/Dubai",        label: "迪拜" },
  { id: "Asia/Riyadh",       label: "利雅得" },

  // ---- 大洋洲 ----
  { id: "Australia/Sydney",   label: "悉尼（夏令时）" },
  { id: "Australia/Melbourne", label: "墨尔本（夏令时）" },
  { id: "Australia/Brisbane",  label: "布里斯班" },
  { id: "Australia/Perth",     label: "珀斯" },
  { id: "Australia/Adelaide",  label: "阿德莱德" },
  { id: "Pacific/Auckland",   label: "奥克兰（夏令时）" },

  // ---- 欧洲 ----
  { id: "Europe/London",     label: "伦敦（夏令时）" },
  { id: "Europe/Paris",      label: "巴黎（夏令时）" },
  { id: "Europe/Berlin",     label: "柏林（夏令时）" },
  { id: "Europe/Madrid",     label: "马德里" },
  { id: "Europe/Rome",       label: "罗马" },
  { id: "Europe/Amsterdam",  label: "阿姆斯特丹" },
  { id: "Europe/Zurich",     label: "苏黎世" },
  { id: "Europe/Stockholm",  label: "斯德哥尔摩" },
  { id: "Europe/Moscow",     label: "莫斯科" },
  { id: "Europe/Istanbul",   label: "伊斯坦布尔" },

  // ---- 美洲 ----
  { id: "America/New_York",    label: "纽约（夏令时）" },
  { id: "America/Toronto",     label: "多伦多（夏令时）" },
  { id: "America/Chicago",     label: "芝加哥（夏令时）" },
  { id: "America/Denver",      label: "丹佛（夏令时）" },
  { id: "America/Los_Angeles", label: "洛杉矶（夏令时）" },
  { id: "America/Vancouver",   label: "温哥华（夏令时）" },
  { id: "America/Mexico_City", label: "墨西哥城" },
  { id: "America/Sao_Paulo",   label: "圣保罗" },
  { id: "America/Buenos_Aires", label: "布宜诺斯艾利斯" },

  // ---- 非洲 ----
  { id: "Africa/Cairo",      label: "开罗" },
  { id: "Africa/Johannesburg", label: "约翰内斯堡" },
  { id: "Africa/Lagos",      label: "拉各斯" },

  // ---- UTC ----
  { id: "UTC",               label: "协调世界时 UTC" },
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
// order so 上海 stays at the top) and the rest alphabetically. Each entry
// carries `curated: true/false` so the UI can render the curated ones as
// a quick-pick row above the searchable input.
export function listTimezones(): TimezoneOption[] {
  const curatedIds = new Set(CURATED.map((z) => z.id));
  const curated: TimezoneOption[] = CURATED.map(({ id, label }) => ({
    id, label, offset: currentOffset(id), curated: true,
  }));
  const rest = allIanaZones()
    .filter((id) => !curatedIds.has(id))
    .sort()
    .map<TimezoneOption>((id) => ({
      // No friendly Chinese label for these — show the IANA id (e.g.
      // "America/Toronto"). The offset is appended in the UI.
      id, label: id, offset: currentOffset(id), curated: false,
    }));
  return [...curated, ...rest];
}
