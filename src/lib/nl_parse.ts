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

// Chinese numeral → number, for 0..59 (hours + minutes). Also accepts an
// all-ASCII-digit string so callers can pass either form. Returns NaN on
// anything it can't read.
const CN_DIGIT: Record<string, number> = {
  "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};
function cnNum(s: string): number {
  if (/^[0-9]+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const i = s.indexOf("十");
  if (i === -1) {
    let n = 0;
    for (const ch of s) {
      if (!(ch in CN_DIGIT)) return NaN;
      n = n * 10 + CN_DIGIT[ch]!;
    }
    return n;
  }
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  const tens = before === "" ? 1 : (before in CN_DIGIT ? CN_DIGIT[before]! : NaN);
  const ones = after === "" ? 0 : (after in CN_DIGIT ? CN_DIGIT[after]! : NaN);
  if (isNaN(tens) || isNaN(ones)) return NaN;
  return tens * 10 + ones;
}

// The minutes half of a "X点Y" token: "半"→30, "一刻"/"三刻"→15/45, else the
// numeral (with an optional trailing 分). Unreadable → 0.
function parseMinToken(g: string | undefined): number {
  if (!g) return 0;
  if (g === "半") return 30;
  if (g.endsWith("刻")) {
    const q = cnNum(g.slice(0, -1));
    return isNaN(q) ? 0 : q * 15;
  }
  const n = cnNum(g.replace(/分$/, ""));
  return isNaN(n) ? 0 : n;
}

// Character class for an ASCII-or-Chinese numeral run (used inside the regexes).
const NUM = "[0-9零〇一二两三四五六七八九十]";

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
  // Pad so the spaced-fallback rules below (e.g. standalone "半") still work;
  // the token rules themselves no longer require whitespace boundaries, so
  // connected input like "明天下午三点开会" parses too.
  let remaining = " " + text.trim() + " ";

  const nowAnchor = anchorNow(now);
  // Midnight of "today" in the caller's wall-clock.
  const day = new Date(Date.UTC(nowAnchor.getUTCFullYear(), nowAnchor.getUTCMonth(), nowAnchor.getUTCDate()));
  const dow = nowAnchor.getUTCDay();

  // Step 1: date. Longer words come first because they contain shorter ones
  // (大后天 ⊃ 后天) and there are no whitespace guards to keep them apart.
  let dateOffset: number | null = null;
  const dateRules: [RegExp, number][] = [
    [/大后天/, 3], [/后天/, 2], [/明天/, 1], [/今天/, 0],
    [/前天/, -2], [/昨天/, -1],
  ];
  for (const [re, off] of dateRules) {
    if (re.test(remaining)) {
      dateOffset = off;
      remaining = remaining.replace(re, " ");
      break;
    }
  }
  // 周一..周日 / 周天 / 周末 → next occurrence (never today); 下周X +7, 下下周X +14.
  const weekdayMap: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0, "末": 6 };
  const wkRe = /(下下周|下周|本周|这周|周)([一二三四五六日天末])/;
  const wkMatch = remaining.match(wkRe);
  if (wkMatch && dateOffset === null) {
    const target = weekdayMap[wkMatch[2]!]!;
    let diff = (target - dow + 7) % 7;
    if (diff === 0) diff = 7; // 周X always means upcoming, not today
    if (wkMatch[1] === "下周") diff += 7;
    else if (wkMatch[1] === "下下周") diff += 14;
    dateOffset = diff;
    remaining = remaining.replace(wkRe, " ");
  }
  // X月X日 / X月X号
  const mdRe = /(\d{1,2})月(\d{1,2})[日号]?/;
  const mdMatch = remaining.match(mdRe);
  if (mdMatch && dateOffset === null) {
    const mo = Number(mdMatch[1]) - 1;
    const d = Number(mdMatch[2]);
    let tgt = Date.UTC(nowAnchor.getUTCFullYear(), mo, d);
    if (tgt < day.getTime()) tgt = Date.UTC(nowAnchor.getUTCFullYear() + 1, mo, d);
    dateOffset = Math.round((tgt - day.getTime()) / MS_DAY);
    remaining = remaining.replace(mdRe, " ");
  }

  // Step 2: time. Two forms, tried in order:
  //   colon:  "15:30", "下午3:30"
  //   点/时:   "下午3点", "晚上八点半", "十点二十", "3点一刻"
  // Both accept an optional period prefix and ASCII-or-Chinese numerals.
  let hours: number | null = null;
  let mins = 0;
  const PERIOD = "(早上|上午|中午|下午|晚上|凌晨)?";
  const colonRe = new RegExp(PERIOD + "([0-9]{1,2})[:：]([0-9]{2})");
  const dianRe = new RegExp(
    PERIOD + "(" + NUM + "{1,3})[点时](半|" + NUM + "{1,3}刻|[0-9]{1,2}分?|" + NUM + "{1,3}分?)?",
  );
  let tMatch = remaining.match(colonRe);
  let matchedRe: RegExp | null = tMatch ? colonRe : null;
  if (!tMatch) { tMatch = remaining.match(dianRe); if (tMatch) matchedRe = dianRe; }
  if (tMatch && matchedRe) {
    const period = tMatch[1];
    let h = cnNum(tMatch[2]!);
    const m = matchedRe === colonRe ? Number(tMatch[3]) : parseMinToken(tMatch[3]);
    if (period === "下午" || period === "晚上") { if (h < 12) h += 12; }
    else if (period === "凌晨") { if (h === 12) h = 0; }
    else if (period === "中午") { h = 12; }
    if (!isNaN(h) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hours = h; mins = m;
      remaining = remaining.replace(matchedRe, " ");
    }
  }
  // "半点" with the 半 split off by whitespace, e.g. "下午3点 半".
  const halfRe = /\s半\s/;
  if (halfRe.test(remaining) && hours !== null && mins === 0) {
    mins = 30;
    remaining = remaining.replace(halfRe, " ");
  }

  // Need at least a date OR time to count this as a successful parse.
  if (dateOffset === null && hours === null) return null;

  // Step 3: duration. "X个半小时" first (X·60+30), then plain "X小时/X分钟"
  // (ASCII or Chinese, optional 个), then a bare "半小时" fallback.
  let durationMin = 60;
  let durSet = false;
  const durHalfRe = new RegExp("([0-9]+|" + NUM + "+)个?半个?小时");
  const durHalfM = remaining.match(durHalfRe);
  if (durHalfM) {
    const n = cnNum(durHalfM[1]!);
    if (!isNaN(n)) { durationMin = n * 60 + 30; durSet = true; remaining = remaining.replace(durHalfRe, " "); }
  }
  if (!durSet) {
    const durRe = new RegExp("([0-9]+(?:\\.[0-9]+)?|" + NUM + "+)\\s?个?\\s?(小时|h|hours?|分钟|min|minutes?)", "i");
    const durMatch = remaining.match(durRe);
    if (durMatch) {
      const n = /^[0-9.]+$/.test(durMatch[1]!) ? Number(durMatch[1]) : cnNum(durMatch[1]!);
      const unit = durMatch[2]!.toLowerCase();
      if (!isNaN(n)) {
        durationMin = (unit.startsWith("小时") || unit === "h" || unit.startsWith("hour"))
          ? Math.round(n * 60)
          : Math.round(n);
        durSet = true;
        remaining = remaining.replace(durRe, " ");
      }
    }
  }
  if (!durSet) {
    const halfHourRe = /半个?小时/;
    if (halfHourRe.test(remaining)) { durationMin = 30; remaining = remaining.replace(halfHourRe, " "); }
  }

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
  const summary = remaining.replace(/[，。、；：,;:]+/g, " ").replace(/\s+/g, " ").trim();
  return { summary, startsAt: fmt(startsAt), endsAt: fmt(endsAt) };
}
