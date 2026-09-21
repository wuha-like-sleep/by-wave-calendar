import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// routes/events.ts 一路拉到 db/client → env，而 env 解析不过是 process.exit(1) ——
// 整个 vitest 进程直接没了，连一条红色报错都留不下。CI 上没有 .env，所以先把三个必填项
// 兜上再动态 import；dotenv 不覆盖已经存在的 process.env，本地有 .env 也不受影响。
// （postgres() 只是建连接池对象，不会在 import 时真去连库。）
process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://bwc:bwc@127.0.0.1:5432/bwc_test";
process.env.SESSION_SECRET ||= "test-session-secret-at-least-32-chars-long";

const { mergeEventExtra, extraSchema } = await import("../src/routes/events.js");

describe("mergeEventExtra —— extra 的浅合并（C1）", () => {
  it("只传 alarms 时，category / attendees / timezone 全部保留", () => {
    // 这一条就是这期要修的那个 bug 的形状：手机端的模型里没有 alarms 以外的字段，
    // 以前整块替换，网页上设的分类和参与者当场消失，两端都返回 200。
    const current = {
      category: "工作",
      attendees: ["a@example.com"],
      timezone: "Asia/Shanghai",
      alarms: [{ trigger: "-PT15M" }],
    };
    expect(mergeEventExtra(current, { alarms: [{ trigger: "-PT1H" }] })).toEqual({
      category: "工作",
      attendees: ["a@example.com"],
      timezone: "Asia/Shanghai",
      alarms: [{ trigger: "-PT1H" }],
    });
  });

  it("反过来也一样：只传 category 不会把 alarms 抹掉", () => {
    const current = { category: "工作", alarms: [{ trigger: "-PT15M" }] };
    expect(mergeEventExtra(current, { category: "私人" })).toEqual({
      category: "私人",
      alarms: [{ trigger: "-PT15M" }],
    });
  });

  it("显式 null 删掉那个键，其余原样保留", () => {
    const current = { category: "工作", timezone: "Asia/Shanghai", alarms: [{ trigger: "-PT15M" }] };
    expect(mergeEventExtra(current, { category: null })).toEqual({
      timezone: "Asia/Shanghai",
      alarms: [{ trigger: "-PT15M" }],
    });
  });

  it("「省略即删除」不再成立：不传 category 就是保留 category", () => {
    // 网页那一路以前靠「不传」来清空，改成浅合并之后必须显式传 null。
    // 这条断言是那次口径变更的锚点：谁把 undefined 又当成删除，它就红。
    const current = { category: "工作", url: "https://example.com/m/1" };
    expect(mergeEventExtra(current, { url: "https://example.com/m/2" })).toEqual({
      category: "工作",
      url: "https://example.com/m/2",
    });
  });

  it("受影响的五个键都能用 null 删掉", () => {
    const current = {
      category: "工作",
      timezone: "Asia/Shanghai",
      url: "https://example.com/m/1",
      meetingPassword: "123456",
      attendees: ["a@example.com"],
      alarms: [{ trigger: "-PT15M" }],
    };
    const patch = {
      category: null, timezone: null, url: null, meetingPassword: null, attendees: null,
    };
    expect(mergeEventExtra(current, patch)).toEqual({ alarms: [{ trigger: "-PT15M" }] });
  });

  it("传空对象 {} 什么都不变", () => {
    const current = { category: "工作", alarms: [{ trigger: "-PT15M" }] };
    expect(mergeEventExtra(current, {})).toEqual(current);
  });

  it("不传 extra（undefined）什么都不变", () => {
    const current = { category: "工作" };
    expect(mergeEventExtra(current, undefined)).toEqual({ category: "工作" });
  });

  it("body.extra 整个是 null = 清空整块 extra", () => {
    // 定下来的语义：null 是「把这块整个删掉」，返回 null 落进 JSONB 列。
    // 注意它和 undefined 不是一回事 —— undefined 是「这次没提」。
    expect(mergeEventExtra({ category: "工作", alarms: [{ trigger: "-PT15M" }] }, null)).toBeNull();
  });

  it("最后一个键被删光时落 null，而不是留一个空对象", () => {
    expect(mergeEventExtra({ category: "工作" }, { category: null })).toBeNull();
  });

  it("库里本来就没有 extra 时，patch 直接成为新的 extra", () => {
    expect(mergeEventExtra(null, { alarms: [{ trigger: "-PT15M" }] })).toEqual({
      alarms: [{ trigger: "-PT15M" }],
    });
    expect(mergeEventExtra(null, {})).toBeNull();
    expect(mergeEventExtra(undefined, undefined)).toBeNull();
  });

  it("嵌套的数组是整体替换，不是逐项合并", () => {
    // attendees 逐项合并的话，「删掉一个参与者」和「没提参与者」是同一个请求体，
    // 人就永远删不掉了。数组一律整体替换。
    const current = { attendees: ["a@example.com", "b@example.com"] };
    expect(mergeEventExtra(current, { attendees: ["c@example.com"] })).toEqual({
      attendees: ["c@example.com"],
    });
    // 空数组是合法的「清空到零个」，和 null 删键的区别是键还在。
    expect(mergeEventExtra(current, { attendees: [] })).toEqual({ attendees: [] });
  });

  it("嵌套对象同样整体替换：alarms 数组不做并集", () => {
    const current = { alarms: [{ trigger: "-PT15M" }, { trigger: "-PT1H" }] };
    expect(mergeEventExtra(current, { alarms: [{ trigger: "-P1D" }] })).toEqual({
      alarms: [{ trigger: "-P1D" }],
    });
  });

  it("不修改传进来的 current 对象", () => {
    // 三个调用点都是先 loadOwnedEvent 再写回，就地改会让同一次请求里后面读到的
    // target.extra 已经变了样。
    const current = { category: "工作", alarms: [{ trigger: "-PT15M" }] };
    mergeEventExtra(current, { category: null, timezone: "Asia/Shanghai" });
    expect(current).toEqual({ category: "工作", alarms: [{ trigger: "-PT15M" }] });
  });

  it("形状不对的 patch 不改动库里的 extra", () => {
    const current = { category: "工作" };
    expect(mergeEventExtra(current, ["nope"])).toEqual({ category: "工作" });
    expect(mergeEventExtra(current, "nope")).toEqual({ category: "工作" });
  });
});

describe("extraSchema —— trigger 校验与去重（C6 / C7）", () => {
  it("解析不了的 trigger 整个请求判错，错误里指得出是哪一条", () => {
    const r = extraSchema.safeParse({ alarms: [{ trigger: "-PT15M" }, { trigger: "banana" }] });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues[0]!;
    expect(issue.path.join(".")).toBe("alarms.1.trigger");
    expect(issue.message).toContain("banana");
  });

  it("以前能一路 200 存进去的几种写法现在都被拦下", () => {
    // 存进去、返回 200、到点永远不响 —— 没有任何一端会报错，只有用户发现没提醒。
    for (const bad of ["banana", "PT15", "P1Y", "PT1.5H", "P", "RELATED=MIDDLE:-PT15M", "15"]) {
      expect(extraSchema.safeParse({ alarms: [{ trigger: bad }] }).success).toBe(false);
    }
  });

  it("合法写法照单全收：周 / 秒 / 零 / 正数 / 组合 / 大小写 / 绝对时刻 / RELATED=END", () => {
    for (const good of [
      "-PT15M", "-P1W", "-PT30S", "PT0S", "-PT0M", "PT9H", "-P1DT15H", "-p6dt15h",
      "RELATED=END:-PT15M", "VALUE=DATE-TIME:20260101T090000Z",
    ]) {
      const r = extraSchema.safeParse({ alarms: [{ trigger: good }] });
      expect(r.success, `${good} 应该是合法的`).toBe(true);
    }
  });

  it("空串（「不提醒」那一档）不判错，但也不会存成一条提醒", () => {
    const r = extraSchema.safeParse({ alarms: [{ trigger: "" }] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data?.alarms).toEqual([]);
  });

  it("同一时刻的两条提醒去重，留下的那条保持原文", () => {
    // -PT15M 和 RELATED=START:-PT15M 是同一刻；两条都留会在同一分钟响两次，
    // 而幂等键里的 trigger 是原文，撞不上键、挡不住。
    const r = extraSchema.parse({
      alarms: [{ trigger: "-PT15M" }, { trigger: "RELATED=START:-PT15M" }, { trigger: "-PT1H" }],
    });
    expect(r?.alarms?.map((a) => a.trigger)).toEqual(["-PT15M", "-PT1H"]);
  });

  it("超过 8 条截到 8 条，而不是判 400", () => {
    const many = ["-PT0M", "-PT5M", "-PT15M", "-PT30M", "-PT1H", "-PT2H", "-P1D", "-P1W", "-PT45M", "-PT90M"]
      .map((trigger) => ({ trigger }));
    const r = extraSchema.parse({ alarms: many });
    expect(r?.alarms).toHaveLength(8);
    expect(r?.alarms?.[7]?.trigger).toBe("-P1W");
  });

  it("每个键都收显式 null（浅合并靠它做删除）", () => {
    const r = extraSchema.safeParse({
      category: null, timezone: null, url: null, meetingPassword: null, attendees: null, alarms: null,
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({
      category: null, timezone: null, url: null, meetingPassword: null, attendees: null, alarms: null,
    });
  });
});

describe("请求体校验失败必须是 400，不是 500（C6）", () => {
  // 这一层只能从源码上钉：真要从 HTTP 打进去，requireUserOrSend 先要一个 DB 会话，
  // 而纯逻辑套件里没有库。钉的是那个会悄悄变成 500 的写法本身。
  // 实测（fastify 5 + 本仓库的 setErrorHandler）：handler 里 throw 出来的 ZodError
  // 身上没有 statusCode → 500「服务器内部错误」，客户端看不出是自己发错了；
  // safeParse + reply.code(400) → 400。
  // 先把整行注释剥掉再匹配：注释里提到 `createSchema.parse()` 是在解释「以前那样会 500」，
  // 不剥就会被自己这条断言判红（第一次跑就红在这上面）。
  const code = readFileSync(new URL("../src/routes/events.ts", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");

  it("POST / PATCH 都不用会冒成 500 的 schema.parse(req.body)", () => {
    expect(code).not.toMatch(/(createSchema|updateSchema)\.parse\(/);
    expect(code.match(/(createSchema|updateSchema)\.safeParse\(/g)).toHaveLength(2);
  });

  it("两处校验失败都回 400", () => {
    expect(code.match(/reply\.code\(400\)\.send\(\{ error: "invalid_body"/g)).toHaveLength(2);
  });
});
