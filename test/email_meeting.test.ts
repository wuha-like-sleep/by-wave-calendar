import { describe, it, expect } from "vitest";
import { eventInviteMail } from "../src/lib/email_templates.js";

const base = {
  organizerEmail: "host@x.com",
  organizerName: "Host",
  summary: "周会",
  startsAt: new Date("2026-07-01T10:00:00Z"),
  endsAt: new Date("2026-07-01T11:00:00Z"),
  allDay: false,
  uid: "u@x",
  icsBody: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
};

describe("eventInviteMail — meeting variant", () => {
  it("renders the meeting variant for a known conferencing URL", () => {
    const m = eventInviteMail("a@x.com", { ...base, meetingUrl: "https://meeting.tencent.com/dm/abc123" });
    expect(m.subject).toContain("【会议】");
    expect(m.html).toContain("会议邀请");
    expect(m.html).toContain("加入会议");
    expect(m.html).toContain("meeting.tencent.com/dm/abc123");
    expect(m.text).toContain("会议链接");
  });

  it("stays a plain event invite when there's no URL", () => {
    const m = eventInviteMail("a@x.com", { ...base });
    expect(m.subject).toContain("【邀请】");
    expect(m.html).toContain("事件邀请");
    expect(m.html).not.toContain("加入会议");
  });

  it("a generic (non-conferencing) URL shows a link button but stays an event", () => {
    const m = eventInviteMail("a@x.com", { ...base, meetingUrl: "https://docs.example.com/agenda" });
    expect(m.subject).toContain("【邀请】"); // not 【会议】
    expect(m.subject).not.toContain("【会议】");
    expect(m.html).toContain("打开链接");
    expect(m.html).toContain("事件邀请");
  });

  it("refuses a non-http(s) scheme — no javascript:/data: button (XSS guard)", () => {
    const m = eventInviteMail("a@x.com", { ...base, meetingUrl: "javascript:alert(1)" });
    expect(m.html).not.toContain("javascript:alert");
    expect(m.html).not.toContain("加入会议");
    expect(m.html).not.toContain("打开链接");
  });
});
