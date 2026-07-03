// Natural-language event parsing, shared by ALL clients (web + iOS + Android
// + desktop) via POST /api/v1/parse-event. Ported from the original
// client-side parser in src/public/calendar-app.js so we maintain ONE parser
// instead of reimplementing it in Swift + Kotlin ×2.
//
// Timezone contract: everything is WALL-CLOCK. The caller passes its current
// local time (`now`, as naive local parts); we do all arithmetic in a
// UTC-anchored Date (getUTC*/setUTC*) purely so the SERVER's own timezone can
// never leak into the result. We return naive local "YYYY-MM-DDTHH:mm:ss"
// strings that a client drops straight into a datetime-local field. The server
// stays entirely tz-agnostic.

export type ParsedEvent = {
  summary: string;
  /** naive local wall-clock, "YYYY-MM-DDTHH:mm:ss" */
  startsAt: string;
  /** naive local wall-clock, "YYYY-MM-DDTHH:mm:ss" */
  endsAt: string;
};

/** Parse "now" (an ISO-ish local string, or Date) into a UTC-anchored Date
 *  whose UTC fields equal the caller's local wall-clock. Falls back to the
 *  server clock if nothing usable is given (clients should always send it). */
function anchorNow(now: string | Date | undefined): Date {
  if (now instanceof Date && !isNaN(now.getTime())) {
    return new Date(Date.UTC(
      now.getFullYear(), now.getMonth(), now.getDate(),
      now.getHours(), now.getMinutes(), now.getSeconds(),
    ));
  }
  if (typeof now === "string") {
    // Accept "YYYY-MM-DDTHH:mm(:ss)?" (optionally with trailing Z/offset which
    // we ignore — we treat the parts as local wall-clock on purpose).
    const m = now.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      return new Date(Date.UTC(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0,
      ));
    }
  }
  const d = new Date();
  return new Date(Date.UTC(
    d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(),
  ));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a UTC-anchored Date back to a naive local wall-clock string. */
function fmt(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const MS_DAY = 86_400_000;

/**
 * Parse a Chinese natural-language phrase like "明天下午3点 牙医" or
 * "周五10点 1小时 团建" into event fields. Returns null when there isn't at
 * least a date OR a time to anchor on (so callers can fall back to a blank form).
 */
export function parseNaturalLanguageEvent(text: string, now?: string | Date): ParsedEvent | null {
  if (!text || typeof text !== "string") return null;
  let remaining = " " + text.trim() + " "; // pad so word boundaries are easy

  const nowAnchor = anchorNow(now);
  // Midnight of "today" in the caller's wall-clock.
  const day = new Date(Date.UTC(nowAnchor.getUTCFullYear(), nowAnchor.getUTCMonth(), nowAnchor.getUTCDate()));
  const dow = nowAnchor.getUTCDay();

  // Step 1: date.
  let dateOffset: number | null = null;
  const dateRules: [RegExp, number][] = [
    [/\s今天\s/, 0], [/\s明天\s/, 1], [/\s后天\s/, 2], [/\s大后天\s/, 3],
    [/\s昨天\s/, -1], [/\s前天\s/, -2],
  ];
  for (const [re, off] of dateRules) {
    if (re.test(remaining)) {
      dateOffset = off;
      remaining = remaining.replace(re, " ");
      break;
    }
  }
  // 周一..周日 / 周天 → next occurrence (never today); 下周X forces +7.
  const weekdayMap: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 };
  const wkRe = /\s(本周|下周|周)([一二三四五六日天])\s/;
  const wkMatch = remaining.match(wkRe);
  if (wkMatch && dateOffset === null) {
    const target = weekdayMap[wkMatch[2]!]!;
    let diff = (target - dow + 7) % 7;
    if (diff === 0) diff = 7; // 周X always means upcoming, not today
    if (wkMatch[1] === "下周") diff += 7;
    dateOffset = diff;
    remaining = remaining.replace(wkRe, " ");
  }
  // X月X日 / X月X号
  const mdRe = /\s(\d{1,2})月(\d{1,2})[日号]?\s/;
  const mdMatch = remaining.match(mdRe);
  if (mdMatch && dateOffset === null) {
    const mo = Number(mdMatch[1]) - 1;
    const d = Number(mdMatch[2]);
    let tgt = Date.UTC(nowAnchor.getUTCFullYear(), mo, d);
    if (tgt < day.getTime()) tgt = Date.UTC(nowAnchor.getUTCFullYear() + 1, mo, d);
    dateOffset = Math.round((tgt - day.getTime()) / MS_DAY);
    remaining = remaining.replace(mdRe, " ");
  }

  // Step 2: time.
  let hours: number | null = null;
  let mins = 0;
  const tRe = /\s(早上|上午|中午|下午|晚上|凌晨)?(\d{1,2})(?:[点时:：](\d{1,2})?分?)?\s/;
  const tMatch = remaining.match(tRe);
  if (tMatch) {
    const period = tMatch[1];
    let h = Number(tMatch[2]);
    const m = tMatch[3] ? Number(tMatch[3]) : 0;
    if (period === "下午" || period === "晚上") { if (h < 12) h += 12; }
    else if (period === "凌晨") { if (h === 12) h = 0; }
    else if (period === "中午") { h = 12; }
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hours = h; mins = m;
      remaining = remaining.replace(tRe, " ");
    }
  }
  // "半点" e.g. "下午3点半"
  const halfRe = /\s半\s/;
  if (halfRe.test(remaining) && hours !== null && mins === 0) {
    mins = 30;
    remaining = remaining.replace(halfRe, " ");
  }

  // Need at least a date OR time to count this as a successful parse.
  if (dateOffset === null && hours === null) return null;

  // Step 3: duration.
  let durationMin = 60;
  const durRe = /\s(\d+(?:\.\d+)?)\s?(小时|h|hours?|分钟|min|minutes?)\s/i;
  const durMatch = remaining.match(durRe);
  if (durMatch) {
    const n = Number(durMatch[1]);
    const unit = durMatch[2]!.toLowerCase();
    durationMin = (unit.startsWith("小时") || unit === "h" || unit.startsWith("hour"))
      ? Math.round(n * 60)
      : Math.round(n);
    remaining = remaining.replace(durRe, " ");
  }
  const halfHourRe = /\s半小时\s/;
  if (halfHourRe.test(remaining)) { durationMin = 30; remaining = remaining.replace(halfHourRe, " "); }

  // Step 4: build the datetime (UTC-anchored wall-clock).
  const startsAt = new Date(day.getTime());
  if (dateOffset !== null) startsAt.setUTCDate(startsAt.getUTCDate() + dateOffset);
  if (hours === null) {
    startsAt.setUTCHours(9, 0, 0, 0); // date but no time → 09:00, 1h
  } else {
    startsAt.setUTCHours(hours, mins, 0, 0);
    // No date + time already passed today → push to tomorrow.
    if (dateOffset === null && startsAt.getTime() < nowAnchor.getTime()) {
      startsAt.setUTCDate(startsAt.getUTCDate() + 1);
    }
  }
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);

  // Step 5: leftover text is the summary.
  const summary = remaining.replace(/[，。、；：,;:]+/g, " ").trim();
  return { summary, startsAt: fmt(startsAt), endsAt: fmt(endsAt) };
}
