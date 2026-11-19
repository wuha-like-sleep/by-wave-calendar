// 同步内容保真（单元层）：字段在 ICS 序列化/解析与导出组装里 round-trip 不丢。
//
// 守的是三类曾经真实丢过的东西：
//   · TRANSP / STATUS / CATEGORIES / URL：parse 收了、PUT 存了，serialize 却不写，
//     合成路径（网页/API 建的、或被 PATCH 清掉 rawIcs 的事件）一律丢；
//   · 没有 DTEND 的事件（DURATION 顶替 / RFC 缺省）：以前整条判无效；
//   · 属主导出（full）与公开订阅（默认）两种口径别串：公开那份绝不能带
//     参与者邮箱和提醒，属主那份绝不能丢。
import { describe, it, expect } from "vitest";
import type { IcalEvent } from "../src/lib/ical.js";
import type { Calendar, Event } from "../src/db/schema.js";

// services/ics.ts 与 ical.ts（经 email_templates）都会拉到 env，env 解析不过
// 是 process.exit(1)。先把三个必填项兜上再动态 import（照 attendees_shape 的写法）。
process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
process.env.SESSION_SECRET ||= "test-session-secret-at-least-32-chars-long";
const { serializeEvent, parseEvent, parseDurationMs } = await import("../src/lib/ical.js");
const { buildIcsFeed } = await import("../src/services/ics.js");

const D = (iso: string) => new Date(iso);

function baseEvent(): IcalEvent {
  return {
    uid: "fid-123",
    summary: "Fidelity check",
    startsAt: D("2026-06-01T10:00:00Z"),
    endsAt: D("2026-06-01T11:00:00Z"),
    allDay: false,
  };
}

describe("serializeEvent / parseEvent 保真字段", () => {
  it("TRANSP / STATUS / CATEGORIES / URL 写得出也读得回", () => {
    const ev: IcalEvent = {
      ...baseEvent(),
      transp: "TRANSPARENT",
      status: "TENTATIVE",
      categories: ["Work", "Q3, Planning"],
      url: "https://meet.example.com/room-42",
    };
    const ics = serializeEvent(ev);
    expect(ics).toContain("TRANSP:TRANSPARENT");
    expect(ics).toContain("STATUS:TENTATIVE");
    expect(ics).toContain("CATEGORIES:Work,Q3\\, Planning");
    expect(ics).toContain("URL:https://meet.example.com/room-42");
    const back = parseEvent(ics);
    expect(back?.transp).toBe("TRANSPARENT");
    expect(back?.status).toBe("TENTATIVE");
    expect(back?.categories).toEqual(["Work", "Q3, Planning"]);
    expect(back?.url).toBe("https://meet.example.com/room-42");
  });

  it("没有这几项时不凭空造行", () => {
    const ics = serializeEvent(baseEvent());
    expect(ics).not.toContain("TRANSP:");
    expect(ics).not.toContain("STATUS:");
    expect(ics).not.toContain("CATEGORIES:");
    expect(ics).not.toContain("\nURL:");
  });
});

describe("parseEvent 的 DTEND 缺省与 DURATION", () => {
  const wrap = (vevent: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", vevent, "END:VCALENDAR"].join("\r\n");

  it("DURATION 顶替 DTEND（PT1H30M）", () => {
    const ev = parseEvent(wrap([
      "BEGIN:VEVENT", "UID:dur-1", "SUMMARY:Duration event",
      "DTSTART:20260601T100000Z", "DURATION:PT1H30M", "END:VEVENT",
    ].join("\r\n")));
    expect(ev).not.toBeNull();
    expect(ev!.endsAt.getTime() - ev!.startsAt.getTime()).toBe(90 * 60 * 1000);
  });

  it("DURATION 按天（P2D，全天多日）", () => {
    const ev = parseEvent(wrap([
      "BEGIN:VEVENT", "UID:dur-2", "SUMMARY:Two days",
      "DTSTART;VALUE=DATE:20260601", "DURATION:P2D", "END:VEVENT",
    ].join("\r\n")));
    expect(ev).not.toBeNull();
    expect(ev!.allDay).toBe(true);
    expect(ev!.endsAt.getTime() - ev!.startsAt.getTime()).toBe(2 * 86_400_000);
  });

  it("既无 DTEND 也无 DURATION：全天默认 1 天、定时默认同时刻（RFC 5545 §3.6.1）", () => {
    const allDay = parseEvent(wrap([
      "BEGIN:VEVENT", "UID:dur-3", "SUMMARY:One day",
      "DTSTART;VALUE=DATE:20260601", "END:VEVENT",
    ].join("\r\n")));
    expect(allDay!.endsAt.getTime() - allDay!.startsAt.getTime()).toBe(86_400_000);
    const timed = parseEvent(wrap([
      "BEGIN:VEVENT", "UID:dur-4", "SUMMARY:Instant",
      "DTSTART:20260601T100000Z", "END:VEVENT",
    ].join("\r\n")));
    expect(timed!.endsAt.getTime()).toBe(timed!.startsAt.getTime());
  });

  it("parseDurationMs 基本形状与坏值", () => {
    expect(parseDurationMs("PT15M")).toBe(15 * 60 * 1000);
    expect(parseDurationMs("P1W")).toBe(7 * 86_400_000);
    expect(parseDurationMs("-PT15M")).toBe(-15 * 60 * 1000);
    expect(parseDurationMs("banana")).toBeNull();
    expect(parseDurationMs("P")).toBeNull();
  });

  it("RECURRENCE-ID 被捕获成 ISO 时刻", () => {
    const ev = parseEvent(wrap([
      "BEGIN:VEVENT", "UID:master-1", "SUMMARY:Moved once",
      "DTSTART:20260608T100000Z", "DTEND:20260608T110000Z",
      "RECURRENCE-ID:20260608T090000Z", "END:VEVENT",
    ].join("\r\n")));
    expect(ev!.recurrenceId).toBe("2026-06-08T09:00:00.000Z");
  });
});

describe("buildIcsFeed 两种口径", () => {
  const cal = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Work",
    description: null,
    timezone: "Australia/Sydney",
  } as unknown as Calendar;
  const row = {
    id: "00000000-0000-0000-0000-000000000002",
    calendarId: cal.id,
    uid: "feed-1",
    summary: "Feed event",
    description: "Desc",
    location: "Office",
    startsAt: D("2026-06-01T10:00:00Z"),
    endsAt: D("2026-06-01T11:00:00Z"),
    allDay: false,
    rrule: null,
    exdates: null,
    rawIcs: null,
    extra: {
      attendees: ["someone.else@example.com"],
      organizer: "owner@example.com",
      alarms: [{ trigger: "-PT15M", action: "DISPLAY" }],
      categories: ["Work"],
      transp: "OPAQUE",
      status: "CONFIRMED",
      url: "https://meet.example.com/feed",
    },
    deletedAt: null,
    createdAt: D("2026-05-01T00:00:00Z"),
    updatedAt: D("2026-05-02T00:00:00Z"),
  } as unknown as Event;

  it("默认（公开订阅）：不带参与者 / 组织者 / 提醒", () => {
    const body = buildIcsFeed(cal, [row]);
    expect(body).toContain("SUMMARY:Feed event");
    expect(body).not.toContain("ATTENDEE");
    expect(body).not.toContain("ORGANIZER");
    expect(body).not.toContain("VALARM");
    expect(body).not.toContain("someone.else@example.com");
  });

  it("full（属主导出）：参与者 / 提醒 / 分类 / TRANSP / STATUS / URL 全带", () => {
    // 长行会按 RFC 折行（CRLF+空格），断言前先展开，否则邮箱会被折行劈开。
    const body = buildIcsFeed(cal, [row], { full: true }).replace(/\r\n /g, "");
    expect(body).toContain("ATTENDEE");
    expect(body).toContain("someone.else@example.com");
    expect(body).toContain("ORGANIZER:mailto:owner@example.com");
    expect(body).toContain("BEGIN:VALARM");
    expect(body).toContain("CATEGORIES:Work");
    expect(body).toContain("TRANSP:OPAQUE");
    expect(body).toContain("STATUS:CONFIRMED");
    expect(body).toContain("URL:https://meet.example.com/feed");
  });
});
