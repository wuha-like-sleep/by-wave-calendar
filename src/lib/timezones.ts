// Common IANA timezones with friendly Chinese labels.
// The current UTC offset is computed at runtime so DST shifts are accurate
// (e.g. America/New_York shows UTC-5 in winter, UTC-4 in summer).

const ZONES = [
  { id: "Asia/Shanghai",     label: "上海 / 北京" },
  { id: "Asia/Hong_Kong",    label: "香港" },
  { id: "Asia/Taipei",       label: "台北" },
  { id: "Asia/Tokyo",        label: "东京" },
  { id: "Asia/Seoul",        label: "首尔" },
  { id: "Asia/Singapore",    label: "新加坡" },
  { id: "Asia/Bangkok",      label: "曼谷" },
  { id: "Asia/Kolkata",      label: "印度（加尔各答）" },
  { id: "Asia/Dubai",        label: "迪拜" },
  { id: "UTC",               label: "协调世界时 UTC" },
  { id: "Europe/London",     label: "伦敦（夏令时）" },
  { id: "Europe/Paris",      label: "巴黎（夏令时）" },
  { id: "Europe/Berlin",     label: "柏林（夏令时）" },
  { id: "Europe/Moscow",     label: "莫斯科" },
  { id: "America/New_York",  label: "纽约（夏令时）" },
  { id: "America/Chicago",   label: "芝加哥（夏令时）" },
  { id: "America/Denver",    label: "丹佛（夏令时）" },
  { id: "America/Los_Angeles", label: "洛杉矶（夏令时）" },
  { id: "America/Sao_Paulo", label: "圣保罗" },
  { id: "Australia/Sydney",  label: "悉尼（夏令时）" },
  { id: "Pacific/Auckland",  label: "奥克兰（夏令时）" },
];

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

export type TimezoneOption = { id: string; label: string; offset: string };

export function listTimezones(): TimezoneOption[] {
  return ZONES.map(({ id, label }) => ({ id, label, offset: currentOffset(id) }));
}
