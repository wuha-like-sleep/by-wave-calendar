// Natural-language event parsing, shared by ALL clients (web + iOS + Android
// + desktop) via POST /api/v1/parse-event, and by the web app's live preview
// through the browser bundle that scripts/build-nl-bundle.mjs compiles from
// this very file. ONE parser, one place to fix a bug.
//
// Languages: the vocabulary lives in nl_vocab.ts and covers all eight locales
// the product ships (zh-CN, zh-TW, en, ja, ko, es, fr, de). Input is not
// tagged with a locale — people mix languages ("明天 3pm 开会") and a wrong
// guess parses worse than no guess, so every table is tried against every
// input. See nl_vocab.ts for how cross-language collisions are kept honest.
//
// Timezone contract: everything is WALL-CLOCK. The caller passes its current
// local time (`now`, as naive local parts); we do all arithmetic in a
// UTC-anchored Date (getUTC*/setUTC*) purely so the SERVER's own timezone can
// never leak into the result. We return naive local "YYYY-MM-DDTHH:mm:ss"
// strings that a client drops straight into a datetime-local field. The server
// stays entirely tz-agnostic.

import {
  alt, REL_DAYS, WEEKDAYS, WEEK_SHIFT, PERIODS, PERIOD_DEFAULT_HOUR, applyPeriod,
  AT_PREFIX, HOUR_SUFFIX, MIN_SUFFIX, AM, PM, RANGE_SEP, RANGE_OPEN,
  HOUR_UNIT, MINUTE_UNIT, ONE_UNIT_WORDS, HALF_HOUR, AND_A_HALF, MONTHS,
  NEXT_BEFORE_WEEKDAY,
  CJK_DIGITS, SPELLED_NUMBERS, NUM_CHAR, type Period,
} from "./nl_vocab.js";

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

/** All patterns are matched case-insensitively and with Unicode property
 *  escapes (tok() uses \p{L}), so every regex is built through this. */
function re(source: string): RegExp {
  return new RegExp(source, "iu");
}

// CJK numeral → number, for 0..59 (hours + minutes). Also accepts an
// all-ASCII-digit string, and small spelled-out Latin cardinals, so callers
// can pass any form. Returns NaN on anything it can't read.
function readNumber(s: string): number {
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(s)) return Number(s);
  const lower = s.toLowerCase();
  if (lower in SPELLED_NUMBERS) return SPELLED_NUMBERS[lower]!;
  if (s === "十") return 10;
  const i = s.indexOf("十");
  if (i === -1) {
    let n = 0;
    for (const ch of s) {
      if (!(ch in CJK_DIGITS)) return NaN;
      n = n * 10 + CJK_DIGITS[ch]!;
    }
    return n;
  }
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  const tens = before === "" ? 1 : (before in CJK_DIGITS ? CJK_DIGITS[before]! : NaN);
  const ones = after === "" ? 0 : (after in CJK_DIGITS ? CJK_DIGITS[after]! : NaN);
  if (isNaN(tens) || isNaN(ones)) return NaN;
  return tens * 10 + ones;
}

// The minutes half of a "X点Y" token: "半"→30, "一刻"/"三刻"→15/45, else the
// numeral (with an optional trailing 分/분). Unreadable → 0.
function parseMinToken(g: string | undefined): number {
  if (!g) return 0;
  if (g === "半" || g === "반") return 30;
  if (g.endsWith("刻")) {
    const q = readNumber(g.slice(0, -1));
    return isNaN(q) ? 0 : q * 15;
  }
  const n = readNumber(g.replace(/(?:分|분|min(?:ute[sn]?)?)$/i, "").trim());
  return isNaN(n) ? 0 : n;
}

/** Format a UTC-anchored Date back to a naive local wall-clock string. */
function fmt(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const MS_DAY = 86_400_000;

// A numeral run: ASCII digits (optionally decimal), a CJK numeral run, or a
// spelled-out Latin cardinal.
const SPELLED_ALT = Object.keys(SPELLED_NUMBERS).sort((a, b) => b.length - a.length).join("|");
const NUMERAL = `(?:[0-9]{1,3}(?:\\.[0-9]+)?|${NUM_CHAR}{1,3}|${SPELLED_ALT})`;

// Precompiled period alternation, plus a lookup from matched text → Period.
const PERIOD_ALT = `(?:${PERIODS.map(([p]) => p).join("|")})`;
function periodOf(text: string | undefined): Period | null {
  if (!text) return null;
  for (const [pattern, period] of PERIODS) {
    if (re(`^(?:${pattern})$`).test(text.trim())) return period;
  }
  return null;
}

/**
 * Parse a natural-language phrase — "明天下午3点 牙医", "lunch with Ana
 * tomorrow at 1pm", "Zahnarzt morgen 15 Uhr", "회의 내일 오후 3시" — into
 * event fields. Returns null when there isn't at least a date OR a time to
 * anchor on, so callers can fall back to a blank form.
 */
export function parseNaturalLanguageEvent(text: string, now?: string | Date): ParsedEvent | null {
  if (!text || typeof text !== "string") return null;
  // Pad so the spaced-fallback rules below (e.g. standalone "半") still work;
  // the token rules themselves no longer require whitespace boundaries, so
  // connected input like "明天下午三点开会" parses too.
  let remaining = " " + text.trim() + " ";

  // Colloquial normalization — fold spoken variants onto the canonical
  // tokens the tables understand. Lookaheads keep the replacements from
  // mangling summary text (去教堂做礼拜 must NOT become 做周).
  remaining = remaining
    .replace(/(星期|禮拜|礼拜)(?=[一二三四五六日天末])/g, "周")
    .replace(/(?<=[下本这這])(星期|禮拜|礼拜)/g, "周")
    .replace(/今晚/g, "今天晚上")
    .replace(/明晚/g, "明天晚上")
    .replace(/今早/g, "今天早上")
    .replace(/明早/g, "明天早上")
    .replace(/钟头|鐘頭/g, "小时")
    .replace(/俩(?=个?(小时|分钟))/g, "两")
    .replace(/仨(?=个?(小时|分钟))/g, "三")
    // 周末 alone means "the weekend" — treat as Saturday, like the old table.
    .replace(/周末|週末/g, "周六");

  const nowAnchor = anchorNow(now);
  // Midnight of "today" in the caller's wall-clock.
  const day = new Date(Date.UTC(nowAnchor.getUTCFullYear(), nowAnchor.getUTCMonth(), nowAnchor.getUTCDate()));
  const dow = nowAnchor.getUTCDay();

  // ── Step 1: date ────────────────────────────────────────────────────────
  let dateOffset: number | null = null;

  // 1a. Relative day words. REL_DAYS is ordered longest-first so
  //     "day after tomorrow" wins over "tomorrow".
  for (const [pattern, off] of REL_DAYS) {
    const r = re(alt([pattern]));
    if (r.test(remaining)) {
      dateOffset = off;
      remaining = remaining.replace(r, " ");
      break;
    }
  }

  // 1b. Weekday, optionally prefixed by a week shift ("next Friday",
  //     "下周五", "다음 주 금요일"). A bare weekday always means the
  //     UPCOMING one, never today.
  if (dateOffset === null) {
    for (const [pattern, target] of WEEKDAYS) {
      const wdRe = re(alt([pattern]));
      const m = remaining.match(wdRe);
      if (!m) continue;
      let shift = 0;
      // Look for a shift word immediately before, or anywhere in the text
      // for languages that put it after ("viernes de la semana que viene").
      for (const [shiftPattern, weeks] of WEEK_SHIFT) {
        const sRe = re(alt([shiftPattern]));
        if (sRe.test(remaining)) {
          shift = weeks;
          remaining = remaining.replace(sRe, " ");
          break;
        }
      }
      // A bare "next friday" / "próximo viernes" / "nächsten Montag".
      // Only meaningful next to a weekday, hence checked here and not in the
      // standalone week-shift pass.
      if (shift === 0) {
        const nextRe = re(alt([NEXT_BEFORE_WEEKDAY.join("|")]));
        if (nextRe.test(remaining)) {
          shift = 7;
          remaining = remaining.replace(nextRe, " ");
        }
      }
      let diff = (target - dow + 7) % 7;
      if (diff === 0) diff = 7; // upcoming, not today
      dateOffset = diff + shift;
      remaining = remaining.replace(wdRe, " ");
      break;
    }
  }

  // 1c. A week shift with no weekday ("下周", "next week") → that week's Monday.
  if (dateOffset === null) {
    for (const [pattern, weeks] of WEEK_SHIFT) {
      if (weeks === 0) continue; // "this week" alone carries no date
      const r = re(alt([pattern]));
      if (r.test(remaining)) {
        let diff = (1 - dow + 7) % 7;
        if (diff === 0) diff = 7;
        dateOffset = diff + weeks - 7;
        remaining = remaining.replace(r, " ");
        break;
      }
    }
  }

  // 1d. "X天后 / in 3 days / dans 3 jours / in 3 Tagen / en 3 días".
  if (dateOffset === null) {
    const inDays = [
      `(${NUMERAL})\\s*(?:天|日|일)\\s*[以之]?後|(${NUMERAL})\\s*天[以之]?后`,
      `(?:in|en|dans|nach)\\s+(${NUMERAL})\\s*(?:days?|d[íi]as?|jours?|tagen?)`,
      `(${NUMERAL})\\s*(?:days?|d[íi]as?|jours?|tagen?)\\s+(?:later|from now|despu[ée]s|plus tard|sp[äa]ter)`,
    ];
    for (const src of inDays) {
      const r = re(src);
      const m = remaining.match(r);
      if (!m) continue;
      const raw = m.slice(1).find((g) => g !== undefined);
      const n = raw ? readNumber(raw) : NaN;
      if (!isNaN(n) && n > 0 && n < 400) {
        dateOffset = Math.round(n);
        remaining = remaining.replace(r, " ");
        break;
      }
    }
  }

  // 1e. Numeric month/day: "3月5日", "3월 5일", "3/5", "5.3." (de).
  if (dateOffset === null) {
    const mdRe = re("([0-9]{1,2})\\s*(?:月|월)\\s*([0-9]{1,2})\\s*(?:日|号|號|일)?");
    const m = remaining.match(mdRe);
    if (m) {
      dateOffset = offsetForMonthDay(Number(m[1]) - 1, Number(m[2]), nowAnchor, day);
      remaining = remaining.replace(mdRe, " ");
    }
  }

  // 1f. Named month + day, either order: "March 5", "5 de marzo",
  //     "5 mars", "5. März".
  if (dateOffset === null) {
    for (const [pattern, month] of MONTHS) {
      const monthAlt = alt([pattern]);
      const forms = [
        re(`${monthAlt}\\s*\\.?\\s*([0-9]{1,2})(?:st|nd|rd|th)?`),          // March 5
        re(`([0-9]{1,2})\\s*\\.?\\s*(?:de\\s+|of\\s+)?${monthAlt}`),        // 5 de marzo
      ];
      let hit = false;
      for (const r of forms) {
        const m = remaining.match(r);
        if (!m) continue;
        const d = Number(m[1]);
        if (d < 1 || d > 31) continue;
        dateOffset = offsetForMonthDay(month - 1, d, nowAnchor, day);
        remaining = remaining.replace(r, " ");
        hit = true;
        break;
      }
      if (hit) break;
    }
  }

  // 1g. "下个月X号 / 这个月X号" month-relative dates.
  if (dateOffset === null) {
    const relMonthRe = /(下下个月|下下個月|下个月|下個月|这个月|這個月|本月)(\d{1,2})[日号號]/;
    const m = remaining.match(relMonthRe);
    if (m) {
      const addMonths = m[1]!.includes("下下") ? 2 : m[1]!.startsWith("下") ? 1 : 0;
      const tgt = Date.UTC(nowAnchor.getUTCFullYear(), nowAnchor.getUTCMonth() + addMonths, Number(m[2]));
      dateOffset = Math.round((tgt - day.getTime()) / MS_DAY);
      remaining = remaining.replace(relMonthRe, " ");
    }
  }

  // 1h. Bare "X号" → this month, or next month when already passed
  //     ("15号交房租"). Digits-only on purpose — 三号楼 stays in the summary.
  if (dateOffset === null) {
    const bareDayRe = /(?<![0-9月月])([0-9]{1,2})[号號]/;
    const m = remaining.match(bareDayRe);
    if (m) {
      const d = Number(m[1]);
      if (d >= 1 && d <= 31) {
        let tgt = Date.UTC(nowAnchor.getUTCFullYear(), nowAnchor.getUTCMonth(), d);
        if (tgt < day.getTime()) tgt = Date.UTC(nowAnchor.getUTCFullYear(), nowAnchor.getUTCMonth() + 1, d);
        dateOffset = Math.round((tgt - day.getTime()) / MS_DAY);
        remaining = remaining.replace(bareDayRe, " ");
      }
    }
  }

  // ── Step 2: time ────────────────────────────────────────────────────────
  let hours: number | null = null;
  let mins = 0;
  let durationFromRange: number | null = null;

  // A clock time in any supported shape. Captures:
  //   1 period-before, 2 hour, 3 minutes-with-colon, 4 minutes-adjacent,
  //   5 minutes-spaced, 6 am/pm, 7 period-after
  //
  // Two things this shape is deliberately careful about:
  //
  // Minutes must be either glued to the hour word (CJK writes "3点半",
  // "十点二十") or, when separated by a space, carry an explicit minute unit
  // ("3시 30분"). A bare number after whitespace would let the clock swallow
  // the following duration token — "9点 30分钟 站会" would become 09:30 with
  // the summary "钟 站会".
  //
  // A bare hour with no colon and no hour word is only accepted when
  // something else proves it is a time: a following am/pm ("3pm") or a
  // following period word ("3 de la tarde", "3 in the afternoon"). Without
  // that guard "meeting 5 people" would book 05:00.
  const HOUR_NUM = `(?:[0-9]{1,2}(?![0-9])|${NUM_CHAR}{1,3}|${SPELLED_ALT})`;
  const clockPattern = (allowBareHour: boolean) =>
    `(${PERIOD_ALT})?\\s*${AT_PREFIX}` +
    `(${HOUR_NUM})` +
    `(?:` +
      `\\s*[:：h]\\s*([0-9]{2})` +
      `|\\s*${HOUR_SUFFIX}(?:(半|반|${NUM_CHAR}{1,3}刻|[0-9]{1,2}${MIN_SUFFIX}?|${NUM_CHAR}{1,3}${MIN_SUFFIX}?)` +
        `|\\s+([0-9]{1,2}\\s*${MIN_SUFFIX}))?` +
      (allowBareHour ? "|" : `|(?=\\s*(?:${AM}|${PM}|${PERIOD_ALT}))`) +
    `)` +
    `\\s*(${AM}|${PM})?\\s*(${PERIOD_ALT})?`;
  const CLOCK = clockPattern(false);
  /** How many capture groups clockPattern() emits — slice() sites depend on it. */
  const CLOCK_GROUPS = 7;

  /** Turn one CLOCK match's 7 capture groups into {h, m}, or null if invalid. */
  function readClock(g: (string | undefined)[]): { h: number; m: number } | null {
    const [periodBefore, hourRaw, colonMin, adjacentMin, spacedMin, meridiem, periodAfter] = g;
    let h = readNumber(hourRaw!);
    if (isNaN(h)) return null;
    const m = colonMin !== undefined ? Number(colonMin) : parseMinToken(adjacentMin ?? spacedMin);
    if (meridiem) {
      const isPm = re(`^${PM}$`).test(meridiem);
      if (isPm && h < 12) h += 12;
      else if (!isPm && h === 12) h = 0; // 12am → 00
    } else {
      h = applyPeriod(periodOf(periodBefore) ?? periodOf(periodAfter), h);
    }
    if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) return null;
    return { h, m };
  }

  // 2a. Range first — "下午3点到5点", "3-5pm", "von 15 bis 17 Uhr" — so the
  //     single-time rule below doesn't eat the start and leave "到5点" in the
  //     summary.
  // Inside a range, both ends may be bare numerals ("workshop 2-4pm",
  // "from 3 to 5"): the separator plus a second clock is evidence enough,
  // and the start usually leaves the am/pm to the end.
  const RANGE_CLOCK = clockPattern(true);
  const rangeRe = re(`${RANGE_OPEN}${RANGE_CLOCK}${RANGE_SEP}${RANGE_CLOCK}`);
  const rMatch = remaining.match(rangeRe);
  if (rMatch) {
    const aRaw: (string | undefined)[] = rMatch.slice(1, 1 + CLOCK_GROUPS);
    const bRaw: (string | undefined)[] = rMatch.slice(1 + CLOCK_GROUPS, 1 + CLOCK_GROUPS * 2);
    // Whichever end states a period/meridiem lends it to the other. Both
    // directions occur in the wild: "下午3点到5点" puts it on the start,
    // "2-4pm" puts it on the end.
    const statesPeriod = (g: (string | undefined)[]) =>
      g[0] !== undefined || g[5] !== undefined || g[6] !== undefined;
    const lend = (from: (string | undefined)[], to: (string | undefined)[]) => {
      to[0] = from[0]; to[5] = from[5]; to[6] = from[6];
    };
    if (statesPeriod(aRaw) && !statesPeriod(bRaw)) lend(aRaw, bRaw);
    else if (statesPeriod(bRaw) && !statesPeriod(aRaw)) lend(bRaw, aRaw);
    const a = readClock(aRaw);
    const b = a ? readClock(bRaw) : null;
    if (a && b) {
      let endH = b.h;
      if (endH * 60 + b.m <= a.h * 60 + a.m && endH < 12) endH += 12; // 10到2点 → 14
      const dur = (endH * 60 + b.m) - (a.h * 60 + a.m);
      if (dur > 0) {
        hours = a.h; mins = a.m;
        durationFromRange = dur;
        remaining = remaining.replace(rangeRe, " ");
      }
    }
  }

  // 2b. Single time.
  if (hours === null) {
    const clockRe = re(CLOCK);
    const m = remaining.match(clockRe);
    if (m) {
      const c = readClock(m.slice(1, 1 + CLOCK_GROUPS));
      if (c) {
        hours = c.h; mins = c.m;
        remaining = remaining.replace(clockRe, " ");
      }
    }
  }

  // 2c. Period word with no explicit hour — "明天下午开会" / "tomorrow
  //     evening" should land on a sensible colloquial default, not 09:00.
  if (hours === null) {
    for (const [pattern, period] of PERIODS) {
      const r = re(alt([pattern]));
      if (r.test(remaining)) {
        hours = PERIOD_DEFAULT_HOUR[period];
        mins = 0;
        remaining = remaining.replace(r, " ");
        break;
      }
    }
  }

  // 2d. "半点" with the 半 split off by whitespace, e.g. "下午3点 半".
  const halfRe = /\s(?:半|반)\s/;
  if (halfRe.test(remaining) && hours !== null && mins === 0) {
    mins = 30;
    remaining = remaining.replace(halfRe, " ");
  }

  // Need at least a date OR time to count this as a successful parse.
  if (dateOffset === null && hours === null) return null;

  // ── Step 3: duration ────────────────────────────────────────────────────
  let durationMin = 60;
  let durSet = false;
  if (durationFromRange !== null) { durationMin = durationFromRange; durSet = true; }

  // 3a. "X个半小时" / "1時間半" / "an hour and a half" / "1.5 hours".
  if (!durSet) {
    const r = re(`(${NUMERAL})\\s*(?:${AND_A_HALF.join("|")})`);
    const m = remaining.match(r);
    if (m) {
      const n = readNumber(m[1]!.replace(/\.5$/, ""));
      if (!isNaN(n)) {
        durationMin = Math.round(n) * 60 + 30;
        durSet = true;
        remaining = remaining.replace(r, " ");
      }
    }
  }

  // 3b. Plain "X小时 / X hours / X Stunden / X分钟 / X minutes".
  if (!durSet) {
    const r = re(`(${NUMERAL})\\s*(?:个|個)?\\s*(${HOUR_UNIT}|${MINUTE_UNIT})`);
    const m = remaining.match(r);
    if (m) {
      const n = readNumber(m[1]!);
      const isHour = re(`^${HOUR_UNIT}$`).test(m[2]!);
      if (!isNaN(n)) {
        durationMin = isHour ? Math.round(n * 60) : Math.round(n);
        durSet = true;
        remaining = remaining.replace(r, " ");
      }
    }
  }

  // 3c. Half-hour phrases with no numeral ("half an hour", "media hora").
  if (!durSet) {
    const r = re(`(?:${HALF_HOUR.join("|")})`);
    if (r.test(remaining)) {
      durationMin = 30;
      durSet = true;
      remaining = remaining.replace(r, " ");
    }
  }

  // 3d. Count-less singular ("an hour", "une heure", "eine Stunde").
  if (!durSet) {
    const r = re(`${alt([ONE_UNIT_WORDS])}\\s*(${HOUR_UNIT}|${MINUTE_UNIT})`);
    const m = remaining.match(r);
    if (m) {
      durationMin = re(`^${HOUR_UNIT}$`).test(m[1]!) ? 60 : 1;
      durSet = true;
      remaining = remaining.replace(r, " ");
    }
  }

  // ── Step 4: build the datetime (UTC-anchored wall-clock) ────────────────
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

  // ── Step 5: leftover text is the summary ────────────────────────────────
  // Grammatical filler stranded once the date/time tokens were consumed
  // ("comida al mediodía" leaves "al", "a las 3" leaves "a las"). Only
  // removed when it stands alone between spaces, so a title that is genuinely
  // just "de" survives.
  const FILLER = alt([
    "on|at|the|from|a\\s+las|a\\s+la|al|a|de|del|la|el|los|por|en" +
    "|à|au|aux|le|les|du|des|d'|um|am|im|den|dem|der|dies(?:er|e)?",
  ]);
  let summary = remaining.replace(/[，。、；：,;:]+/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = summary.replace(re(`(?:^|\\s)${FILLER}(?=\\s|$)`), " ").replace(/\s+/g, " ").trim();
    if (next === summary) break;
    summary = next;
  }
  return { summary, startsAt: fmt(startsAt), endsAt: fmt(endsAt) };
}

/** Days from `day` to the next occurrence of month/date (this year or next). */
function offsetForMonthDay(monthIdx: number, date: number, nowAnchor: Date, day: Date): number {
  let tgt = Date.UTC(nowAnchor.getUTCFullYear(), monthIdx, date);
  if (tgt < day.getTime()) tgt = Date.UTC(nowAnchor.getUTCFullYear() + 1, monthIdx, date);
  return Math.round((tgt - day.getTime()) / MS_DAY);
}
