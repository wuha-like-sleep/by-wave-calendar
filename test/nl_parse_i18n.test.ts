// Multi-language coverage for the natural-language event parser.
// test/nl_parse.test.ts already pins the Chinese behaviour; this file covers
// the other seven locales the product ships, plus the cross-language traps
// that make a single shared parser risky:
//
//   - Spanish "mañana" and German "morgen" mean BOTH "tomorrow" and "morning".
//   - "Mittag" (noon) is a substring of "Mittagessen" (lunch).
//   - "h" is an hour marker in French AND the first letter of "halbe".
//   - "a" is a Spanish preposition AND the last letter of "Ana".
//
// Each of those cost a real bug during development, so each has a test.

import { describe, it, expect } from "vitest";
import { parseNaturalLanguageEvent as parse } from "../src/lib/nl_parse.js";

// Fixed reference: 2026-07-03 is a FRIDAY, 10:00 local.
const NOW = "2026-07-03T10:00:00";

/** Compact assertion: start, end and summary in one go. */
function expectParse(input: string, start: string, end: string, summary: string) {
  expect(parse(input, NOW), input).toEqual({ summary, startsAt: start, endsAt: end });
}

describe("English", () => {
  it("tomorrow + 12-hour clock", () => {
    expectParse("dentist tomorrow at 3pm", "2026-07-04T15:00:00", "2026-07-04T16:00:00", "dentist");
  });
  it("12am is midnight, 12pm is noon", () => {
    // An explicit date wins over the "that hour already passed → tomorrow"
    // heuristic: "today 12am" means today's midnight even though it is behind us.
    expect(parse("shift today 12am", NOW)?.startsAt).toBe("2026-07-03T00:00:00");
    expect(parse("lunch today 12pm", NOW)?.startsAt).toBe("2026-07-03T12:00:00");
  });
  it("weekday + 24-hour clock + explicit minutes duration", () => {
    expectParse("standup monday 9:30 30 minutes", "2026-07-06T09:30:00", "2026-07-06T10:00:00", "standup");
  });
  it("'next <weekday>' adds a week on top of the upcoming one", () => {
    // Friday → upcoming Friday is the 10th; "next friday" is the 17th.
    expect(parse("retro friday", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parse("retro next friday", NOW)?.startsAt).toBe("2026-07-17T09:00:00");
  });
  it("a range where only the END carries am/pm — the start inherits it", () => {
    expectParse("workshop tomorrow 2-4pm", "2026-07-04T14:00:00", "2026-07-04T16:00:00", "workshop");
  });
  it("'in N days'", () => {
    expectParse("call in 3 days at 10am", "2026-07-06T10:00:00", "2026-07-06T11:00:00", "call");
  });
  it("named month + day, rolling into next year when already past", () => {
    expect(parse("review March 5 at 14:00", NOW)?.startsAt).toBe("2027-03-05T14:00:00");
    expect(parse("review December 5 at 14:00", NOW)?.startsAt).toBe("2026-12-05T14:00:00");
  });
  it("period word with no clock time uses a colloquial default", () => {
    expectParse("gym tomorrow evening", "2026-07-04T20:00:00", "2026-07-04T21:00:00", "gym");
  });
  it("'half an hour' / 'an hour'", () => {
    expect(parse("coffee tomorrow 9am half an hour", NOW)?.endsAt).toBe("2026-07-04T09:30:00");
    expect(parse("sync tomorrow 9am an hour", NOW)?.endsAt).toBe("2026-07-04T10:00:00");
  });
  it("does NOT invent a time from an unrelated number", () => {
    expect(parse("buy 5 apples", NOW)).toBeNull();
    expect(parse("Ana and Bob sync", NOW)).toBeNull();
  });
  it("'next' alone never sets a date — too common in titles", () => {
    expect(parse("sprint review next quarter", NOW)).toBeNull();
  });
});

describe("Japanese", () => {
  it("明日 + 午後 + 時", () => {
    expectParse("明日 午後3時 歯医者", "2026-07-04T15:00:00", "2026-07-04T16:00:00", "歯医者");
  });
  it("あさって + 24h + 2時間", () => {
    expectParse("あさって 19時 2時間 飲み会", "2026-07-05T19:00:00", "2026-07-05T21:00:00", "飲み会");
  });
  it("来週金曜日 + 時分", () => {
    expectParse("会議 来週金曜日 10時30分", "2026-07-17T10:30:00", "2026-07-17T11:30:00", "会議");
  });
  it("時間半 → 90 minutes", () => {
    expect(parse("明日 10時 1時間半 研修", NOW)?.endsAt).toBe("2026-07-04T11:30:00");
  });
});

describe("Korean", () => {
  it("내일 + 오후 + 시", () => {
    expectParse("내일 오후 3시 치과", "2026-07-04T15:00:00", "2026-07-04T16:00:00", "치과");
  });
  it("모레 + 저녁 + 시간 duration", () => {
    expectParse("모레 저녁 7시 2시간 회식", "2026-07-05T19:00:00", "2026-07-05T21:00:00", "회식");
  });
  it("spaced minutes '10시 30분' are clock minutes, not a duration", () => {
    expectParse("회의 다음 주 금요일 10시 30분", "2026-07-17T10:30:00", "2026-07-17T11:30:00", "회의");
  });
});

describe("Spanish", () => {
  it("mañana = tomorrow, and 'de la tarde' shifts the hour to PM", () => {
    expectParse("dentista mañana a las 3 de la tarde", "2026-07-04T15:00:00", "2026-07-04T16:00:00", "dentista");
  });
  it("'mañana por la mañana' = tomorrow MORNING, not tomorrow twice", () => {
    expectParse("gimnasio mañana por la mañana media hora", "2026-07-04T09:00:00", "2026-07-04T09:30:00", "gimnasio");
  });
  it("'esta mañana' is this MORNING, never tomorrow", () => {
    // 09:00 today has passed at 10:00, so it lands tomorrow — but on the
    // morning hour, which proves it was read as a period and not as a date.
    expect(parse("café esta mañana", NOW)?.startsAt).toBe("2026-07-04T09:00:00");
  });
  it("pasado mañana + mediodía", () => {
    expectParse("comida pasado mañana al mediodía", "2026-07-05T12:00:00", "2026-07-05T13:00:00", "comida");
  });
  it("weekday + 'de la noche'", () => {
    expectParse("cena el sábado a las 8 de la noche", "2026-07-04T20:00:00", "2026-07-04T21:00:00", "cena");
  });
  it("'minutos' is consumed whole — no stray letters in the summary", () => {
    expectParse("reunión el lunes a las 9:30 30 minutos", "2026-07-06T09:30:00", "2026-07-06T10:00:00", "reunión");
  });
  it("the preposition 'a' must not eat the last letter of a name", () => {
    expect(parse("comida con Ana el lunes a las 13:00", NOW)?.summary).toBe("comida con Ana");
  });
});

describe("French", () => {
  it("demain + 15h", () => {
    expectParse("dentiste demain à 15h", "2026-07-04T15:00:00", "2026-07-04T16:00:00", "dentiste");
  });
  it("9h30 is a clock time, '30 minutes' after it is a duration", () => {
    expectParse("réunion lundi 9h30 30 minutes", "2026-07-06T09:30:00", "2026-07-06T10:00:00", "réunion");
  });
  it("'de 14h à 16h' range + weekday", () => {
    expectParse("réunion de 14h à 16h jeudi", "2026-07-09T14:00:00", "2026-07-09T16:00:00", "réunion");
  });
  it("après-demain + midi (midi must not be eaten by après-midi)", () => {
    expectParse("déjeuner après-demain à midi", "2026-07-05T12:00:00", "2026-07-05T13:00:00", "déjeuner");
  });
  it("'une demi-heure' → 30 minutes", () => {
    expectParse("sport demain matin une demi-heure", "2026-07-04T09:00:00", "2026-07-04T09:30:00", "sport");
  });
});

describe("German", () => {
  it("morgen = tomorrow, 'um 15 Uhr' = 15:00", () => {
    expectParse("Zahnarzt morgen um 15 Uhr", "2026-07-04T15:00:00", "2026-07-04T16:00:00", "Zahnarzt");
  });
  it("'morgen früh' = tomorrow morning", () => {
    expect(parse("Sport morgen früh", NOW)?.startsAt).toBe("2026-07-04T09:00:00");
  });
  it("'heute Morgen' is this morning, not tomorrow", () => {
    // "heute" pins the date, so this stays on the 3rd — if "Morgen" had been
    // read as "tomorrow" instead of "morning" it would land on the 4th.
    expect(parse("Kaffee heute Morgen", NOW)?.startsAt).toBe("2026-07-03T09:00:00");
  });
  it("'Minuten' is consumed whole — no stray 'n' in the summary", () => {
    expectParse("Besprechung Montag 9:30 30 Minuten", "2026-07-06T09:30:00", "2026-07-06T10:00:00", "Besprechung");
  });
  it("'Mittag' must not be eaten out of 'Mittagessen'", () => {
    expectParse("Mittagessen übermorgen mittags", "2026-07-05T12:00:00", "2026-07-05T13:00:00", "Mittagessen");
  });
  it("'eine halbe Stunde' — the 'h' of halbe is not an hour marker", () => {
    expectParse("Sport morgen früh eine halbe Stunde", "2026-07-04T09:00:00", "2026-07-04T09:30:00", "Sport");
  });
  it("'von 14 bis 16 Uhr' range + weekday", () => {
    expectParse("Meeting von 14 bis 16 Uhr am Donnerstag", "2026-07-09T14:00:00", "2026-07-09T16:00:00", "Meeting");
  });
});

describe("Traditional Chinese", () => {
  it("後天 + 下午 + 點", () => {
    expectParse("後天 下午三點 牙醫", "2026-07-05T15:00:00", "2026-07-05T16:00:00", "牙醫");
  });
  it("週五 + 小時", () => {
    expectParse("週五 10點 2小時 團建", "2026-07-10T10:00:00", "2026-07-10T12:00:00", "團建");
  });
});

describe("mixed input", () => {
  it("Chinese date with an English time", () => {
    expectParse("明天 3pm meeting", "2026-07-04T15:00:00", "2026-07-04T16:00:00", "meeting");
  });
  it("English date with a Chinese time", () => {
    expectParse("tomorrow 下午3点 review", "2026-07-04T15:00:00", "2026-07-04T16:00:00", "review");
  });
});
