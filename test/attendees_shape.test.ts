// 参与者形状收口（lib/attendees.ts）+ extra 存量形状的纯逻辑断言。
//
// 从 HTTP 打进去的那几条在 test/integration/events_legacy_extra.int.test.ts 和
// caldav_alarm_window.int.test.ts；这里钉的是收口模块自己的口径，以及
// serializeEvent / extraSchema 这两个「调用点少做了一件事」的地方。
import { describe, it, expect } from "vitest";

import { attendeeDetails, attendeeEmails, normalizeExtraForClients } from "../src/lib/attendees.js";
import { serializeEvent, type IcalEvent } from "../src/lib/ical.js";

// routes/events.ts 一路拉到 db/client → env，env 解析不过是 process.exit(1)，
// 整个 vitest 进程直接没了。先把三个必填项兜上再动态 import（照 events_extra_merge.test.ts 的写法）。
process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://bwc:bwc@127.0.0.1:5432/bwc_test";
process.env.SESSION_SECRET ||= "test-session-secret-at-least-32-chars-long";
const { extraSchema } = await import("../src/routes/events.js");

// CalDAV / .ics 那一路存进 extra.attendees 的形状（ical.ts parseEvent 的产出）。
const OBJECT_SHAPE = [
  { email: "alice@example.com", cn: "Alice", role: "REQ-PARTICIPANT", partstat: "ACCEPTED" },
  { email: "bob@example.com", cn: null, role: null, partstat: null },
];
// 网页 / JSON API 那一路存进去的形状。
const STRING_SHAPE = ["alice@example.com", "bob@example.com"];

describe("attendeeEmails —— 两种存量形状读出来是同一串邮箱", () => {
  it("对象数组", () => {
    expect(attendeeEmails(OBJECT_SHAPE)).toEqual(STRING_SHAPE);
  });

  it("字符串数组", () => {
    expect(attendeeEmails(STRING_SHAPE)).toEqual(STRING_SHAPE);
  });

  it("混着来也行（一个事件被两条路径先后写过）", () => {
    expect(attendeeEmails(["alice@example.com", { email: "bob@example.com" }])).toEqual(STRING_SHAPE);
  });

  it("mailto: 前缀剥掉，大小写收平", () => {
    expect(attendeeEmails(["MAILTO:Alice@Example.COM"])).toEqual(["alice@example.com"]);
  });

  it("同一个人写两遍只留一个，顺序按第一次出现", () => {
    expect(attendeeEmails([{ email: "Bob@example.com" }, "bob@example.com", "alice@example.com"]))
      .toEqual(["bob@example.com", "alice@example.com"]);
  });

  it("不是邮箱的丢掉 —— iOS 有时用内部身份当 ATTENDEE，它既发不了邮件也显示不出人名", () => {
    expect(attendeeEmails([
      "urn:uuid:8f1c2b3a-0000-4000-8000-000000000000",
      { email: "/principals/users/alice" },
      "alice@example.com",
      "",
      null,
      42,
    ])).toEqual(["alice@example.com"]);
  });

  it("不是数组就是空列表，不抛（JSONB 列里什么都塞得下）", () => {
    expect(attendeeEmails(null)).toEqual([]);
    expect(attendeeEmails(undefined)).toEqual([]);
    expect(attendeeEmails("alice@example.com")).toEqual([]);
    expect(attendeeEmails({ email: "alice@example.com" })).toEqual([]);
  });
});

describe("attendeeDetails —— 序列化要用的显示参数不能在收口时丢掉", () => {
  it("对象项保留 cn / role / partstat", () => {
    expect(attendeeDetails(OBJECT_SHAPE)[0]).toEqual({
      email: "alice@example.com", cn: "Alice", role: "REQ-PARTICIPANT", partstat: "ACCEPTED",
    });
  });

  it("字符串项只有 email，其余交给 serializeEvent 取默认值", () => {
    expect(attendeeDetails(["alice@example.com"])).toEqual([{ email: "alice@example.com" }]);
  });
});

describe("serializeEvent —— 网页加的参与者也要发 ATTENDEE 行", () => {
  // RFC 5545 的折行：超过 75 字节的属性行会被折成 CRLF + 空格。断言前先展开，
  // 否则一条本来正确的 ATTENDEE 行只是因为长就判红。
  const unfold = (ics: string) => ics.replace(/\r?\n[\t ]/g, "");

  function base(): IcalEvent {
    return {
      uid: "evt-1@example.com",
      summary: "季度复盘",
      startsAt: new Date("2026-06-10T09:00:00Z"),
      endsAt: new Date("2026-06-10T11:00:00Z"),
      allDay: false,
    };
  }

  it("字符串形状的参与者照样出 ATTENDEE —— 以前 `if (!a.email) continue` 把它整组跳过了", () => {
    const ics = unfold(serializeEvent({ ...base(), attendees: STRING_SHAPE }));
    expect(ics).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@example.com");
    expect(ics).toContain("mailto:bob@example.com");
  });

  it("对象形状照旧带上 CN / PARTSTAT", () => {
    const ics = unfold(serializeEvent({ ...base(), attendees: OBJECT_SHAPE }));
    expect(ics).toContain("ATTENDEE;CN=Alice;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:alice@example.com");
  });

  it("发不出去的身份不会变成一行空 ATTENDEE", () => {
    const ics = serializeEvent({ ...base(), attendees: ["urn:uuid:8f1c2b3a-0000-4000-8000-000000000000"] });
    expect(ics).not.toContain("ATTENDEE");
  });
});

describe("normalizeExtraForClients —— 发出去之前把对象数组收口", () => {
  it("对象数组换成邮箱数组，其它键原样", () => {
    expect(normalizeExtraForClients({ attendees: OBJECT_SHAPE, category: "工作" }))
      .toEqual({ attendees: STRING_SHAPE, category: "工作" });
  });

  it("本来就是规范形状时原样返回同一个对象（不白建一份）", () => {
    const extra = { attendees: STRING_SHAPE, category: "工作" };
    expect(normalizeExtraForClients(extra)).toBe(extra);
  });

  it("没有 attendees / 不是对象的 extra 不动", () => {
    const extra = { category: "工作" };
    expect(normalizeExtraForClients(extra)).toBe(extra);
    expect(normalizeExtraForClients(null)).toBeNull();
  });

  it("不改传进来的那份", () => {
    const extra = { attendees: OBJECT_SHAPE };
    normalizeExtraForClients(extra);
    expect(extra.attendees).toEqual(OBJECT_SHAPE);
  });
});

describe("extraSchema —— 存量形状进得来（进不来就是「一保存就 400」）", () => {
  it("VALARM 的 action / description 是 null 也收（老的 parseEvent 写的就是 null）", () => {
    const r = extraSchema.safeParse({
      alarms: [{ trigger: "-PT15M", action: null, description: null }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // strip 之后 normalizeAlarms 本来就会把这两个空值丢掉。
    expect(r.data?.alarms).toEqual([{ trigger: "-PT15M" }]);
  });

  it("超长的 DESCRIPTION 裁掉，不判错 —— 第三方客户端写进来的值不该让用户从此存不下去", () => {
    const r = extraSchema.safeParse({
      alarms: [{ trigger: "-PT15M", description: "长".repeat(900) }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect((r.data?.alarms?.[0]?.description ?? "").length).toBe(500);
  });

  it("带一长串参数的 TRIGGER 不再撞 50 字上限", () => {
    const long = "RELATED=END;VALUE=DURATION;X-WR-ALARMUID=6f2a1c40-77b2-4f0e-9c1f-6a2b3c4d5e6f:-PT15M";
    expect(long.length).toBeGreaterThan(50);
    expect(extraSchema.safeParse({ alarms: [{ trigger: long }] }).success).toBe(true);
  });

  it("参与者两种写法都收，存下去的只有一种", () => {
    const r = extraSchema.safeParse({ attendees: OBJECT_SHAPE });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data?.attendees).toEqual(STRING_SHAPE);
  });

  it("用户自己输的邮箱写错了照旧判错（宽的只是存量对象那一路）", () => {
    const r = extraSchema.safeParse({ attendees: ["not-an-email"] });
    expect(r.success).toBe(false);
  });

  it("trigger 解析不了照旧判错 —— 这条口径没松", () => {
    expect(extraSchema.safeParse({ alarms: [{ trigger: "banana" }] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("读参与者只许走收口模块（源码门禁）", () => {
  // 网页那三个 handler（/app/events/:id/attendees 的展示 / 邀请 / 撤销）没有 HTTP 层的
  // 断言 —— 它们要 CSRF 钩子 + 模板渲染，harness 的 buildRoutedApp 复刻不了。
  // 这条门禁钉的是「那三处不许再自己 Array.isArray 一遍」这件事本身：
  // 它照不出逻辑对不对，但 `Array.isArray(extra.attendees)` 这个写法回来一次它就红一次，
  // 而那个写法正是三个 bug 的共同形状（对对象数组恒为 false / 恒为真）。
  const files = [
    "../src/routes/events.ts",
    "../src/web/index.ts",
    "../src/web/caldav.ts",
  ] as const;

  for (const rel of files) {
    it(`${rel} 里没有直接当字符串数组用的读法`, async () => {
      const { readFileSync } = await import("node:fs");
      const code = readFileSync(new URL(rel, import.meta.url), "utf8")
        .replace(/^\s*\/\/.*$/gm, "");          // 注释里提到这个写法是在解释 bug，先剥掉
      expect(code).not.toMatch(/Array\.isArray\(\s*extra[^)]*\.attendees\s*\)/);
      expect(code).not.toMatch(/extra[^)\n]*\.attendees\s+as\s+string\[\]/);
      expect(code).toMatch(/attendeeEmails\(/);
    });
  }
});
