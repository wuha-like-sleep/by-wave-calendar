// 事件表单里「下拉的值最后变成什么」的全部判断 —— src/public/calendar-app.js
// 文件顶上那组纯函数，加上几条接线检查。
//
// 这一块之前一条行为断言都没有，而它的错法有一个共同点：页面照常保存成功、
// 什么都不报，用户几天后在别的设备上才发现东西没了。逐条写在下面的 it() 里。
//
// 打的是纯逻辑：不需要 jsdom，不需要起服务。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// calendar-app.js 在 node 里只跑文件顶上那段纯逻辑（应用主体自己判断没有 document
// 就直接 return），import 进来是为了拿 globalThis 上这份 API。
import "../src/public/calendar-app.js";

import { en } from "../src/lib/i18n/locales/en.js";
import { zhCN } from "../src/lib/i18n/locales/zh-CN.js";
import { zhTW } from "../src/lib/i18n/locales/zh-TW.js";
import { ja } from "../src/lib/i18n/locales/ja.js";
import { ko } from "../src/lib/i18n/locales/ko.js";
import { es } from "../src/lib/i18n/locales/es.js";
import { fr } from "../src/lib/i18n/locales/fr.js";
import { de } from "../src/lib/i18n/locales/de.js";

type Opt = { value: string; label: string; group?: string; custom?: boolean };
type Alarm = { trigger: string; action?: string; description?: string };

const FORM = (globalThis as unknown as {
  bwcEventForm: {
    REMINDER_DEFAULTS: { timed: string; allday: string };
    reminderGroupOf(isAllDay: boolean): string;
    groupHas(options: Opt[], group: string, value: string): boolean;
    withCustomOption(options: Opt[], want: unknown, label: string): { options: Opt[]; value: string };
    buildReminderOptions(options: Opt[], isAllDay: boolean, keep: unknown, label: string): { options: Opt[]; value: string };
    nextReminderValue(options: Opt[], current: unknown, isAllDay: boolean): string;
    splitAlarmsForForm(alarms: unknown, isAllDay: boolean, isExisting: boolean): { first: string; rest: Alarm[] };
    collectAlarms(trigger: unknown, extraRaw: unknown, description: unknown): Alarm[] | null;
  };
}).bwcEventForm;

const APP_JS = readFileSync(path.resolve("src/public/calendar-app.js"), "utf8");
const EJS = readFileSync(path.resolve("src/views/app/calendar-app.ejs"), "utf8");

/** 模板里渲染出来的那份档位底稿（value + 分组），JS 开页时抄的就是它。 */
const REMINDER_OPTIONS: Opt[] = (() => {
  const block = /<select\s+name="reminder"[\s\S]*?<\/select>/.exec(EJS);
  if (!block) throw new Error('calendar-app.ejs 里找不到 <select name="reminder">');
  const re = /<option\s+value="([^"]*)"\s+data-group="([^"]+)"/g;
  const out: Opt[] = [];
  for (let m = re.exec(block[0]); m; m = re.exec(block[0])) {
    out.push({ value: m[1]!, label: "label:" + m[1], group: m[2]! });
  }
  return out;
})();

const CATEGORY_OPTIONS: Opt[] = (() => {
  const block = /<select\s+name="category"[\s\S]*?<\/select>/.exec(EJS);
  if (!block) throw new Error('calendar-app.ejs 里找不到 <select name="category">');
  const re = /<option\s+value="([^"]*)"/g;
  const out: Opt[] = [];
  for (let m = re.exec(block[0]); m; m = re.exec(block[0])) {
    out.push({ value: m[1]!, label: "label:" + m[1], group: "both" });
  }
  return out;
})();

const values = (o: Opt[]) => o.map((x) => x.value);

// ---------------------------------------------------------------------------
// 1. 「不提醒」必须发得出去
// ---------------------------------------------------------------------------
describe("collectAlarms — 选了「不提醒」", () => {
  it("返回的是 null，不是 undefined", () => {
    // 服务端的 extra 是浅合并：省略这个键 = 保留原值，只有 null 才是「删掉」。
    // 返回 undefined 的话 JSON.stringify 会把 alarms 这个键整个丢掉，
    // 于是用户选了「不提醒」永远关不掉，页面还照常提示保存成功。
    expect(FORM.collectAlarms("", "[]", "开会")).toBeNull();
    expect(FORM.collectAlarms(null, "", "开会")).toBeNull();
    expect(FORM.collectAlarms("   ", "[]", "开会")).toBeNull();
  });

  it("这个 null 过得了 JSON.stringify（undefined 过不了，键会消失）", () => {
    const extra = { alarms: FORM.collectAlarms("", "[]", "开会") };
    expect(JSON.parse(JSON.stringify(extra))).toEqual({ alarms: null });
    expect(Object.keys(JSON.parse(JSON.stringify(extra)))).toContain("alarms");
  });

  it("选了档位就正常拼出第一条", () => {
    expect(FORM.collectAlarms("-PT15M", "", "开会")).toEqual([
      { trigger: "-PT15M", action: "DISPLAY", description: "开会" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. 认不出的 trigger 不许静默丢
// ---------------------------------------------------------------------------
describe("buildReminderOptions — 下拉里没有的 trigger", () => {
  it("临时插一个选项并选中它（手机上设的 -PT10M 在网页存一次就没了）", () => {
    const built = FORM.buildReminderOptions(REMINDER_OPTIONS, false, "-PT10M", "自定义：-PT10M");
    expect(built.value).toBe("-PT10M");
    expect(values(built.options)).toContain("-PT10M");
    const injected = built.options.find((o) => o.value === "-PT10M")!;
    expect(injected.label).toBe("自定义：-PT10M");
    expect(injected.custom).toBe(true);
  });

  it("插的那一项排在最后，不打乱原来的档位顺序", () => {
    const built = FORM.buildReminderOptions(REMINDER_OPTIONS, false, "-PT10M", "x");
    expect(built.options[built.options.length - 1]!.value).toBe("-PT10M");
  });

  it("只留当前这一组档位：全天事件看不到定时那组", () => {
    const allday = FORM.buildReminderOptions(REMINDER_OPTIONS, true, "PT9H", "x");
    expect(values(allday.options)).toContain("PT9H");
    expect(values(allday.options)).not.toContain("-PT15M");

    const timed = FORM.buildReminderOptions(REMINDER_OPTIONS, false, "-PT15M", "x");
    expect(values(timed.options)).toContain("-PT15M");
    expect(values(timed.options)).not.toContain("PT9H");
  });

  it("「不提醒」两组都留着", () => {
    expect(values(FORM.buildReminderOptions(REMINDER_OPTIONS, true, "", "x").options)).toContain("");
    expect(values(FORM.buildReminderOptions(REMINDER_OPTIONS, false, "", "x").options)).toContain("");
  });

  it("本组已有的档位不会被插成重复项", () => {
    const built = FORM.buildReminderOptions(REMINDER_OPTIONS, false, "-PT15M", "x");
    expect(values(built.options).filter((v) => v === "-PT15M")).toHaveLength(1);
    expect(built.options.some((o) => o.custom)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. 第二条起的提醒不许被吞
// ---------------------------------------------------------------------------
describe("splitAlarmsForForm — 一个事件有多条提醒", () => {
  const three: Alarm[] = [
    { trigger: "-PT15M", action: "DISPLAY" },
    { trigger: "-PT1H", action: "DISPLAY" },
    { trigger: "-P1D", action: "EMAIL" },
  ];

  it("第一条进下拉，第二条起原样留着等 submit 拼回去", () => {
    const split = FORM.splitAlarmsForForm(three, false, true);
    expect(split.first).toBe("-PT15M");
    expect(split.rest).toEqual([
      { trigger: "-PT1H", action: "DISPLAY" },
      { trigger: "-P1D", action: "EMAIL" },
    ]);
  });

  it("寄存的那几条原样发回服务端，action 之类的字段不许被改写", () => {
    const split = FORM.splitAlarmsForForm(three, false, true);
    const out = FORM.collectAlarms(split.first, JSON.stringify(split.rest), "开会")!;
    expect(out.map((a) => a.trigger)).toEqual(["-PT15M", "-PT1H", "-P1D"]);
    expect(out[2]!.action).toBe("EMAIL");
  });

  it("只有一条时寄存区是空的", () => {
    expect(FORM.splitAlarmsForForm([{ trigger: "-PT15M" }], false, true).rest).toEqual([]);
  });

  it("空 trigger 的脏数据不占位", () => {
    const split = FORM.splitAlarmsForForm(
      [{ trigger: "  " }, { trigger: "-PT5M" }, null as unknown as Alarm],
      false,
      true,
    );
    expect(split.first).toBe("-PT5M");
    expect(split.rest).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4 & 6. 新建事件的默认档位，按是不是全天分开
// ---------------------------------------------------------------------------
describe("splitAlarmsForForm — 新建事件的默认档位", () => {
  it("全天事件默认当天 09:00（PT9H），不是「提前 15 分钟」", () => {
    // 全天提醒锚的是事件时区当天 00:00，-PT15M 落在前一天 23:45 ——
    // 用户新建一个全天事件，提醒在前一晚响。
    expect(FORM.REMINDER_DEFAULTS.allday).toBe("PT9H");
    expect(FORM.splitAlarmsForForm(null, true, false).first).toBe("PT9H");
    expect(FORM.splitAlarmsForForm([], true, false).first).toBe("PT9H");
  });

  it("定时事件默认提前 15 分钟", () => {
    expect(FORM.REMINDER_DEFAULTS.timed).toBe("-PT15M");
    expect(FORM.splitAlarmsForForm(null, false, false).first).toBe("-PT15M");
  });

  it("默认档位属于它自己那一组（两组档位的语义不通用）", () => {
    expect(FORM.groupHas(REMINDER_OPTIONS, "allday", FORM.REMINDER_DEFAULTS.allday)).toBe(true);
    expect(FORM.groupHas(REMINDER_OPTIONS, "timed", FORM.REMINDER_DEFAULTS.allday)).toBe(false);
    expect(FORM.groupHas(REMINDER_OPTIONS, "timed", FORM.REMINDER_DEFAULTS.timed)).toBe(true);
    expect(FORM.groupHas(REMINDER_OPTIONS, "allday", FORM.REMINDER_DEFAULTS.timed)).toBe(false);
  });

  it("打开一个本来就没提醒的老事件，不会凭空给它加一条", () => {
    expect(FORM.splitAlarmsForForm(null, false, true).first).toBe("");
    expect(FORM.splitAlarmsForForm([], true, true).first).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5. 勾「全天」要换档
// ---------------------------------------------------------------------------
describe("nextReminderValue — 用户自己勾/去勾「全天」", () => {
  it("定时档位换到全天：换成全天组的默认值，不是原样挂过去", () => {
    expect(FORM.nextReminderValue(REMINDER_OPTIONS, "-PT15M", true)).toBe("PT9H");
  });

  it("全天档位换回定时：同理", () => {
    expect(FORM.nextReminderValue(REMINDER_OPTIONS, "PT9H", false)).toBe("-PT15M");
  });

  it("「不提醒」两组都有，原样留着 —— 换个全天不该凭空多一条提醒", () => {
    expect(FORM.nextReminderValue(REMINDER_OPTIONS, "", true)).toBe("");
    expect(FORM.nextReminderValue(REMINDER_OPTIONS, "", false)).toBe("");
  });

  it("本来就属于目标组的不动", () => {
    expect(FORM.nextReminderValue(REMINDER_OPTIONS, "-PT15H", true)).toBe("-PT15H");
    expect(FORM.nextReminderValue(REMINDER_OPTIONS, "-P1W", false)).toBe("-P1W");
  });
});

// ---------------------------------------------------------------------------
// 分类：和提醒同一个形状的洞
// ---------------------------------------------------------------------------
describe("withCustomOption — 手机 / API 设的分类", () => {
  it("六个固定值以外的分类也要选得上（否则保存一次就没了）", () => {
    // 设不上时浏览器把 selectedIndex 置 -1，category 从 FormData 里整个消失，
    // submit 发出去的是显式 null，服务端浅合并照做把这个键删掉。
    const built = FORM.withCustomOption(CATEGORY_OPTIONS, "培训", "自定义：培训");
    expect(built.value).toBe("培训");
    expect(values(built.options)).toContain("培训");
    expect(built.options.find((o) => o.value === "培训")!.label).toBe("自定义：培训");
  });

  it("本来就有的分类不插重复项", () => {
    const built = FORM.withCustomOption(CATEGORY_OPTIONS, "work", "x");
    expect(built.value).toBe("work");
    expect(built.options).toHaveLength(CATEGORY_OPTIONS.length);
  });

  it("空值就是「无」，不会插一个空的自定义项", () => {
    const built = FORM.withCustomOption(CATEGORY_OPTIONS, "", "x");
    expect(built.value).toBe("");
    expect(built.options).toHaveLength(CATEGORY_OPTIONS.length);
    expect(built.options.some((o) => o.custom)).toBe(false);
  });

  it("null / undefined 当空值处理，不会插出一个字面量 \"null\" 的分类", () => {
    expect(FORM.withCustomOption(CATEGORY_OPTIONS, null, "x").value).toBe("");
    expect(FORM.withCustomOption(CATEGORY_OPTIONS, undefined, "x").value).toBe("");
    expect(values(FORM.withCustomOption(CATEGORY_OPTIONS, null, "x").options)).not.toContain("null");
  });

  it("选中的值一定在选项里 —— 这是「字段不会从 FormData 里消失」的全部保证", () => {
    for (const want of ["培训", "work", "", "  ", "x".repeat(60)]) {
      const built = FORM.withCustomOption(CATEGORY_OPTIONS, want, "label");
      expect(values(built.options), JSON.stringify(want)).toContain(built.value);
    }
  });
});

// ---------------------------------------------------------------------------
// 接线检查：纯逻辑再对，没接上去也是白的
// ---------------------------------------------------------------------------
describe("calendar-app.js 的表单确实走这套规则", () => {
  it("勾/去勾「全天」时会换档位", () => {
    const listener = /allDayCheckbox\.addEventListener\("change",[\s\S]*?\n  \}\);/.exec(APP_JS);
    expect(listener, "找不到 allDay 的 change 监听").toBeTruthy();
    // 参数得是复选框当前的状态，写死一个常量等于永远按定时那组算。
    expect(listener![0]).toMatch(/switchReminderGroup\(\s*allDayCheckbox\.checked\s*\)/);
  });

  it("打开事件时按它自己是不是全天来铺档位", () => {
    // 这里写死 false 的话，打开一个全天事件看到的是定时那组档位，
    // 存一次就把 PT9H 换成了 -PT15M（前一晚 23:45 响）。
    expect(APP_JS).toMatch(/setReminderFromAlarms\(\s*payload\.alarms\s*,\s*!!payload\.allDay\s*,\s*!!payload\.id\s*\)/);
  });

  it("第二条起的提醒有地方寄存，submit 时拼回去", () => {
    expect(EJS).toMatch(/<input\s+type="hidden"\s+name="extraAlarms"/);
    expect(APP_JS).toMatch(/\[name="extraAlarms"\]/);
    expect(APP_JS).toMatch(/reminderExtraInput\.value\s*=\s*rest\.length\s*>\s*0\s*\?\s*JSON\.stringify\(rest\)/);
    expect(APP_JS).toMatch(/collectAlarms\(\s*data\.reminder\s*,\s*data\.extraAlarms\s*,/);
  });

  it("寄存了几条要在界面上说一声 —— 用户看不见的东西不算保留", () => {
    expect(EJS).toMatch(/id="reminder-extra-hint"/);
    const fn = /function setReminderFromAlarms\([\s\S]*?\n  \}/.exec(APP_JS);
    expect(fn, "找不到 setReminderFromAlarms").toBeTruthy();
    expect(fn![0]).toMatch(/reminderExtraHint\.textContent\s*=/);
    expect(fn![0]).toMatch(/app\.js\.reminder\.extraKept/);
    expect(fn![0]).toMatch(/reminderExtraHint\.classList\.toggle\("hidden"/);
  });

  it("分类走的是同一条「认不出就临时插一项」的路，不是直接赋值", () => {
    expect(APP_JS).toMatch(/setCategoryValue\(payload\.category\)/);
    expect(APP_JS).not.toMatch(/catSel\.value\s*=\s*payload\.category/);
    const fn = /function setCategoryValue\([\s\S]*?\n  \}/.exec(APP_JS);
    expect(fn, "找不到 setCategoryValue").toBeTruthy();
    expect(fn![0]).toMatch(/FORM\.withCustomOption\(/);
  });

  it("服务端拒绝时界面要说原因并重画，不能让用户以为改动还在", () => {
    expect(APP_JS).toMatch(/ev\.kind === "sync-rejected"/);
    expect(APP_JS).toMatch(/app\.js\.sync\.rejected/);
    const block = /if \(ev\.kind === "sync-rejected"\)[\s\S]*?\n      \}/.exec(APP_JS);
    expect(block![0]).toMatch(/loadEvents\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 新加的用户可见文案：八种语言都得有
// ---------------------------------------------------------------------------
describe("新增文案的八语覆盖", () => {
  const LOCALES: Array<[string, Partial<Record<string, string>>]> = [
    ["en", en as Partial<Record<string, string>>],
    ["zh-CN", zhCN as Partial<Record<string, string>>],
    ["zh-TW", zhTW as Partial<Record<string, string>>],
    ["ja", ja as Partial<Record<string, string>>],
    ["ko", ko as Partial<Record<string, string>>],
    ["es", es as Partial<Record<string, string>>],
    ["fr", fr as Partial<Record<string, string>>],
    ["de", de as Partial<Record<string, string>>],
  ];
  const KEYS: Array<[string, string[]]> = [
    ["app.js.form.customValue", ["{value}"]],
    ["app.js.toast.saveFailedReason", ["{reason}"]],
    ["app.js.sync.rejected", ["{reason}"]],
  ];

  for (const [key, placeholders] of KEYS) {
    for (const [name, dict] of LOCALES) {
      it(`${key} — ${name}`, () => {
        const v = dict[key];
        expect(v, `${name} 少了 ${key}，那门语言会整句回落成英文`).toBeTruthy();
        for (const p of placeholders) {
          // 占位符写错 = 用户看到的是花括号原文，不是那个分类名 / 那句原因。
          expect(v, `${name} 的 ${key} 少了占位符 ${p}`).toContain(p);
        }
      });
    }
  }
});
