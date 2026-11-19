import { describe, it, expect } from "vitest";
import { parseNaturalLanguageEvent } from "../src/lib/nl_parse.js";

// Fixed reference: 2026-07-03 is a Thursday, 10:00 local.
const NOW = "2026-07-03T10:00:00";

describe("parseNaturalLanguageEvent", () => {
  it("明天 + 下午 time + summary", () => {
    expect(parseNaturalLanguageEvent("明天 下午3点 牙医", NOW)).toEqual({
      summary: "牙医",
      startsAt: "2026-07-04T15:00:00",
      endsAt: "2026-07-04T16:00:00",
    });
  });

  it("后天 + time + explicit 30分钟 duration", () => {
    expect(parseNaturalLanguageEvent("后天 9点 30分钟 站会", NOW)).toEqual({
      summary: "站会",
      startsAt: "2026-07-05T09:00:00",
      endsAt: "2026-07-05T09:30:00",
    });
  });

  it("time only, already passed today → pushes to tomorrow", () => {
    // 8:00 < 10:00 now, no date given → tomorrow.
    expect(parseNaturalLanguageEvent("8点 晨会", NOW)).toEqual({
      summary: "晨会",
      startsAt: "2026-07-04T08:00:00",
      endsAt: "2026-07-04T09:00:00",
    });
  });

  it("date only → defaults to 09:00, 1h", () => {
    expect(parseNaturalLanguageEvent("明天 体检", NOW)).toEqual({
      summary: "体检",
      startsAt: "2026-07-04T09:00:00",
      endsAt: "2026-07-04T10:00:00",
    });
  });

  it("周一 (Fri → +3, always upcoming) with 1小时 duration", () => {
    expect(parseNaturalLanguageEvent("周一 10点 1小时 团建", NOW)).toEqual({
      summary: "团建",
      startsAt: "2026-07-06T10:00:00",
      endsAt: "2026-07-06T11:00:00",
    });
  });

  it("下周一 → Monday of the next calendar week (same day 下周 alone gives)", () => {
    expect(parseNaturalLanguageEvent("下周一 10点 复盘", NOW)?.startsAt).toBe("2026-07-06T10:00:00");
  });

  it("X月X日 absolute date", () => {
    expect(parseNaturalLanguageEvent("8月1日 上午9点 出差", NOW)?.startsAt).toBe("2026-08-01T09:00:00");
  });

  it("returns null when there is no date or time to anchor on", () => {
    expect(parseNaturalLanguageEvent("买牛奶", NOW)).toBeNull();
    expect(parseNaturalLanguageEvent("", NOW)).toBeNull();
  });

  // ---- 口语化扩充 (v1.6.7) ----

  it("今晚 → 今天晚上", () => {
    expect(parseNaturalLanguageEvent("今晚8点 聚餐", NOW)).toEqual({
      summary: "聚餐",
      startsAt: "2026-07-03T20:00:00",
      endsAt: "2026-07-03T21:00:00",
    });
  });

  it("礼拜五/星期五 normalize to 周五 (Fri now → next Fri)", () => {
    expect(parseNaturalLanguageEvent("礼拜五 9点 打球", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parseNaturalLanguageEvent("星期五 9点 打球", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
  });

  it("做礼拜 in summary is NOT eaten by the weekday rule", () => {
    const r = parseNaturalLanguageEvent("明天 上午10点 去教堂做礼拜", NOW);
    expect(r?.summary).toBe("去教堂做礼拜");
  });

  it("三天后", () => {
    expect(parseNaturalLanguageEvent("三天后 交报告", NOW)?.startsAt).toBe("2026-07-06T09:00:00");
  });

  it("下周 alone → next week's Monday", () => {
    expect(parseNaturalLanguageEvent("下周 述职", NOW)?.startsAt).toBe("2026-07-06T09:00:00");
  });

  it("下个月5号", () => {
    expect(parseNaturalLanguageEvent("下个月5号 还信用卡", NOW)?.startsAt).toBe("2026-08-05T09:00:00");
  });

  it("bare 15号 → this month when still ahead", () => {
    expect(parseNaturalLanguageEvent("15号 交房租", NOW)?.startsAt).toBe("2026-07-15T09:00:00");
  });

  it("bare 1号 already passed → next month", () => {
    expect(parseNaturalLanguageEvent("1号 交房租", NOW)?.startsAt).toBe("2026-08-01T09:00:00");
  });

  it("时间区间 下午3点到5点 → duration 2h", () => {
    expect(parseNaturalLanguageEvent("明天下午3点到5点 培训", NOW)).toEqual({
      summary: "培训",
      startsAt: "2026-07-04T15:00:00",
      endsAt: "2026-07-04T17:00:00",
    });
  });

  it("时间区间 end inherits start period + 半", () => {
    expect(parseNaturalLanguageEvent("明天下午3点半到5点 复盘", NOW)).toEqual({
      summary: "复盘",
      startsAt: "2026-07-04T15:30:00",
      endsAt: "2026-07-04T17:00:00",
    });
  });

  it("period without hour → colloquial default (下午 → 15:00)", () => {
    expect(parseNaturalLanguageEvent("明天下午 开会", NOW)?.startsAt).toBe("2026-07-04T15:00:00");
  });

  it("中午一点 means 13:00, not 12:00", () => {
    expect(parseNaturalLanguageEvent("中午一点 午饭", NOW)?.startsAt).toBe("2026-07-03T13:00:00");
  });

  it("傍晚6点 / 夜里11点 pm handling", () => {
    expect(parseNaturalLanguageEvent("明天傍晚6点 散步", NOW)?.startsAt).toBe("2026-07-04T18:00:00");
    expect(parseNaturalLanguageEvent("明天夜里11点 追剧", NOW)?.startsAt).toBe("2026-07-04T23:00:00");
  });

  it("俩钟头 duration", () => {
    expect(parseNaturalLanguageEvent("明天10点 俩钟头 培训", NOW)).toEqual({
      summary: "培训",
      startsAt: "2026-07-04T10:00:00",
      endsAt: "2026-07-04T12:00:00",
    });
  });

  it("is timezone-neutral: server TZ does not shift the wall-clock result", () => {
    // Same inputs must yield the same wall-clock string regardless of where
    // the server runs — we anchor everything to the caller's `now`.
    const a = parseNaturalLanguageEvent("明天 下午3点 x", "2026-07-03T10:00:00");
    expect(a?.startsAt).toBe("2026-07-04T15:00:00");
  });

  // ---- connected input (no spaces between tokens) ----
  it("parses fully connected input '明天下午三点开会'", () => {
    expect(parseNaturalLanguageEvent("明天下午三点开会", NOW)).toEqual({
      summary: "开会",
      startsAt: "2026-07-04T15:00:00",
      endsAt: "2026-07-04T16:00:00",
    });
  });

  it("大后天 wins over its 后天 substring (no whitespace guard)", () => {
    // 大后天 = +3 days → 2026-07-06, not +2.
    expect(parseNaturalLanguageEvent("大后天体检", NOW)?.startsAt).toBe("2026-07-06T09:00:00");
  });

  // ---- Chinese numerals ----
  it("Chinese-numeral hour '晚上八点半'", () => {
    expect(parseNaturalLanguageEvent("晚上八点半 吃饭", NOW)).toEqual({
      summary: "吃饭",
      startsAt: "2026-07-03T20:30:00",
      endsAt: "2026-07-03T21:30:00",
    });
  });

  it("Chinese-numeral hour ≥10 '十点二十'", () => {
    // 10:20 today already passed? no, 10:20 > 10:00 now → stays today.
    expect(parseNaturalLanguageEvent("十点二十 晨跑", NOW)?.startsAt).toBe("2026-07-03T10:20:00");
  });

  it("二十三点 (24h Chinese numeral)", () => {
    expect(parseNaturalLanguageEvent("明天二十三点 值班", NOW)?.startsAt).toBe("2026-07-04T23:00:00");
  });

  // ---- 刻 quarters ----
  it("'3点一刻' → :15 and '3点三刻' → :45", () => {
    expect(parseNaturalLanguageEvent("明天3点一刻 x", NOW)?.startsAt).toBe("2026-07-04T03:15:00");
    expect(parseNaturalLanguageEvent("明天3点三刻 x", NOW)?.startsAt).toBe("2026-07-04T03:45:00");
  });

  // ---- colon time ----
  it("colon time '15:30'", () => {
    expect(parseNaturalLanguageEvent("明天15:30 复盘", NOW)?.startsAt).toBe("2026-07-04T15:30:00");
  });

  // ---- Chinese durations ----
  it("'两小时' duration", () => {
    const r = parseNaturalLanguageEvent("明天10点 两小时 团建", NOW);
    expect(r?.startsAt).toBe("2026-07-04T10:00:00");
    expect(r?.endsAt).toBe("2026-07-04T12:00:00");
  });

  it("'一个半小时' duration → 90min", () => {
    const r = parseNaturalLanguageEvent("明天10点 一个半小时 workshop", NOW);
    expect(r?.endsAt).toBe("2026-07-04T11:30:00");
  });

  it("'半小时' duration → 30min", () => {
    const r = parseNaturalLanguageEvent("明天10点 半小时 站会", NOW);
    expect(r?.endsAt).toBe("2026-07-04T10:30:00");
  });

  // ---- 周末 ----
  it("周末 → upcoming Saturday", () => {
    // NOW is 2026-07-03 (Fri) → Saturday is +1 → 2026-07-04.
    expect(parseNaturalLanguageEvent("周末爬山", NOW)?.startsAt).toBe("2026-07-04T09:00:00");
  });

  it("下下周一 → Monday of the week after next", () => {
    expect(parseNaturalLanguageEvent("下下周一 10点 复盘", NOW)?.startsAt).toBe("2026-07-13T10:00:00");
  });

  it("does not treat a numeral inside a word as a time ('三国杀')", () => {
    // 三 without a 点/时 marker must not become 03:00.
    expect(parseNaturalLanguageEvent("三国杀", NOW)).toBeNull();
  });
});

// ── 重复（rrule）：输出必须能直接对上建日程接口存的 RRULE 形状 ──────────────
describe("parseNaturalLanguageEvent — 重复", () => {
  it("每周五 → FREQ=WEEKLY;BYDAY=FR，开始落在下一个周五", () => {
    const r = parseNaturalLanguageEvent("每周五 下午3点 开会", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(r?.startsAt).toBe("2026-07-10T15:00:00");
    expect(r?.summary).toBe("开会");
  });

  it("每周一 → BYDAY=MO，开始落在下一个周一", () => {
    const r = parseNaturalLanguageEvent("每周一 上午10点 例会", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(r?.startsAt).toBe("2026-07-06T10:00:00");
  });

  it("每天 → FREQ=DAILY", () => {
    const r = parseNaturalLanguageEvent("每天 下午5点 复盘", NOW);
    expect(r?.rrule).toBe("FREQ=DAILY");
    expect(r?.startsAt).toBe("2026-07-03T17:00:00");
  });

  it("每个工作日 → BYDAY=MO,TU,WE,TH,FR", () => {
    const r = parseNaturalLanguageEvent("每个工作日 下午6点 健身", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(r?.startsAt).toBe("2026-07-03T18:00:00");
  });

  it("每月15号 → FREQ=MONTHLY，开始落在下一个 15 号", () => {
    const r = parseNaturalLanguageEvent("每月15号 上午10点 交房租", NOW);
    expect(r?.rrule).toBe("FREQ=MONTHLY");
    expect(r?.startsAt).toBe("2026-07-15T10:00:00");
  });

  it("每月1号 → 本月已过，落到下个月 1 号", () => {
    const r = parseNaturalLanguageEvent("每月1号 上午10点 发工资", NOW);
    expect(r?.rrule).toBe("FREQ=MONTHLY");
    expect(r?.startsAt).toBe("2026-08-01T10:00:00");
  });

  it("每年 + 绝对日期 → FREQ=YEARLY", () => {
    const r = parseNaturalLanguageEvent("每年 10月1日 家庭聚会", NOW);
    expect(r?.rrule).toBe("FREQ=YEARLY");
    expect(r?.startsAt).toBe("2026-10-01T09:00:00");
  });

  it("每两周 + 周三 → FREQ=WEEKLY;INTERVAL=2，开始落在周三", () => {
    const r = parseNaturalLanguageEvent("每两周 周三 下午2点 汇报", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;INTERVAL=2");
    expect(r?.startsAt).toBe("2026-07-08T14:00:00");
  });

  it("every Friday → BYDAY=FR (en)", () => {
    const r = parseNaturalLanguageEvent("every Friday 3pm team sync", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(r?.startsAt).toBe("2026-07-10T15:00:00");
    expect(r?.summary).toBe("team sync");
  });

  it("every day → FREQ=DAILY (en)", () => {
    const r = parseNaturalLanguageEvent("every day 6pm run", NOW);
    expect(r?.rrule).toBe("FREQ=DAILY");
    expect(r?.startsAt).toBe("2026-07-03T18:00:00");
  });

  it("毎週金曜日 → BYDAY=FR (ja)", () => {
    const r = parseNaturalLanguageEvent("毎週金曜日 15時 会議", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(r?.startsAt).toBe("2026-07-10T15:00:00");
    expect(r?.summary).toBe("会議");
  });

  it("毎日 → FREQ=DAILY (ja)", () => {
    const r = parseNaturalLanguageEvent("毎日 18時 運動", NOW);
    expect(r?.rrule).toBe("FREQ=DAILY");
    expect(r?.startsAt).toBe("2026-07-03T18:00:00");
  });

  it("매주 금요일 → BYDAY=FR (ko)", () => {
    const r = parseNaturalLanguageEvent("매주 금요일 오후 3시 회의", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(r?.startsAt).toBe("2026-07-10T15:00:00");
    expect(r?.summary).toBe("회의");
  });

  it("매일 → FREQ=DAILY (ko)", () => {
    const r = parseNaturalLanguageEvent("매일 오후 6시 운동", NOW);
    expect(r?.rrule).toBe("FREQ=DAILY");
  });

  it("cada viernes → BYDAY=FR (es)", () => {
    const r = parseNaturalLanguageEvent("cada viernes 15:00 reunión", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(r?.startsAt).toBe("2026-07-10T15:00:00");
  });

  it("chaque vendredi → BYDAY=FR (fr)", () => {
    const r = parseNaturalLanguageEvent("chaque vendredi 15h réunion", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(r?.startsAt).toBe("2026-07-10T15:00:00");
  });

  it("jeden Freitag → BYDAY=FR (de)", () => {
    const r = parseNaturalLanguageEvent("jeden Freitag 15 Uhr Treffen", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(r?.startsAt).toBe("2026-07-10T15:00:00");
  });

  it("没有重复说法时不带 rrule 字段（老客户端读到的形状不变）", () => {
    const r = parseNaturalLanguageEvent("明天 下午3点 牙医", NOW);
    expect(r).not.toHaveProperty("rrule");
  });

  it("「每一次」不是重复说法，不许误触发", () => {
    const r = parseNaturalLanguageEvent("每一次心动 明天 晚上8点 上映", NOW);
    expect(r?.rrule).toBeUndefined();
    expect(r?.summary).toContain("每一次心动");
  });
});

// ── 全天（allDay） ──────────────────────────────────────────────────────────
describe("parseNaturalLanguageEvent — 全天", () => {
  it("明天全天 → 当天 00:00:00–23:59:59（和网页表单存的形状一致）", () => {
    const r = parseNaturalLanguageEvent("明天 全天 开会", NOW);
    expect(r?.allDay).toBe(true);
    expect(r?.startsAt).toBe("2026-07-04T00:00:00");
    expect(r?.endsAt).toBe("2026-07-04T23:59:59");
    expect(r?.summary).toBe("开会");
  });

  it("只有全天、没日期 → 今天全天（全天本身算锚点）", () => {
    const r = parseNaturalLanguageEvent("全天 培训", NOW);
    expect(r?.allDay).toBe(true);
    expect(r?.startsAt).toBe("2026-07-03T00:00:00");
  });

  it("tomorrow all day → allDay (en)", () => {
    const r = parseNaturalLanguageEvent("tomorrow all day conference", NOW);
    expect(r?.allDay).toBe(true);
    expect(r?.startsAt).toBe("2026-07-04T00:00:00");
    expect(r?.summary).toBe("conference");
  });

  it("明日 終日 → allDay (ja)", () => {
    const r = parseNaturalLanguageEvent("明日 終日 会議", NOW);
    expect(r?.allDay).toBe(true);
    expect(r?.startsAt).toBe("2026-07-04T00:00:00");
  });

  it("내일 종일 → allDay (ko)", () => {
    const r = parseNaturalLanguageEvent("내일 종일 회의", NOW);
    expect(r?.allDay).toBe(true);
    expect(r?.startsAt).toBe("2026-07-04T00:00:00");
  });

  it("没提全天时不带 allDay 字段", () => {
    const r = parseNaturalLanguageEvent("明天 下午3点 牙医", NOW);
    expect(r).not.toHaveProperty("allDay");
  });
});

// ── 地点（location）：只认明确标记，拿不准就留在标题里 ──────────────────────
describe("parseNaturalLanguageEvent — 地点", () => {
  it("在 + 地点 + 活动词 → 抽出地点，标题只剩活动", () => {
    const r = parseNaturalLanguageEvent("明天下午3点 在星巴克 开会", NOW);
    expect(r?.location).toBe("星巴克");
    expect(r?.summary).toBe("开会");
    expect(r?.startsAt).toBe("2026-07-04T15:00:00");
  });

  it("活动在前、地点在尾 → 一样抽得出", () => {
    const r = parseNaturalLanguageEvent("晚上7点 开会 在会议室", NOW);
    expect(r?.location).toBe("会议室");
    expect(r?.summary).toBe("开会");
  });

  it("去 + 地点 + 活动词", () => {
    const r = parseNaturalLanguageEvent("明天 去机场 接人", NOW);
    expect(r?.location).toBe("机场");
    expect(r?.summary).toBe("接人");
  });

  it("地点里带完整机构名（在北京大学开会）", () => {
    const r = parseNaturalLanguageEvent("明天上午10点 在北京大学 开会", NOW);
    expect(r?.location).toBe("北京大学");
    expect(r?.summary).toBe("开会");
  });

  it("meeting at Starbucks (en)", () => {
    const r = parseNaturalLanguageEvent("meeting at Starbucks tomorrow 3pm", NOW);
    expect(r?.location).toBe("Starbucks");
    expect(r?.summary).toBe("meeting");
    expect(r?.startsAt).toBe("2026-07-04T15:00:00");
  });

  it("多词大写地名 lunch at Central Park (en)", () => {
    const r = parseNaturalLanguageEvent("lunch at Central Park tomorrow 12pm", NOW);
    expect(r?.location).toBe("Central Park");
    expect(r?.summary).toBe("lunch");
  });

  it("スタバで打ち合わせ (ja)", () => {
    const r = parseNaturalLanguageEvent("明日 15時 スタバで 打ち合わせ", NOW);
    expect(r?.location).toBe("スタバ");
    expect(r?.summary).toBe("打ち合わせ");
  });

  it("스타벅스에서 회의 (ko)", () => {
    const r = parseNaturalLanguageEvent("내일 오후 3시 스타벅스에서 회의", NOW);
    expect(r?.location).toBe("스타벅스");
    expect(r?.summary).toBe("회의");
  });

  it("Treffen im Büro (de)", () => {
    const r = parseNaturalLanguageEvent("Treffen im Büro morgen 15 Uhr", NOW);
    expect(r?.location).toBe("Büro");
    expect(r?.summary).toBe("Treffen");
  });

  it("reunión en Madrid (es)", () => {
    const r = parseNaturalLanguageEvent("reunión en Madrid mañana 15:00", NOW);
    expect(r?.location).toBe("Madrid");
    expect(r?.summary).toBe("reunión");
  });

  it("重复 + 地点可以同时出现", () => {
    const r = parseNaturalLanguageEvent("每周五 下午3点 在星巴克 开会", NOW);
    expect(r?.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(r?.location).toBe("星巴克");
    expect(r?.summary).toBe("开会");
  });

  // ---- 反例：不该抽的坚决不抽，宁可让用户自己填地点 ----
  it("「在路上」是标题不是地点（在领头、无前置标题）", () => {
    const r = parseNaturalLanguageEvent("明天下午3点 在路上", NOW);
    expect(r?.location).toBeUndefined();
    expect(r?.summary).toBe("在路上");
  });

  it("「去开会」没有地点可抽（去直接接活动词）", () => {
    const r = parseNaturalLanguageEvent("下午3点 去开会", NOW);
    expect(r?.location).toBeUndefined();
    expect(r?.summary).toBe("去开会");
  });

  it("「在开会之前吃药」—— 在 + 活动词开头的是时间状语，不是地点", () => {
    const r = parseNaturalLanguageEvent("明天 在开会之前 吃药", NOW);
    expect(r?.location).toBeUndefined();
    expect(r?.summary).toContain("吃药");
  });

  it("「会议在举行」—— 举行是动词不是地点", () => {
    const r = parseNaturalLanguageEvent("明天 会议在举行", NOW);
    expect(r?.location).toBeUndefined();
  });

  it("没有地点标记就不要硬凑 (en)", () => {
    const r = parseNaturalLanguageEvent("team meeting tomorrow 3pm", NOW);
    expect(r?.location).toBeUndefined();
    expect(r?.summary).toBe("team meeting");
  });
});

// ── 歧义约定（固化，不许悄悄改） ────────────────────────────────────────────
//
// 下面这组钉的是「一半人会理解成另一个意思」的约定。它们是全端共用解析器的
// 既有语义，老用户已经按这个习惯在用了 —— 要改先过产品决定，不许顺手改。
// 例外只有「下周X」一条：已经过了产品决定，改成下个日历周语义（见下面那条
// 用例的注释），其余约定照旧不许动。
// NOW 是 2026-07-03（周五）10:00。
describe("parseNaturalLanguageEvent — 歧义约定", () => {
  it("裸星期永远是「即将到来的那个」，哪怕今天就是周五也不是今天", () => {
    expect(parseNaturalLanguageEvent("周五 9点 打球", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parseNaturalLanguageEvent("Friday 9am gym", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parseNaturalLanguageEvent("金曜日 9時 会議", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parseNaturalLanguageEvent("금요일 오후 3시 회의", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
    expect(parseNaturalLanguageEvent("viernes 15:00 reunión", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
    expect(parseNaturalLanguageEvent("vendredi 15h réunion", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
    expect(parseNaturalLanguageEvent("Freitag 15 Uhr Treffen", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
  });

  it("「下周X」= 下个日历周（周一起始）里的那个星期 X", () => {
    // 产品决定改的，就是这一条：旧约定是裸 X 再 +7 —— 周五说「下周五」，
    // 裸周五已经落在下周（+7），再 +7 就成了 +14，可多数人指的就是下周
    // 那个周五。改后按日历周定位：下周是 7/6（周一）到 7/12（周日），
    // 下周五 = 7/10（+7），下周一 = 7/6（+3，和「下周」单独出现一致，
    // 旧算法这里给的是 +10）。下下周同理顺延一周。
    // 共用同一位移机制的说法（next Friday、来週金曜日、다음 주 금요일、
    // viernes que viene、próximo viernes、vendredi prochain、
    // nächsten Freitag）一起改，语义不许各说各话。
    expect(parseNaturalLanguageEvent("下周五 9点 打球", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parseNaturalLanguageEvent("下周一 10点 复盘", NOW)?.startsAt).toBe("2026-07-06T10:00:00");
    expect(parseNaturalLanguageEvent("next Friday 9am gym", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parseNaturalLanguageEvent("来週金曜日 9時 会議", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parseNaturalLanguageEvent("다음 주 금요일 오후 3시 회의", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
    expect(parseNaturalLanguageEvent("viernes que viene 15:00 reunión", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
    expect(parseNaturalLanguageEvent("próximo viernes 15:00 reunión", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
    expect(parseNaturalLanguageEvent("vendredi prochain 15h réunion", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
    expect(parseNaturalLanguageEvent("nächsten Freitag 15 Uhr Treffen", NOW)?.startsAt).toBe("2026-07-10T15:00:00");
  });

  it("「下周五」一周七天矩阵（中文）：永远落在下个日历周的周五", () => {
    // 2026-07-05 是周日，这一周（周一起始）是 6/29–7/5，下周是 7/6–7/12；
    // 7/6 起的一周，下周是 7/13–7/19。周一到周四的结果和旧算法（裸 X +7）
    // 完全一致，差异只出在周五、周六、周日：旧算法分别给 +14、+13、+12。
    const cases: Array<[string, string]> = [
      ["2026-07-05T10:00:00", "2026-07-10T09:00:00"], // 周日 → +5（旧 +12）
      ["2026-07-06T10:00:00", "2026-07-17T09:00:00"], // 周一 → +11（同旧）
      ["2026-07-07T10:00:00", "2026-07-17T09:00:00"], // 周二 → +10（同旧）
      ["2026-07-08T10:00:00", "2026-07-17T09:00:00"], // 周三 → +9（同旧）
      ["2026-07-09T10:00:00", "2026-07-17T09:00:00"], // 周四 → +8（同旧）
      ["2026-07-10T10:00:00", "2026-07-17T09:00:00"], // 周五 → +7（旧 +14）
      ["2026-07-11T10:00:00", "2026-07-17T09:00:00"], // 周六 → +6（旧 +13）
    ];
    for (const [now, want] of cases) {
      expect(parseNaturalLanguageEvent("下周五 9点 打球", now)?.startsAt).toBe(want);
    }
  });

  it("\"next Friday\" one-week matrix (en): always the Friday of next calendar week", () => {
    const cases: Array<[string, string]> = [
      ["2026-07-05T10:00:00", "2026-07-10T09:00:00"], // Sunday
      ["2026-07-06T10:00:00", "2026-07-17T09:00:00"], // Monday
      ["2026-07-07T10:00:00", "2026-07-17T09:00:00"], // Tuesday
      ["2026-07-08T10:00:00", "2026-07-17T09:00:00"], // Wednesday
      ["2026-07-09T10:00:00", "2026-07-17T09:00:00"], // Thursday
      ["2026-07-10T10:00:00", "2026-07-17T09:00:00"], // Friday
      ["2026-07-11T10:00:00", "2026-07-17T09:00:00"], // Saturday
    ];
    for (const [now, want] of cases) {
      expect(parseNaturalLanguageEvent("next Friday 9am gym", now)?.startsAt).toBe(want);
    }
  });

  it("「下周X」其余语言抽查关键日（周末说下周五）", () => {
    // 周六 7/11 说：下周五是 7/17（+6），旧算法给 +13。
    expect(parseNaturalLanguageEvent("来週金曜日 9時 会議", "2026-07-11T10:00:00")?.startsAt).toBe("2026-07-17T09:00:00");
    expect(parseNaturalLanguageEvent("nächsten Freitag 15 Uhr Treffen", "2026-07-11T10:00:00")?.startsAt).toBe("2026-07-17T15:00:00");
    // 周日 7/5 说：下周五是 7/10（+5），旧算法给 +12。
    expect(parseNaturalLanguageEvent("다음 주 금요일 오후 3시 회의", "2026-07-05T10:00:00")?.startsAt).toBe("2026-07-10T15:00:00");
    expect(parseNaturalLanguageEvent("viernes que viene 15:00 reunión", "2026-07-05T10:00:00")?.startsAt).toBe("2026-07-10T15:00:00");
  });

  it("「本周五」在周五当天也落到下周五（裸星期约定优先于「本周」字面）", () => {
    expect(parseNaturalLanguageEvent("本周五 10点 复盘", NOW)?.startsAt).toBe("2026-07-10T10:00:00");
  });

  it("位移词 + 星期挖掉后标题不许残字（下周五的标题曾经是「五 打球」）", () => {
    expect(parseNaturalLanguageEvent("下周五 9点 打球", NOW)?.summary).toBe("打球");
    expect(parseNaturalLanguageEvent("下周一 10点 复盘", NOW)?.summary).toBe("复盘");
    expect(parseNaturalLanguageEvent("下周三 10点 复盘", NOW)?.summary).toBe("复盘");
    expect(parseNaturalLanguageEvent("下周日 10点 复盘", NOW)?.summary).toBe("复盘");
    expect(parseNaturalLanguageEvent("下下周五 10点 复盘", NOW)?.summary).toBe("复盘");
    expect(parseNaturalLanguageEvent("本周五 10点 复盘", NOW)?.summary).toBe("复盘");
  });
});

// ── 月底（新说法）：本月 / 下个月的最后一天 ─────────────────────────────────
describe("parseNaturalLanguageEvent — 月底", () => {
  it("月底 / 本月底 → 本月最后一天", () => {
    expect(parseNaturalLanguageEvent("月底 交房租", NOW)?.startsAt).toBe("2026-07-31T09:00:00");
    expect(parseNaturalLanguageEvent("本月底 总结", NOW)?.startsAt).toBe("2026-07-31T09:00:00");
    expect(parseNaturalLanguageEvent("月底 交房租", NOW)?.summary).toBe("交房租");
  });

  it("下个月底 / 下月底 → 下个月最后一天；下下个月底再顺延一个月", () => {
    expect(parseNaturalLanguageEvent("下个月底 交房租", NOW)?.startsAt).toBe("2026-08-31T09:00:00");
    expect(parseNaturalLanguageEvent("下月底 总结", NOW)?.startsAt).toBe("2026-08-31T09:00:00");
    expect(parseNaturalLanguageEvent("下下个月底 总结", NOW)?.startsAt).toBe("2026-09-30T09:00:00");
  });

  it("月末（ja）/ 월말（ko）/ end of month（en）同义", () => {
    expect(parseNaturalLanguageEvent("月末 締め切り", NOW)?.startsAt).toBe("2026-07-31T09:00:00");
    expect(parseNaturalLanguageEvent("월말 마감", NOW)?.startsAt).toBe("2026-07-31T09:00:00");
    expect(parseNaturalLanguageEvent("end of month report", NOW)?.startsAt).toBe("2026-07-31T09:00:00");
    expect(parseNaturalLanguageEvent("end of next month report", NOW)?.startsAt).toBe("2026-08-31T09:00:00");
  });

  it("边界：1 月 31 天、平年 2 月 28、闰年 2 月 29、跨年顺延", () => {
    expect(parseNaturalLanguageEvent("月底 交房租", "2026-01-30T10:00:00")?.startsAt).toBe("2026-01-31T09:00:00");
    expect(parseNaturalLanguageEvent("月底 交房租", "2026-02-10T10:00:00")?.startsAt).toBe("2026-02-28T09:00:00");
    expect(parseNaturalLanguageEvent("月底 交房租", "2028-02-10T10:00:00")?.startsAt).toBe("2028-02-29T09:00:00");
    expect(parseNaturalLanguageEvent("下个月底 交房租", "2026-12-15T10:00:00")?.startsAt).toBe("2027-01-31T09:00:00");
    expect(parseNaturalLanguageEvent("下个月底 交房租", "2026-01-31T10:00:00")?.startsAt).toBe("2026-02-28T09:00:00");
  });

  it("今天恰好是月底 → 就今天，不往下滚", () => {
    expect(parseNaturalLanguageEvent("月底 交房租", "2026-07-31T10:00:00")?.startsAt).toBe("2026-07-31T09:00:00");
  });

  it("「每月底」是重复说法，这一步不许吃掉（重复锚不住月底，整体仍是 null）", () => {
    expect(parseNaturalLanguageEvent("每月底 交房租", NOW)).toBeNull();
  });

  it("季度说法没有词表基础，暂不支持（要支持先定语义：季初 / 季末 / 具体哪天）", () => {
    expect(parseNaturalLanguageEvent("下个季度 复盘", NOW)).toBeNull();
    expect(parseNaturalLanguageEvent("季度末 总结", NOW)).toBeNull();
  });
});
