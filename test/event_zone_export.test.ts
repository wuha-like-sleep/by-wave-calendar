import { describe, it, expect } from "vitest";
import { expansionTimeZone, exportTimeZone, rawIcsStartIsUtc, timeZoneToPinOnCopy } from "../src/lib/event_zone.js";
import { parseEvent, serializeEvent, type IcalEvent } from "../src/lib/ical.js";
import { importTimeZone, mergeImportExtra } from "../src/lib/ics_import.js";

// 「按哪个时区展开 / 导出」只有一份口径（event_zone.ts）。展开（服务端）和导出（手机）
// 用的必须是同一个时区，否则两边算出来的日子对不上。

const RAW_UTC = "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260927T233000Z\r\nDTEND:20260928T003000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nEND:VEVENT";
const RAW_TZID = "BEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Australia/Melbourne:20260928T093000\r\nDTEND;TZID=Australia/Melbourne:20260928T103000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nEND:VEVENT";

describe("expansionTimeZone 的顺序", () => {
  it("extra.timezone 优先于日历时区", () => {
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "Asia/Shanghai" }, calendarTimezone: "Australia/Melbourne" }))
      .toBe("Asia/Shanghai");
  });

  it("没有 extra.timezone 用日历时区", () => {
    expect(expansionTimeZone({ allDay: false, extra: { alarms: [] }, calendarTimezone: "Australia/Melbourne" }))
      .toBe("Australia/Melbourne");
    expect(expansionTimeZone({ allDay: false, extra: null, calendarTimezone: "America/New_York" }))
      .toBe("America/New_York");
  });

  it("全天事件永远是 UTC（存的是 UTC 午夜的日期）", () => {
    expect(expansionTimeZone({ allDay: true, extra: { timezone: "Asia/Shanghai" }, calendarTimezone: "Australia/Melbourne" }))
      .toBe("UTC");
  });

  it("非法时区名不算数，一路回落到 UTC", () => {
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "Not/AZone" }, calendarTimezone: "Australia/Melbourne" }))
      .toBe("Australia/Melbourne");
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "Not/AZone" }, calendarTimezone: "Also/Bad" }))
      .toBe("UTC");
    expect(expansionTimeZone({ allDay: false, extra: { timezone: 42 }, calendarTimezone: null })).toBe("UTC");
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "" }, calendarTimezone: "" })).toBe("UTC");
  });

  it("手机写上来的原文 DTSTART 是 UTC 写法：按 UTC（手机就是这么展开的），连 extra.timezone 也压过", () => {
    expect(rawIcsStartIsUtc(RAW_UTC)).toBe(true);
    expect(rawIcsStartIsUtc(RAW_TZID)).toBe(false);
    expect(rawIcsStartIsUtc("DTSTART:20260927T233000Z")).toBe(false);   // 不是 VEVENT 原文
    expect(rawIcsStartIsUtc(null)).toBe(false);
    // DESCRIPTION 里写着 DTSTART:…Z 骗不到它（只认行首）
    expect(rawIcsStartIsUtc("BEGIN:VEVENT\r\nDESCRIPTION:see DTSTART:20260927T233000Z\r\nDTSTART;TZID=Asia/Shanghai:20260928T073000\r\nEND:VEVENT")).toBe(false);
    expect(expansionTimeZone({ allDay: false, extra: null, calendarTimezone: "Australia/Melbourne", rawStartIsUtc: true }))
      .toBe("UTC");
    // 网页建的事件（有 extra.timezone）被手机用 UTC 写法 PUT 回来：CalDAV PUT 只在带 TZID 时才
    // 覆盖 extra.timezone，原文才是手机手上那一份，两边必须按同一个时区排。
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "Asia/Tokyo" }, calendarTimezone: "Australia/Melbourne", rawStartIsUtc: true }))
      .toBe("UTC");
    expect(exportTimeZone({ allDay: false, extra: { timezone: "Asia/Tokyo" }, calendarTimezone: null, rrule: "FREQ=WEEKLY", rawStartIsUtc: true }))
      .toBeNull();
    expect(timeZoneToPinOnCopy({
      allDay: false, extra: { timezone: "Asia/Tokyo" }, calendarTimezone: null, rrule: "FREQ=WEEKLY", rawStartIsUtc: true,
    })).toBe("UTC");
  });

  it("偏移写法不算时区名（+08:00、GMT+8 一律回落）；别名规范成 IANA 名（PRC、US/Eastern、GMT）", () => {
    for (const tz of ["+08:00", "-05:00", "GMT+8"]) {
      expect(expansionTimeZone({ allDay: false, extra: { timezone: tz }, calendarTimezone: tz }), tz).toBe("UTC");
    }
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "PRC" }, calendarTimezone: null })).toBe("Asia/Shanghai");
    expect(expansionTimeZone({ allDay: false, extra: null, calendarTimezone: "US/Eastern" })).toBe("America/New_York");
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "GMT" }, calendarTimezone: "Asia/Shanghai" })).toBe("UTC");
    expect(exportTimeZone({ allDay: false, extra: { timezone: "PRC" }, calendarTimezone: null, rrule: "FREQ=WEEKLY" })).toBe("Asia/Shanghai");
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "Etc/GMT-8" }, calendarTimezone: null })).toBe("Etc/GMT-8");
    expect(expansionTimeZone({ allDay: false, extra: { timezone: "America/Argentina/Buenos_Aires" }, calendarTimezone: null }))
      .toMatch(/Buenos_Aires$/);   // 三段式的名字照样认（ICU 会规范成 America/Buenos_Aires）
  });

  it("extra.timezone 是 UTC 的导出写成 …Z，不写 TZID=UTC", () => {
    expect(exportTimeZone({ allDay: false, extra: { timezone: "UTC" }, calendarTimezone: "Asia/Shanghai", rrule: "FREQ=WEEKLY" })).toBeNull();
  });
});

describe("importTimeZone：导入 / 订阅进来的重复事件记下按哪个时区排", () => {
  it("源文件 DTSTART 带 TZID：用它；UTC 写法、浮动时间、认不出的 TZID：UTC（和读进来的时刻同一个口径）", () => {
    expect(importTimeZone({ allDay: false, rrule: "FREQ=WEEKLY;BYDAY=MO", timezone: "America/New_York" })).toBe("America/New_York");
    expect(importTimeZone({ allDay: false, rrule: "FREQ=WEEKLY;BYDAY=MO", timezone: null })).toBe("UTC");
    expect(importTimeZone({ allDay: false, rrule: "FREQ=WEEKLY;BYDAY=MO", timezone: "China Standard Time" })).toBe("UTC");
    expect(importTimeZone({ allDay: false, rrule: "FREQ=WEEKLY;BYDAY=MO", timezone: "US/Eastern" })).toBe("America/New_York");
  });
  it("不重复、全天：不记", () => {
    expect(importTimeZone({ allDay: false, rrule: null, timezone: "America/New_York" })).toBeNull();
    expect(importTimeZone({ allDay: true, rrule: "FREQ=YEARLY", timezone: null })).toBeNull();
  });
  it("写进 extra 时不抹掉用户自己加的提醒和别的字段", () => {
    expect(mergeImportExtra({ alarms: [{ trigger: "-PT30M" }], categories: ["x"] }, "sub:s1", null, "America/New_York"))
      .toEqual({ alarms: [{ trigger: "-PT30M" }], categories: ["x"], source: "sub:s1", timezone: "America/New_York" });
  });
});

describe("timeZoneToPinOnCopy：收到邀请后抄进自己日历的副本钉哪个时区", () => {
  it("没有自己时区的重复事件：钉上原日历的时区（换到收件人的日历后照样按它展开）", () => {
    expect(timeZoneToPinOnCopy({ allDay: false, extra: null, calendarTimezone: "Australia/Melbourne", rrule: "FREQ=WEEKLY;BYDAY=MO" }))
      .toBe("Australia/Melbourne");
    expect(timeZoneToPinOnCopy({
      allDay: false, extra: null, calendarTimezone: "Australia/Melbourne", rrule: "FREQ=WEEKLY", rawStartIsUtc: true,
    })).toBe("UTC");
  });
  it("不重复、全天、本来就有时区的：不钉", () => {
    expect(timeZoneToPinOnCopy({ allDay: false, extra: null, calendarTimezone: "Australia/Melbourne", rrule: null })).toBeNull();
    expect(timeZoneToPinOnCopy({ allDay: true, extra: null, calendarTimezone: "Australia/Melbourne", rrule: "FREQ=WEEKLY" })).toBeNull();
    expect(timeZoneToPinOnCopy({ allDay: false, extra: { timezone: "Asia/Tokyo" }, calendarTimezone: "Australia/Melbourne", rrule: "FREQ=WEEKLY" }))
      .toBeNull();
  });
});

describe("exportTimeZone：合成的 VEVENT 带不带 TZID", () => {
  it("没有自己时区的**重复**事件带日历时区", () => {
    expect(exportTimeZone({ allDay: false, extra: null, calendarTimezone: "Australia/Melbourne", rrule: "FREQ=WEEKLY" }))
      .toBe("Australia/Melbourne");
  });
  it("不重复、也没有自己时区的：写 UTC（null）", () => {
    expect(exportTimeZone({ allDay: false, extra: null, calendarTimezone: "Australia/Melbourne", rrule: null })).toBeNull();
    expect(exportTimeZone({ allDay: false, extra: null, calendarTimezone: "Australia/Melbourne", rrule: "" })).toBeNull();
  });
  it("有自己的时区照旧带上；全天不带；日历时区就是 UTC 时写成 …Z", () => {
    expect(exportTimeZone({ allDay: false, extra: { timezone: "Asia/Shanghai" }, calendarTimezone: "UTC", rrule: null }))
      .toBe("Asia/Shanghai");
    expect(exportTimeZone({ allDay: true, extra: { timezone: "Asia/Shanghai" }, calendarTimezone: "UTC", rrule: "FREQ=WEEKLY" }))
      .toBeNull();
    expect(exportTimeZone({ allDay: false, extra: null, calendarTimezone: "UTC", rrule: "FREQ=WEEKLY" })).toBeNull();
  });
});

describe("serializeEvent：重复事件的 DTSTART / EXDATE 写成同一时区的墙上时间", () => {
  // 墨尔本周一 9:30「每周一」，删掉了 10-12 那一次（服务端记的是真实时刻 2026-10-11T22:30Z）。
  const base: IcalEvent = {
    uid: "u1", summary: "周会",
    startsAt: new Date("2026-09-27T23:30:00Z"), endsAt: new Date("2026-09-28T00:30:00Z"),
    allDay: false, rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=12",
    exdates: ["2026-10-11T22:30:00.000Z"],
    timezone: exportTimeZone({ allDay: false, extra: null, calendarTimezone: "Australia/Melbourne", rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=12" }),
  };

  it("DTSTART / DTEND 带 TZID、写墙上时间；EXDATE 也是同一时区的墙上时间（夏令时后的 09:30，不是 UTC）", () => {
    const ics = serializeEvent(base);
    expect(ics).toContain("DTSTART;TZID=Australia/Melbourne:20260928T093000");
    expect(ics).toContain("DTEND;TZID=Australia/Melbourne:20260928T103000");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12");
    expect(ics).toContain("EXDATE;TZID=Australia/Melbourne:20261012T093000");
    expect(ics, "还有一行 UTC 写法的 EXDATE").not.toMatch(/EXDATE:\d{8}T\d{6}Z/);
    expect(ics, "DTSTART 还是 UTC 写法").not.toMatch(/DTSTART:\d{8}T\d{6}Z/);
  });

  it("认不出的时区名不带着 TZID 写出去（以前会写成 TZID=乱码 + 按 UTC 读出的墙上时间）", () => {
    const ics = serializeEvent({ ...base, timezone: "Not/AZone" });
    expect(ics).not.toContain("TZID=");
    expect(ics).toContain("DTSTART:20260927T233000Z");
    expect(ics).toContain("EXDATE:20261011T223000Z");
  });

  it("全天重复事件的 EXDATE 照旧是 VALUE=DATE", () => {
    const ics = serializeEvent({
      ...base, allDay: true, timezone: "Australia/Melbourne",
      startsAt: new Date("2026-10-05T00:00:00Z"), endsAt: new Date("2026-10-05T23:59:59.999Z"),
      exdates: ["2026-10-12T00:00:00.000Z"],
    });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261005");
    expect(ics).toContain("EXDATE;VALUE=DATE:20261012");
    expect(ics).not.toContain("TZID=");
  });
});

describe("读 TZID 时刻：夏令时切换前十来个小时也不差一小时", () => {
  it("墨尔本 10-03 18:00（还是 AEST +10，第二天凌晨才进夏令时）= 08:00Z", () => {
    const ev = parseEvent([
      "BEGIN:VEVENT", "UID:dst-edge", "SUMMARY:x",
      "DTSTART;TZID=Australia/Melbourne:20260926T180000", "DTEND;TZID=Australia/Melbourne:20260926T190000",
      "RRULE:FREQ=WEEKLY", "EXDATE;TZID=Australia/Melbourne:20261003T180000", "END:VEVENT",
    ].join("\r\n"))!;
    expect(ev.exdates).toEqual(["2026-10-03T08:00:00.000Z"]);
    // 夏令时之后的那一周：+11
    const after = parseEvent([
      "BEGIN:VEVENT", "UID:dst-edge2", "SUMMARY:x",
      "DTSTART;TZID=Australia/Melbourne:20261010T180000", "DTEND;TZID=Australia/Melbourne:20261010T190000", "END:VEVENT",
    ].join("\r\n"))!;
    expect(after.startsAt.toISOString()).toBe("2026-10-10T07:00:00.000Z");
  });
});
