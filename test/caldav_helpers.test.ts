import { describe, it, expect } from "vitest";
import { overlayPartstat, mergeExdatesIntoVevent, ifMatchAllows, ifNoneMatchAllows } from "../src/lib/caldav_helpers.js";

const CRLF = "\r\n";

function vevent(lines: string[]): string {
  return ["BEGIN:VEVENT", "UID:test", "DTSTAMP:20260601T000000Z",
    "DTSTART:20260601T100000Z", "DTEND:20260601T110000Z", "SUMMARY:x",
    ...lines, "END:VEVENT"].join(CRLF);
}

describe("overlayPartstat", () => {
  it("replaces PARTSTAT on a matching ATTENDEE line", () => {
    const ics = vevent([
      "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@example.com",
    ]);
    const out = overlayPartstat(ics, new Map([["alice@example.com", "ACCEPTED"]]));
    expect(out).toContain("PARTSTAT=ACCEPTED");
    expect(out).not.toContain("PARTSTAT=NEEDS-ACTION");
  });

  it("appends PARTSTAT when missing from the line", () => {
    const ics = vevent([
      "ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:alice@example.com",
    ]);
    const out = overlayPartstat(ics, new Map([["alice@example.com", "DECLINED"]]));
    expect(out).toContain("PARTSTAT=DECLINED");
  });

  it("is case-insensitive on email match", () => {
    const ics = vevent([
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:Alice@Example.COM",
    ]);
    const out = overlayPartstat(ics, new Map([["alice@example.com", "ACCEPTED"]]));
    expect(out).toContain("PARTSTAT=ACCEPTED");
  });

  it("leaves untracked emails alone", () => {
    const ics = vevent([
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alice@example.com",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com",
    ]);
    const out = overlayPartstat(ics, new Map([["alice@example.com", "ACCEPTED"]]));
    // alice updated, bob unchanged
    expect(out).toMatch(/PARTSTAT=ACCEPTED[^\r\n]*alice/);
    expect(out).toMatch(/PARTSTAT=NEEDS-ACTION[^\r\n]*bob/);
  });

  it("is a no-op when the map is empty", () => {
    const ics = vevent([
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alice@example.com",
    ]);
    const out = overlayPartstat(ics, new Map());
    expect(out).toBe(ics);
  });
});

describe("mergeExdatesIntoVevent", () => {
  it("injects EXDATE lines before END:VEVENT", () => {
    const ics = vevent(["RRULE:FREQ=WEEKLY"]);
    const out = mergeExdatesIntoVevent(ics, {
      exdates: ["2026-06-08T10:00:00.000Z"],
      allDay: false,
    });
    expect(out).toContain("EXDATE:20260608T100000Z");
    // Injected before END:VEVENT, not after
    const exIdx = out.indexOf("EXDATE:");
    const endIdx = out.indexOf("END:VEVENT");
    expect(exIdx).toBeLessThan(endIdx);
  });

  it("strips existing EXDATE lines from the raw body", () => {
    // Raw body claims an old exdate that the DB no longer has.
    const ics = vevent([
      "RRULE:FREQ=WEEKLY",
      "EXDATE:20260615T100000Z",  // stale
    ]);
    const out = mergeExdatesIntoVevent(ics, {
      exdates: ["2026-06-08T10:00:00.000Z"],
      allDay: false,
    });
    expect(out).toContain("EXDATE:20260608T100000Z");
    expect(out).not.toContain("EXDATE:20260615T100000Z");
  });

  it("uses VALUE=DATE form for all-day events", () => {
    const ics = vevent(["RRULE:FREQ=DAILY"]);
    const out = mergeExdatesIntoVevent(ics, {
      exdates: ["2026-06-02T00:00:00.000Z"],
      allDay: true,
    });
    expect(out).toContain("EXDATE;VALUE=DATE:20260602");
  });

  it("skips malformed ISO strings without throwing", () => {
    const ics = vevent(["RRULE:FREQ=WEEKLY"]);
    const out = mergeExdatesIntoVevent(ics, {
      exdates: ["not-a-date", "2026-06-08T10:00:00.000Z"],
      allDay: false,
    });
    expect(out).toContain("EXDATE:20260608T100000Z");
    expect(out).not.toContain("not-a-date");
  });

  it("is a fast-path no-op when neither side has exdates", () => {
    const ics = vevent(["RRULE:FREQ=WEEKLY"]);
    const out = mergeExdatesIntoVevent(ics, { exdates: [], allDay: false });
    expect(out).toBe(ics);
  });

  it("drops any stale EXDATE even when the DB list is empty", () => {
    const ics = vevent([
      "RRULE:FREQ=WEEKLY",
      "EXDATE:20260615T100000Z",
    ]);
    const out = mergeExdatesIntoVevent(ics, { exdates: [], allDay: false });
    expect(out).not.toContain("EXDATE:");
  });
});

describe("ifMatchAllows / ifNoneMatchAllows（条件请求判定）", () => {
  const ETAG = '"abc123"';

  it("没带头 = 不约束，两种资源状态都放行", () => {
    expect(ifMatchAllows(undefined, ETAG)).toBe(true);
    expect(ifMatchAllows(undefined, null)).toBe(true);
    expect(ifNoneMatchAllows(undefined, ETAG)).toBe(true);
    expect(ifNoneMatchAllows(undefined, null)).toBe(true);
  });

  it("If-Match 命中当前 etag 放行、不命中拒绝", () => {
    expect(ifMatchAllows(ETAG, ETAG)).toBe(true);
    expect(ifMatchAllows('"other"', ETAG)).toBe(false);
  });

  it("If-Match: * 只要求资源存在", () => {
    expect(ifMatchAllows("*", ETAG)).toBe(true);
    expect(ifMatchAllows("*", null)).toBe(false);
  });

  it("资源不存在时任何 If-Match 都不成立（新建带 If-Match 必须被拒）", () => {
    expect(ifMatchAllows(ETAG, null)).toBe(false);
  });

  it("If-Match 列表里含当前 etag 即成立", () => {
    expect(ifMatchAllows('"old", "abc123"', ETAG)).toBe(true);
    expect(ifMatchAllows('"old", "older"', ETAG)).toBe(false);
  });

  it("弱前缀 W/ 剥掉再比（反代 gzip 改写过 etag 的情形）", () => {
    expect(ifMatchAllows('W/"abc123"', ETAG)).toBe(true);
    expect(ifNoneMatchAllows('W/"abc123"', ETAG)).toBe(false);
  });

  it("If-None-Match: * 是 create-only：资源在就拒、不在就放", () => {
    expect(ifNoneMatchAllows("*", ETAG)).toBe(false);
    expect(ifNoneMatchAllows("*", null)).toBe(true);
  });

  it("If-None-Match 带具体 etag：等于当前值才拒", () => {
    expect(ifNoneMatchAllows(ETAG, ETAG)).toBe(false);
    expect(ifNoneMatchAllows('"other"', ETAG)).toBe(true);
    expect(ifNoneMatchAllows(ETAG, null)).toBe(true);
  });
});
