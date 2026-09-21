import { vi, describe, it, expect } from "vitest";

// caldav.ts 只是为了拿 applyAlarmsFromPut 这一个纯函数才 import 的，
// 但它顺带会 import db/client.js，那里会真的建一个 postgres 客户端。
// 这个 suite 是纯逻辑的（vitest.config.ts 里写明不连 DB），所以把它挡掉。
vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));

import { parseEvent, serializeEvent, type IcalEvent } from "../src/lib/ical.js";
import { parseTrigger, MAX_ALARMS_PER_EVENT } from "../src/lib/reminder_triggers.js";
import { applyAlarmsFromPut } from "../src/web/caldav.js";
import { mergeImportExtra } from "../src/lib/ics_import.js";

const CRLF = "\r\n";

/** 一份最小可解析的 VEVENT，valarms 原样嵌进去。 */
function vevent(valarms: string[] = [], opts: { allDay?: boolean } = {}): string {
  const dt = opts.allDay
    ? ["DTSTART;VALUE=DATE:20260610", "DTEND;VALUE=DATE:20260611"]
    : ["DTSTART:20260610T090000Z", "DTEND:20260610T110000Z"];
  return [
    "BEGIN:VEVENT",
    "UID:evt-1@example.com",
    "SUMMARY:季度复盘",
    ...dt,
    ...valarms,
    "END:VEVENT",
  ].join(CRLF);
}

function alarmBlock(trigger: string): string {
  return ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:提醒", trigger, "END:VALARM"].join(CRLF);
}

describe("parseEvent: VALARM 的 TRIGGER 参数", () => {
  it("保留 RELATED=END —— 「结束前 15 分钟」不能被当成「开始前 15 分钟」", () => {
    const ev = parseEvent(vevent([alarmBlock("TRIGGER;RELATED=END:-PT15M")]));
    const trigger = ev?.alarms?.[0]?.trigger ?? "";
    expect(trigger).toMatch(/RELATED=END/i);

    // 光看字符串不够：真正要成立的是「下游按事件结束算」。
    const parsed = parseTrigger(trigger);
    expect(parsed).toEqual({ kind: "relative", ms: -15 * 60_000, relatedToEnd: true });
  });

  it("保留 VALUE=DATE-TIME 的绝对触发", () => {
    const ev = parseEvent(vevent([alarmBlock("TRIGGER;VALUE=DATE-TIME:20260101T090000Z")]));
    const parsed = parseTrigger(ev?.alarms?.[0]?.trigger ?? "");
    expect(parsed?.kind).toBe("absolute");
    expect(parsed?.kind === "absolute" ? parsed.at.toISOString() : null).toBe("2026-01-01T09:00:00.000Z");
  });

  it("一份带两条 VALARM 的 VEVENT 解析出两条", () => {
    const ev = parseEvent(vevent([
      alarmBlock("TRIGGER:-PT15M"),
      alarmBlock("TRIGGER:-PT1H"),
    ]));
    expect(ev?.alarms?.map((a) => a.trigger)).toEqual(["-PT15M", "-PT1H"]);
  });

  it("不带参数的 TRIGGER 原文不变 —— trigger 是幂等键的一部分，改写会让已发过的提醒重发", () => {
    const ev = parseEvent(vevent([alarmBlock("TRIGGER:-PT15M")]));
    expect(ev?.alarms?.[0]?.trigger).toBe("-PT15M");
  });

  it("垃圾 TRIGGER 混在好的里面：只丢那一条，其余保留（第三方口径，不整体失败）", () => {
    const ev = parseEvent(vevent([
      alarmBlock("TRIGGER:-PT15M"),
      alarmBlock("TRIGGER:banana"),
      alarmBlock("TRIGGER:-PT1H"),
    ]));
    // 整份事件必须还在（不是 null），坏的那条不在，好的两条顺序不变。
    expect(ev).not.toBeNull();
    expect(ev?.summary).toBe("季度复盘");
    expect(ev?.alarms?.map((a) => a.trigger)).toEqual(["-PT15M", "-PT1H"]);
  });

  it("同一时刻的两种写法去重 —— 否则同一分钟响两次，而幂等键按原文存挡不住", () => {
    const ev = parseEvent(vevent([
      alarmBlock("TRIGGER:-PT15M"),
      alarmBlock("TRIGGER;RELATED=START:-PT15M"),
    ]));
    expect(ev?.alarms?.length).toBe(1);
  });

  it("超过 8 条截断", () => {
    const many = ["-PT5M", "-PT15M", "-PT30M", "-PT1H", "-PT2H", "-P1D", "-P1W", "-PT45M", "-PT3H"]
      .map((t) => alarmBlock(`TRIGGER:${t}`));
    const ev = parseEvent(vevent(many));
    expect(ev?.alarms?.length).toBe(MAX_ALARMS_PER_EVENT);
  });

  it("一条 VALARM 都没有时 alarms 是 null（PUT 侧据此判定「用户删了提醒」）", () => {
    expect(parseEvent(vevent([]))?.alarms).toBeNull();
  });
});

describe("serializeEvent: 合成的 VEVENT 要带上提醒", () => {
  function base(): IcalEvent {
    return {
      uid: "evt-1@example.com",
      summary: "季度复盘",
      startsAt: new Date("2026-06-10T09:00:00Z"),
      endsAt: new Date("2026-06-10T11:00:00Z"),
      allDay: false,
    };
  }

  it("带 alarms 时输出 VALARM，且参数原样带出去", () => {
    const ics = serializeEvent({ ...base(), alarms: [{ trigger: "RELATED=END:-PT15M" }] });
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("TRIGGER;RELATED=END:-PT15M");
    expect(ics).toContain("END:VALARM");
  });

  it("round-trip：serialize → parse 之后仍然是「按结束算」", () => {
    const ics = serializeEvent({ ...base(), alarms: [{ trigger: "RELATED=END:-PT15M" }] });
    const back = parseEvent(ics);
    expect(parseTrigger(back?.alarms?.[0]?.trigger ?? "")).toEqual({
      kind: "relative", ms: -15 * 60_000, relatedToEnd: true,
    });
  });

  it("没有 alarms 就一行 VALARM 都不发", () => {
    expect(serializeEvent(base())).not.toContain("VALARM");
  });

  it("库里存着的垃圾 trigger 不会变成一条客户端解析不了的 VALARM", () => {
    const ics = serializeEvent({ ...base(), alarms: [{ trigger: "banana" }, { trigger: "-PT30M" }] });
    expect(ics).not.toContain("banana");
    expect(ics).toContain("TRIGGER:-PT30M");
  });

  it("EMAIL 提醒降级成 DISPLAY —— 合成路径拿不到 RFC 要求的 SUMMARY/ATTENDEE", () => {
    const ics = serializeEvent({ ...base(), alarms: [{ trigger: "-PT30M", action: "EMAIL" }] });
    expect(ics).toContain("ACTION:DISPLAY");
    expect(ics).not.toContain("ACTION:EMAIL");
  });
});

describe("applyAlarmsFromPut: PUT 是整份资源替换", () => {
  // 第三个参数是「客户端手上是不是当前这一版」——只有带 If-Match 且命中当前 etag 的
  // PUT 能证明这件事。证明不了的盲写不再当成删除（对应的断言在
  // test/caldav_legacy_shapes.test.ts 和 test/integration/caldav_alarm_window.int.test.ts）。
  it("第二次 PUT 不带任何 VALARM → alarms 被清空（删不掉提醒的那个 bug）", () => {
    const extra: Record<string, unknown> = {
      alarms: [{ trigger: "-PT15M" }],
      timezone: "Asia/Shanghai",
      categories: ["工作"],
    };
    applyAlarmsFromPut(extra, { alarms: null }, { clientHasCurrentCopy: true });
    expect(extra.alarms).toBeUndefined();
    expect("alarms" in extra).toBe(false);
    // 别把不该清的清了。
    expect(extra.timezone).toBe("Asia/Shanghai");
    expect(extra.categories).toEqual(["工作"]);
  });

  it("带 VALARM 的 PUT 整组覆盖，不和老的求并集", () => {
    const extra: Record<string, unknown> = { alarms: [{ trigger: "-PT15M" }, { trigger: "-P1D" }] };
    applyAlarmsFromPut(extra, { alarms: [{ trigger: "-PT1H" }] }, { clientHasCurrentCopy: true });
    expect(extra.alarms).toEqual([{ trigger: "-PT1H" }]);
  });
});

describe("mergeImportExtra: 订阅刷新不许整块替换 extra", () => {
  it("二次刷新保留用户在这个事件上设的其它键", () => {
    const existing = { source: "sub:s1", alarms: [{ trigger: "-PT30M" }], categories: ["课表"] };
    const merged = mergeImportExtra(existing, "sub:s1", null);
    expect(merged).toEqual({ source: "sub:s1", alarms: [{ trigger: "-PT30M" }], categories: ["课表"] });
  });

  it("上游带 VALARM 就以上游为准", () => {
    const merged = mergeImportExtra({ source: "sub:s1", alarms: [{ trigger: "-PT30M" }] }, "sub:s1", [{ trigger: "-PT1H" }]);
    expect(merged?.alarms).toEqual([{ trigger: "-PT1H" }]);
  });

  it("上游没有 VALARM 不等于删提醒 —— 它从没看过用户加的那条", () => {
    const merged = mergeImportExtra({ alarms: [{ trigger: "-PT30M" }] }, "sub:s1", []);
    expect(merged?.alarms).toEqual([{ trigger: "-PT30M" }]);
  });

  it("首次导入且没有 sourceTag / 提醒时给 null，不落一个空对象", () => {
    expect(mergeImportExtra(null, null, null)).toBeNull();
  });
});
