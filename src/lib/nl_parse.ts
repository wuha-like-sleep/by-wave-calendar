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
  BYDAY_CODES, RECUR_WEEKDAY_CHAR_ZH, RECUR_WEEKDAY_CHAR_JA, RECUR_WEEKDAY_CHAR_KO,
  RECUR_WEEKDAY_PREFIX_LATIN, RECUR_SIMPLE, ALL_DAY_WORDS,
  CJK_DIGITS, SPELLED_NUMBERS, NUM_CHAR, type Period,
} from "./nl_vocab.js";

export type ParsedEvent = {
  summary: string;
  /** naive local wall-clock, "YYYY-MM-DDTHH:mm:ss" */
  startsAt: string;
  /** naive local wall-clock, "YYYY-MM-DDTHH:mm:ss" */
  endsAt: string;
  /**
   * Place named by an explicit location marker ("在星巴克开会",
   * "meeting at Starbucks"). Only set when the marker is unambiguous —
   * a phrase we cannot confidently split keeps the place in the summary.
   * Added later than the original three fields; older clients ignore it.
   */
  location?: string;
  /**
   * Recurrence in the exact shape the create-event API stores in `rrule`
   * ("FREQ=WEEKLY;BYDAY=FR"), when the phrase says the event repeats.
   */
  rrule?: string;
  /** True when the phrase marks the event as all-day ("明天全天开会"). */
  allDay?: boolean;
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

/** 把若干 [start, end) 区段从文本里挖掉（重叠的先合并），每段换成一个空格。 */
function removeSpans(text: string, spans: Array<readonly [number, number]>): string {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    const s = Math.max(start, cursor);
    if (end <= s) continue;
    out += text.slice(cursor, s) + " ";
    cursor = end;
  }
  return out + text.slice(cursor);
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

  // ── Step 0: recurrence + all-day ────────────────────────────────────────
  // These run BEFORE the date step on purpose: "每周五" contains a weekday
  // the date step would otherwise eat as a one-off, and "每月15号" contains
  // a bare day-of-month. Weekday forms are rewritten to the bare weekday
  // ("每周五" → "周五") so step 1b still lands the start date on the upcoming
  // occurrence; the RRULE rides along on the result.
  let rrule: string | null = null;

  // 0a. CJK "every <weekday>": 每周五 / 毎週金曜日 / 매주 금요일.
  if (rrule === null) {
    const zh = remaining.match(/每\s*(?:周|週)\s*([一二三四五六日天])/);
    if (zh) {
      rrule = `FREQ=WEEKLY;BYDAY=${BYDAY_CODES[RECUR_WEEKDAY_CHAR_ZH[zh[1]!]!]}`;
      remaining = remaining.replace(zh[0], ` 周${zh[1]} `);
    }
  }
  if (rrule === null) {
    const ja = remaining.match(/毎週\s*([月火水木金土日])\s*(?:曜日|曜)?/);
    if (ja) {
      rrule = `FREQ=WEEKLY;BYDAY=${BYDAY_CODES[RECUR_WEEKDAY_CHAR_JA[ja[1]!]!]}`;
      remaining = remaining.replace(ja[0], ` ${ja[1]}曜日 `);
    }
  }
  if (rrule === null) {
    const ko = remaining.match(/매주\s*([월화수목금토일])\s*(?:요일)?/);
    if (ko) {
      rrule = `FREQ=WEEKLY;BYDAY=${BYDAY_CODES[RECUR_WEEKDAY_CHAR_KO[ko[1]!]!]}`;
      remaining = remaining.replace(ko[0], ` ${ko[1]}요일 `);
    }
  }

  // 0b. Latin "every <weekday>": every Friday / cada lunes / chaque lundi /
  //     jeden Freitag. Trailing "s" allowed for es/fr plurals; the letter
  //     boundary keeps "every month" from matching the "mon" of Monday.
  //     The matched span is replaced by the ENGLISH weekday name: step 1b
  //     matches it through the English entry no matter what language the
  //     user wrote (a French plural "lundis" would fail 1b's word boundary
  //     if we put the original word back).
  if (rrule === null) {
    const EN_WEEKDAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    for (const [pattern, target] of WEEKDAYS) {
      const r = re(`(?<!\\p{L})(?:${RECUR_WEEKDAY_PREFIX_LATIN})\\s+(?:${pattern})s?(?!\\p{L})`);
      if (!r.test(remaining)) continue;
      rrule = `FREQ=WEEKLY;BYDAY=${BYDAY_CODES[target]!}`;
      remaining = remaining.replace(r, ` ${EN_WEEKDAY[target]} `);
      break;
    }
  }

  // 0c. "每月15号" → monthly, leaving the bare "15号" for step 1h to date.
  if (rrule === null) {
    const md = remaining.match(/每\s*(?:个|個)?\s*月\s*([0-9]{1,2})\s*[号號日]/);
    if (md) {
      rrule = "FREQ=MONTHLY";
      remaining = remaining.replace(md[0], ` ${md[1]}号 `);
    }
  }

  // 0d. Whole-phrase markers （每天 / every week / 毎月 / 매달 / monatlich…).
  if (rrule === null) {
    for (const [pattern, rule] of RECUR_SIMPLE) {
      const r = re(alt([pattern]));
      if (r.test(remaining)) {
        rrule = rule;
        remaining = remaining.replace(r, " ");
        break;
      }
    }
  }

  // 0e. All-day markers. The flag only shapes the result in step 4; an
  //     explicit clock time next to one is contradictory input and the
  //     all-day reading wins (the live preview shows what we understood).
  let allDay = false;
  for (const pattern of ALL_DAY_WORDS) {
    const r = re(alt([pattern]));
    if (r.test(remaining)) {
      allDay = true;
      remaining = remaining.replace(r, " ");
      break;
    }
  }

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
      // 命中的区段先记下来，最后一次性挖掉 —— 不能像以前那样先 replace 位移词
      // 再 replace 星期词：「下周五」里两个词共用一个「周」字，先挖掉「下周」
      // 就只剩一个「五」，第二个 replace 找不到「周五」，那个字会漏进标题
      // （「下周五 9点 打球」的标题曾经是「五 打球」）。日期结果不受影响，
      // 纯粹是标题被污染，所以这里只改挖法、不改任何日期语义。
      const spans: Array<readonly [number, number]> = [[m.index!, m.index! + m[0].length]];
      // Look for a shift word immediately before, or anywhere in the text
      // for languages that put it after ("viernes de la semana que viene").
      for (const [shiftPattern, weeks] of WEEK_SHIFT) {
        const sRe = re(alt([shiftPattern]));
        const sm = remaining.match(sRe);
        if (sm) {
          shift = weeks;
          spans.push([sm.index!, sm.index! + sm[0].length]);
          break;
        }
      }
      // A bare "next friday" / "próximo viernes" / "nächsten Montag".
      // Only meaningful next to a weekday, hence checked here and not in the
      // standalone week-shift pass.
      if (shift === 0) {
        const nextRe = re(alt([NEXT_BEFORE_WEEKDAY.join("|")]));
        const nm = remaining.match(nextRe);
        if (nm) {
          shift = 7;
          spans.push([nm.index!, nm.index! + nm[0].length]);
        }
      }
      let diff = (target - dow + 7) % 7;
      if (diff === 0) diff = 7; // upcoming, not today
      dateOffset = diff + shift;
      remaining = removeSpans(remaining, spans);
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

  // 1g2. "月底 / 下个月底 / 月末 / 월말 / end of month" → the last day of the
  //      (possibly shifted) month. 裸「月底」永远是本月最后一天 —— 它不可能
  //      已经过去，所以没有「过了往下滚」的问题；今天恰好是月底就是今天。
  //      「每月底 / 每个月底」是重复说法，不许在这里吃掉：lookbehind 挡住
  //      每 / 个月 直接领头的那两种，留给重复那一步（它目前锚不住月底，
  //      整体返回 null —— 那是另一个缺口，不在这一步里假装解决）。
  if (dateOffset === null) {
    const monthEndRe = /(?<!每|个月|個月)(下下个月底|下下個月底|下个月底|下個月底|下月底|本月底|这个月底|這個月底|月底|月末|월말|end of next month|end of (?:the )?month)/i;
    const m = remaining.match(monthEndRe);
    if (m) {
      const phrase = m[1]!;
      const addMonths = phrase.includes("下下") ? 2
        : phrase.startsWith("下") || /next/i.test(phrase) ? 1 : 0;
      const tgt = Date.UTC(nowAnchor.getUTCFullYear(), nowAnchor.getUTCMonth() + addMonths + 1, 0);
      dateOffset = Math.round((tgt - day.getTime()) / MS_DAY);
      remaining = remaining.replace(monthEndRe, " ");
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
  // An all-day marker also anchors ("全天开会" = today, all day).
  if (dateOffset === null && hours === null && !allDay) return null;

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
  let endsAt: Date;
  if (allDay) {
    // All-day shape matches what the web form stores: the chosen date at
    // 00:00:00 → 23:59:59. Any clock/range/duration also parsed is dropped.
    startsAt.setUTCHours(0, 0, 0, 0);
    endsAt = new Date(startsAt.getTime());
    endsAt.setUTCHours(23, 59, 59, 0);
  } else if (hours === null) {
    startsAt.setUTCHours(9, 0, 0, 0); // date but no time → 09:00, 1h
    endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  } else {
    startsAt.setUTCHours(hours, mins, 0, 0);
    // No date + time already passed today → push to tomorrow.
    if (dateOffset === null && startsAt.getTime() < nowAnchor.getTime()) {
      startsAt.setUTCDate(startsAt.getUTCDate() + 1);
    }
    endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  }

  // ── Step 5: leftover text is the summary ────────────────────────────────
  // Grammatical filler stranded once the date/time tokens were consumed
  // ("comida al mediodía" leaves "al", "a las 3" leaves "a las"). Only
  // removed when it stands alone between spaces, so a title that is genuinely
  // just "de" survives.
  const FILLER = alt([
    "on|at|the|from|a\\s+las|a\\s+la|al|a|de|del|la|el|los|por|en" +
    "|à|au|aux|le|les|du|des|d'|um|am|im|den|dem|der|dies(?:er|e)?",
  ]);
  // Location comes out of the leftover BEFORE the filler cleanup: the
  // markers （在/で/에서/at…) are exactly the kind of small words step 5
  // would otherwise leave stranded in the summary.
  const extracted = extractLocation(remaining);
  if (extracted) remaining = extracted.rest;

  let summary = remaining.replace(/[，。、；：,;:]+/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = summary.replace(re(`(?:^|\\s)${FILLER}(?=\\s|$)`), " ").replace(/\s+/g, " ").trim();
    if (next === summary) break;
    summary = next;
  }
  const out: ParsedEvent = { summary, startsAt: fmt(startsAt), endsAt: fmt(endsAt) };
  if (extracted) out.location = extracted.location;
  if (rrule !== null) out.rrule = rrule;
  if (allDay) out.allDay = true;
  return out;
}

/**
 * Pull a place out of the leftover text — conservatively. A location is
 * only extracted when an explicit marker names it:
 *
 *   zh  在 + place + a known activity word ("在星巴克开会"), or 在 + place
 *       at the very end after some title text ("开会在会议室"); same for 去.
 *   ja  place + で ("スタバで打ち合わせ"); ko place + 에서.
 *   en  "at"/"in" + a Capitalized name at the end ("meeting at Starbucks").
 *   de  "im"/"in der" + a Capitalized noun at the end; es "en" + Capitalized.
 *
 * Anything else — no marker, a place that runs to the end with nothing
 * before it, a candidate that is itself an activity word — stays in the
 * summary untouched. A missed extraction costs the user one field to fill
 * in; a wrong one mangles their title, so every rule here errs towards
 * leaving the text alone. The live preview shows the split before saving.
 */
function extractLocation(remaining: string): { location: string; rest: string } | null {
  const ACTIVITY =
    "开会|開會|见面|見面|吃饭|吃飯|吃|喝咖啡|喝茶|喝|上课|上課|办公|辦公|加班|集合|碰头|碰頭|" +
    "面试|面試|健身|打球|看电影|看電影|购物|購物|聚会|聚會|团建|團建|培训|培訓|汇报|匯報|" +
    "聊天|等人|接人|出差|谈事|談事|学习|學習";
  const PLACE = "[^\\s，。、；;]{2,15}?";
  const PLACE_TAIL = "[^\\s，。、；;]{2,15}";

  // A place candidate is no good when it IS an activity word, STARTS with
  // one ("在开会之前吃药" — 在开会之前 is "before the meeting", not a place),
  // or is a bare verb phrase ("会议在举行" — 举行 is what happens, not where).
  const startsActivity = new RegExp(`^(?:${ACTIVITY})`, "u");
  const notPlace = /^(?:举行|舉行|召开|召開|进行|進行|开始|開始|结束|結束)$/u;

  // zh: 在/去 + place + activity word.
  for (const marker of ["在", "去"]) {
    const r = new RegExp(`${marker}\\s*(${PLACE})\\s*(${ACTIVITY})`, "u");
    const m = remaining.match(r);
    if (m && !startsActivity.test(m[1]!) && !notPlace.test(m[1]!)) {
      return { location: m[1]!, rest: remaining.replace(r, ` $2 `) };
    }
  }
  // zh: title + 在 + place at the end ("开会在会议室"). The marker must not
  // lead the string — "在星巴克" alone is a title, not a place to extract.
  {
    const r = new RegExp(`在\\s*(${PLACE_TAIL})\\s*$`, "u");
    const m = remaining.match(r);
    const idx = m?.index ?? 0;
    if (
      m && idx > 0 && remaining.slice(0, idx).trim().length > 0 &&
      !startsActivity.test(m[1]!) && !notPlace.test(m[1]!)
    ) {
      return { location: m[1]!, rest: remaining.slice(0, idx) };
    }
  }
  // ja: place + で; ko: place + 에서. The place must not swallow particles,
  // and there must be activity text after the marker. Demonstratives are
  // not places ("これで終わり" is an idiom, not a venue).
  {
    const ja = remaining.match(/([^\s、。はがをにへ]{2,12}?)で/u);
    if (
      ja && !/^(?:これ|それ|あれ|ここ|そこ|どれ)/u.test(ja[1]!) &&
      remaining.slice((ja.index ?? 0) + ja[0].length).trim().length > 0
    ) {
      return { location: ja[1]!, rest: remaining.replace(ja[0], " ") };
    }
    const ko = remaining.match(/([^\s]{2,12}?)에서/u);
    if (ko && remaining.slice((ko.index ?? 0) + ko[0].length).trim().length > 0) {
      return { location: ko[1]!, rest: remaining.replace(ko[0], " ") };
    }
  }
  // en/de/es: marker + Capitalized name(s) at the end, with title text
  // before the marker ("meeting at Starbucks", "Treffen im Büro…").
  const CAPS: Record<string, string> = {
    en: "[A-Z][\\w&'.-]*(?:\\s+(?:[A-Z][\\w&'.-]*|&))*",
    de: "[A-ZÄÖÜ][\\wäöüß-]*(?:\\s+[A-ZÄÖÜ][\\wäöüß-]*)*",
    es: "[A-ZÁÉÍÓÚÑ][\\wáéíóúñ-]*(?:\\s+[A-ZÁÉÍÓÚÑ][\\wáéíóúñ-]*)*",
  };
  for (const [marker, caps] of [
    [`(?:at|in)`, CAPS.en],
    [`(?:im|in\\s+der|in\\s+dem)`, CAPS.de],
    [`en`, CAPS.es],
  ] as const) {
    const r = new RegExp(`\\s${marker}\\s+(${caps})\\s*$`, "u");
    const m = remaining.match(r);
    if (m && remaining.slice(0, m.index).trim().length > 0) {
      return { location: m[1]!, rest: remaining.slice(0, m.index) };
    }
  }
  return null;
}

/** Days from `day` to the next occurrence of month/date (this year or next). */
function offsetForMonthDay(monthIdx: number, date: number, nowAnchor: Date, day: Date): number {
  let tgt = Date.UTC(nowAnchor.getUTCFullYear(), monthIdx, date);
  if (tgt < day.getTime()) tgt = Date.UTC(nowAnchor.getUTCFullYear() + 1, monthIdx, date);
  return Math.round((tgt - day.getTime()) / MS_DAY);
}
