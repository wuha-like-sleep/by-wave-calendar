// Vocabulary tables for the natural-language event parser (lib/nl_parse.ts).
//
// One table per concept, every supported language in the same table, so the
// parser stays a single pipeline instead of eight. Input is NOT tagged with a
// locale on purpose: people mix languages ("明天 3pm 开会", "Meeting morgen
// 15 Uhr"), and a wrong locale guess would parse worse than no guess at all.
//
// Two rules keep the cross-language matching honest:
//
//   1. Latin-script patterns are wrapped in word boundaries by tok(), so
//      German "morgen" (tomorrow) cannot fire inside English "morgenstern"
//      and French "mai" cannot fire inside "email". CJK patterns must NOT get
//      boundaries — \b is meaningless between ideographs.
//   2. Where one word means two things in the same language, the narrower
//      reading carries a negative lookbehind. Spanish "mañana" is both
//      "tomorrow" and "morning"; "esta mañana" / "por la mañana" must not be
//      read as tomorrow, so the relative-day entry excludes those prefixes and
//      the leftover still matches the period table. Same for German "morgen"
//      vs "heute Morgen".
//
// Within each table, LONGER patterns must come first: "day after tomorrow"
// has to win over "tomorrow", "大后天" over "后天", "après-demain" over
// "demain".

/**
 * Wrap an alphabetic pattern in word boundaries; leave CJK/Hangul alone.
 *
 * The test is "does this pattern contain CJK or Hangul", NOT "is it ASCII" —
 * accented Latin (mediodía, früh, après-midi) is still Latin and still needs
 * boundaries. Getting that backwards let "Mittag" match inside "Mittagessen",
 * eating half the summary.
 *
 * \b is useless here because it is ASCII-only: it would fire between "é" and
 * "e". Hence the explicit \p{L} lookarounds (all regexes are built with the
 * u flag).
 */
const HAS_CJK = /[　-ヿ㐀-䶿一-鿿가-힯＀-￯]/;
export function tok(p: string): string {
  return HAS_CJK.test(p) ? `(?:${p})` : `(?<!\\p{L})(?:${p})(?!\\p{L})`;
}

/** Join alternatives into one non-capturing group, each boundary-wrapped. */
export function alt(patterns: readonly string[]): string {
  return `(?:${patterns.map(tok).join("|")})`;
}

// ─────────────────────────────────────────────────────────────────────────
// Relative days
// ─────────────────────────────────────────────────────────────────────────
// Ordered longest-phrase-first. The offset is in days from "today".
export const REL_DAYS: ReadonlyArray<readonly [string, number]> = [
  // +3
  ["大后天|大後天", 3],
  ["しあさって|明々後日", 3],
  // +2
  ["后天|後天", 2],
  ["あさって|明後日", 2],
  ["모레", 2],
  ["day after tomorrow", 2],
  ["pasado ma[ñn]ana", 2],
  ["apr[eè]s[- ]demain", 2],
  ["[üu]bermorgen", 2],
  // +1
  ["明天|明日", 1],
  ["あした|あす", 1],
  ["내일", 1],
  ["tomorrow|tmrw|tmr", 1],
  // "mañana" is also "morning" — not after esta/por la/de la/la.
  ["(?<!esta |por la |de la |la )ma[ñn]ana", 1],
  ["demain", 1],
  // "morgen" is also "morning" — not after heute/am/guten, and not "morgens".
  ["(?<!heute |am |guten )morgen(?!s)", 1],
  // 0
  ["今天|今日", 0],
  ["きょう", 0],
  ["오늘", 0],
  ["today", 0],
  ["hoy", 0],
  ["aujourd'?hui", 0],
  ["heute", 0],
  // −1
  ["昨天|昨日", -1],
  ["きのう", -1],
  ["어제", -1],
  ["yesterday", -1],
  ["ayer", -1],
  ["hier", -1],
  ["gestern", -1],
  // −2
  ["前天|前日", -2],
  ["おととい|一昨日", -2],
  ["그제|그저께", -2],
  ["day before yesterday", -2],
  ["anteayer|antier", -2],
  ["avant[- ]hier", -2],
  ["vorgestern", -2],
];

// ─────────────────────────────────────────────────────────────────────────
// Weekdays  (0 = Sunday, matching Date#getUTCDay)
// ─────────────────────────────────────────────────────────────────────────
// Chinese 周X / 星期X / 礼拜X is normalized to 周X before this table is used,
// so only the bare character appears here.
export const WEEKDAYS: ReadonlyArray<readonly [string, number]> = [
  ["周一|週一|月曜日|月曜|월요일", 1],
  ["周二|週二|火曜日|火曜|화요일", 2],
  ["周三|週三|水曜日|水曜|수요일", 3],
  ["周四|週四|木曜日|木曜|목요일", 4],
  ["周五|週五|金曜日|金曜|금요일", 5],
  ["周六|週六|土曜日|土曜|토요일", 6],
  ["周日|周天|週日|週天|日曜日|日曜|일요일", 0],
  ["monday|mon", 1],
  ["tuesday|tues|tue", 2],
  ["wednesday|weds|wed", 3],
  ["thursday|thurs|thur|thu", 4],
  ["friday|fri", 5],
  ["saturday|sat", 6],
  ["sunday|sun", 0],
  ["lunes", 1], ["martes", 2], ["mi[ée]rcoles", 3], ["jueves", 4],
  ["viernes", 5], ["s[áa]bado", 6], ["domingo", 0],
  ["lundi", 1], ["mardi", 2], ["mercredi", 3], ["jeudi", 4],
  ["vendredi", 5], ["samedi", 6], ["dimanche", 0],
  ["montag", 1], ["dienstag", 2], ["mittwoch", 3], ["donnerstag", 4],
  ["freitag", 5], ["samstag|sonnabend", 6], ["sonntag", 0],
];

/** Prefixes that shift a matched weekday by whole weeks. */
export const WEEK_SHIFT: ReadonlyArray<readonly [string, number]> = [
  ["下下周|下下週|再来週|다다음\\s*주", 14],
  ["下周|下週|来週|らいしゅう|다음\\s*주", 7],
  ["next week|la semana que viene|la pr[óo]xima semana|semaine prochaine|la semaine prochaine|n[äa]chste woche", 7],
  ["本周|本週|这周|這週|今週|이번\\s*주", 0],
  ["this week|esta semana|cette semaine|diese woche", 0],
];

/**
 * Bare "next" modifiers, only consulted when a weekday was actually matched.
 * Kept out of WEEK_SHIFT because "next" on its own is far too common in event
 * titles ("next sprint review") to be allowed to set a date by itself.
 */
export const NEXT_BEFORE_WEEKDAY: readonly string[] = [
  "next", "pr[óo]xim[oa]", "prochaine?", "n[äa]chste[rns]?", "que viene",
];

// ─────────────────────────────────────────────────────────────────────────
// Periods of day
// ─────────────────────────────────────────────────────────────────────────
export type Period =
  | "dawn" | "morning" | "forenoon" | "noon"
  | "afternoon" | "dusk" | "night" | "midnight";

// Longest first; "après-midi" must beat "midi", "vormittag" must beat "mittag".
export const PERIODS: ReadonlyArray<readonly [string, Period]> = [
  ["半夜|午夜|真夜中|자정", "midnight"],
  ["midnight|medianoche|minuit|mitternacht", "midnight"],
  ["凌晨|深夜|새벽", "dawn"],
  ["dawn|early hours|de madrugada|madrugada|petit matin|nachts", "dawn"],
  ["下午|午後|오후", "afternoon"],
  ["afternoon|apr[eè]s[- ]midi|por la tarde|de la tarde|nachmittags?|nachmittag", "afternoon"],
  ["上午|午前|오전", "forenoon"],
  ["late morning|vormittags?|vormittag", "forenoon"],
  ["傍晚|夕方|저녁", "dusk"],
  ["early evening|al atardecer|atardecer|en fin d'apr[eè]s[- ]midi", "dusk"],
  ["晚上|夜里|夜裡|夜間|밤", "night"],
  ["evening|tonight|at night|night|por la noche|de la noche|noche|le soir|au soir|soir[ée]e|soir|abends?|abend|nacht", "night"],
  ["中午|正午|お昼|점심", "noon"],
  ["noon|midday|mediod[íi]a|midi|mittags?|mittag", "noon"],
  ["早上|清晨|一早|朝|아침", "morning"],
  // Spanish/German morning words collide with "tomorrow" — see REL_DAYS.
  ["morning|por la ma[ñn]ana|de la ma[ñn]ana|esta ma[ñn]ana|ma[ñn]ana|le matin|au matin|matin[ée]e|matin|morgens|fr[üu]h", "morning"],
];

/** Fallback hour when a period word appears with no explicit clock time. */
export const PERIOD_DEFAULT_HOUR: Record<Period, number> = {
  dawn: 6, morning: 9, forenoon: 10, noon: 12,
  afternoon: 15, dusk: 18, night: 20, midnight: 0,
};

/** Resolve a 1..12-style hour under a period word into 0..23. */
export function applyPeriod(period: Period | null, h: number): number {
  switch (period) {
    case "afternoon": case "dusk": case "night":
      return h < 12 ? h + 12 : h;
    case "dawn": case "midnight":
      return h === 12 ? 0 : h;
    case "noon":
      // 中午12点 = 12, 中午一点 = 13, 中午11点 = 11
      return h <= 3 ? h + 12 : h;
    default:
      return h;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Clock-time markers
// ─────────────────────────────────────────────────────────────────────────
/** Words that may precede a bare hour: "at 3", "à 15h", "um 15 Uhr". */
export const AT_PREFIX =
  "(?:(?<!\\p{L})(?:at|a\\s+las|a\\s+la|à|a|um|gegen|vers|hacia|ab)(?!\\p{L})\\s*)?";

/**
 * Suffixes that mark the preceding number as an hour.
 *
 * The Latin ones carry their own right-hand boundary: without it the bare "h"
 * matches the h of "halbe", so "eine halbe Stunde" parses as 01:00 and leaves
 * "albe Stunde" in the summary. CJK suffixes must not have one.
 */
export const HOUR_SUFFIX =
  "(?:点|點|时|時|시|(?:uhr|heures?|horas?|hrs?|h|o'?clock)(?!\\p{L}))";

/**
 * Suffixes marking the preceding number as minutes ON A CLOCK.
 *
 * 分 must NOT match the 分 inside 分钟/分鐘/分間 — that is a DURATION unit, and
 * letting the clock eat it turns "9点 30分钟 站会" into 09:30 with the summary
 * "钟 站会" instead of 09:00 for 30 minutes. Hence the lookahead. Bare "m" is
 * excluded for the same class of reason ("10 meeting" is not 10:00 + "eeting").
 */
export const MIN_SUFFIX = "(?:分(?![钟鐘間])|분|min(?:ute[sn]?)?)";

/** am / pm, all spellings we accept. */
export const AM = "(?:am|a\\.m\\.)";
export const PM = "(?:pm|p\\.m\\.)";

// ─────────────────────────────────────────────────────────────────────────
// Ranges
// ─────────────────────────────────────────────────────────────────────────
/** Connector between a start and end time: "3 to 5", "15h à 17h", "3~5". */
export const RANGE_SEP =
  "\\s*(?:到|至|~|～|—|–|-|until|till|to|through|hasta|jusqu'?[àa]|[àa]|bis|para)\\s*";

/** Optional opener before a range: "from 3 to 5", "von 15 bis 17". */
export const RANGE_OPEN = "(?:from|desde|de|depuis|von|ab)?\\s*";

// ─────────────────────────────────────────────────────────────────────────
// Durations
// ─────────────────────────────────────────────────────────────────────────
// Longest alternative FIRST in each group — regex alternation is leftmost-wins,
// so "minutes?" ahead of "minuten" leaves a stray "n" after German "Minuten",
// and that "n" ends up in the event summary.
export const HOUR_UNIT =
  "(?:小时|小時|時間|시간|(?:stunden|stunde|heures|heure|hours|hour|horas|hora|std|hrs|hr|h)(?!\\p{L}))";
export const MINUTE_UNIT =
  "(?:分钟|分鐘|分間|分|분|(?:minuten|minutos|minutes|minute|minuto|mins|min)(?!\\p{L}))";

/** "an hour" / "une heure" / "eine Stunde" / "una hora" — count-less singular. */
export const ONE_UNIT_WORDS = "(?:an|a|une|un|eine|ein|una|uno)";

/** Half-hour phrases that carry no separate numeral. */
export const HALF_HOUR: readonly string[] = [
  "半个?小时", "半個?小時", "半時間", "반\\s*시간",
  "half an hour", "half hour", "media hora",
  "une demi[- ]heure", "demi[- ]heure",
  "eine halbe stunde", "halbe stunde",
];

/** "X and a half hours" — the numeral is captured separately by the parser. */
export const AND_A_HALF: readonly string[] = [
  "个?半个?小时", "個?半個?小時", "時間半", "시간\\s*반",
  "and a half hours?", "\\.5 hours?", "heures? et demie", "et demie",
  "y media horas?", "y media", "einhalb stunden?", "und eine halbe stunde",
];

// ─────────────────────────────────────────────────────────────────────────
// Month names (for "March 5", "5 de marzo", "5. März", "5 mars")
// ─────────────────────────────────────────────────────────────────────────
export const MONTHS: ReadonlyArray<readonly [string, number]> = [
  ["january|jan|enero|ene|janvier|janv|januar|jän", 1],
  ["february|feb|febrero|f[ée]vrier|f[ée]vr|februar", 2],
  ["march|mar|marzo|mars|m[äa]rz|mrz", 3],
  ["april|apr|abril|avril|avr", 4],
  ["may|mayo|mai", 5],
  ["june|jun|junio|juin|juni", 6],
  ["july|jul|julio|juillet|juil|juli", 7],
  ["august|aug|agosto|ago|ao[ûu]t", 8],
  ["september|sept|sep|septiembre|septembre|september", 9],
  ["october|oct|octubre|octobre|oktober|okt", 10],
  ["november|nov|noviembre|novembre", 11],
  ["december|dec|diciembre|dic|d[ée]cembre|d[ée]c|dezember|dez", 12],
];

// ─────────────────────────────────────────────────────────────────────────
// Numerals
// ─────────────────────────────────────────────────────────────────────────
/** Chinese/Japanese numeral characters usable in an hour or minute run. */
export const CJK_DIGITS: Record<string, number> = {
  "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "兩": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};

/** Small cardinals spelled out, for "two hours" / "deux heures". */
export const SPELLED_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5,
  sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12,
  eins: 1, ein: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fünf: 5,
  sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12,
};

/** Character class matching one ASCII-or-CJK numeral character. */
export const NUM_CHAR = "[0-9零〇一二两兩三四五六七八九十]";
