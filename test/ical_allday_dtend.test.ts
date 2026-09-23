import { describe, it, expect } from "vitest";
import { serializeEvent, invitationIcs, parseEvent, extractVeventBlock } from "../src/lib/ical.js";

// 全天事件导出去的 DTEND —— 这条决定了它在 Apple 日历 / DAVx⁵ 里画在哪天。
//
// ── 为什么会错 ────────────────────────────────────────────────────────
//
// RFC 5545 规定全天事件的 DTEND 是**不含**的（次日）。而库里有两套约定：
//   · 网页 / 三端 App 写「当天 23:59:59.999Z」（闭区间）
//   · .ics 导入写「次日 00:00:00Z」（半开区间，RFC 的口径）
//
// 原来的序列化是直接 formatDate(endsAt)：对后者正确，对前者会输出**和
// DTSTART 同一天** —— 零长度事件。也就是说**在网页或 App 上建的每一个
// 全天事件，同步到手机自带日历里都是错的**，而 .ics 导入进来的反而对。
//
// 这条影响的是 CalDAV（src/web/caldav.ts 用的就是 serializeEvent）和
// .ics 导出两条路 —— 也就是用户把这个日历接进 iPhone 自带日历之后看到的东西。
//
// 判据必须**两套约定都测**：只测一种等于没测（这个仓库在 EXIF 字节序上
// 踩过一模一样的形状）。

function dtendOf(ics: string): string | null {
  const m = /^DTEND;VALUE=DATE:(\d{8})/m.exec(ics.replace(/\r\n/g, "\n"));
  return m?.[1] ?? null;
}
function dtstartOf(ics: string): string | null {
  const m = /^DTSTART;VALUE=DATE:(\d{8})/m.exec(ics.replace(/\r\n/g, "\n"));
  return m?.[1] ?? null;
}

function ev(startsAt: string, endsAt: string) {
  return {
    uid: "u1", summary: "年假", startsAt: new Date(startsAt), endsAt: new Date(endsAt),
    allDay: true, description: null, location: null, rrule: null,
    timezone: null, updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as Parameters<typeof serializeEvent>[0];
}

describe("全天事件导出的 DTEND 必须是次日（RFC 5545）", () => {
  it("确实产出了 DTSTART/DTEND（presence）", () => {
    // 少了这条，正则一失配就变成 null === null，下面全都恒成立。
    const ics = serializeEvent(ev("2026-09-21T00:00:00.000Z", "2026-09-21T23:59:59.999Z"));
    expect(dtstartOf(ics), "没解析出 DTSTART —— 判据瞎了").toBe("20260921");
    expect(dtendOf(ics)).toBeTruthy();
  });

  // ── 闭区间（网页 / 三端 App 写进去的）──
  it("网页建的单日全天：DTEND 是次日，不是同一天", () => {
    const ics = serializeEvent(ev("2026-09-21T00:00:00.000Z", "2026-09-21T23:59:59.999Z"));
    expect(
      dtendOf(ics),
      "DTSTART 和 DTEND 同一天 —— 按 RFC 那是零长度事件，" +
        "Apple 日历要么不显示、要么画到前一天。在网页上建的每一个全天事件都是这样。",
    ).toBe("20260922");
  });

  it("网页建的两天全天：覆盖 21、22 两天", () => {
    const ics = serializeEvent(ev("2026-09-21T00:00:00.000Z", "2026-09-22T23:59:59.999Z"));
    expect(dtendOf(ics)).toBe("20260923");
  });

  // ── 半开区间（.ics 导入进来的）——原来就是对的，不许改坏 ──
  it("ics 导入的单日全天：仍然是次日", () => {
    const ics = serializeEvent(ev("2026-09-21T00:00:00.000Z", "2026-09-22T00:00:00.000Z"));
    expect(dtendOf(ics), "把本来对的那一套改坏了").toBe("20260922");
  });

  it("ics 导入的两天全天：仍然正确", () => {
    const ics = serializeEvent(ev("2026-09-21T00:00:00.000Z", "2026-09-23T00:00:00.000Z"));
    expect(dtendOf(ics)).toBe("20260923");
  });

  // ── 坏数据 ──
  it("start == end 的坏行：DTEND 至少是次日，绝不能早于 DTSTART", () => {
    // 历史上一次错误的导出-导入往返会造出这种行（导出 DTEND=当天 →
    // 导入按「不含」解释 → end 变成 start）。
    const ics = serializeEvent(ev("2026-09-21T00:00:00.000Z", "2026-09-21T00:00:00.000Z"));
    expect(dtendOf(ics)).toBe("20260922");
  });

  it("邀请函那条路也一样（它是另一个序列化函数，很容易只改一处）", () => {
    const ics = invitationIcs({
      event: ev("2026-09-21T00:00:00.000Z", "2026-09-21T23:59:59.999Z"),
      organizerEmail: "a@example.com",
      attendees: [{ email: "b@example.com" }],
      method: "REQUEST",
    });
    expect(dtendOf(ics), "只改了 serializeEvent，邀请函那条路还是错的").toBe("20260922");
  });

  it("导出再导回来，日期不变（往返一致）", () => {
    // 导出错了的话，往返会让事件每走一圈缩掉一天 —— 这是最难察觉的那种。
    const ics = serializeEvent(ev("2026-09-21T00:00:00.000Z", "2026-09-21T23:59:59.999Z"));
    const block = extractVeventBlock(`BEGIN:VCALENDAR\r\n${ics}\r\nEND:VCALENDAR`);
    expect(block, "取不出 VEVENT —— 这条用例什么也没测到").toBeTruthy();
    const back = parseEvent(block!);
    expect(back, "解析不出来").toBeTruthy();
    expect(back!.allDay).toBe(true);
    expect(back!.startsAt.toISOString().slice(0, 10)).toBe("2026-09-21");
    // 导入侧按「不含」解释，所以回来的 endsAt 是 22 日零点 —— 仍然覆盖 21 那一天。
    expect(back!.endsAt.toISOString()).toBe("2026-09-22T00:00:00.000Z");
  });
});
