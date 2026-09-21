// 网页提醒下拉 ↔ src/lib/reminder_triggers.ts ↔ 八个 locale 的三方对齐。
//
// 为什么值得单独一个文件：下拉里的 value 不是「显示用的」，它会原样存进
// extra.alarms[].trigger，并且是提醒幂等键 (event_id, trigger, instance_start)
// 的一部分。手写的 "-PT15m"、少写的一档、写错的 i18n key，全都不会报错 ——
// 页面照常渲染、事件照常保存，只是那条提醒到点不响，或者下拉显示成 key 本身。
// 这类洞只能靠断言挡。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { TIMED_TRIGGERS, ALLDAY_TRIGGERS, type TriggerOption } from "../src/lib/reminder_triggers.js";
import { clientStrings } from "../src/lib/i18n.js";
import { en } from "../src/lib/i18n/locales/en.js";
import { zhCN } from "../src/lib/i18n/locales/zh-CN.js";
import { zhTW } from "../src/lib/i18n/locales/zh-TW.js";
import { ja } from "../src/lib/i18n/locales/ja.js";
import { ko } from "../src/lib/i18n/locales/ko.js";
import { es } from "../src/lib/i18n/locales/es.js";
import { fr } from "../src/lib/i18n/locales/fr.js";
import { de } from "../src/lib/i18n/locales/de.js";

const EJS = readFileSync(path.resolve("src/views/app/calendar-app.ejs"), "utf8");
const APP_JS = readFileSync(path.resolve("src/public/calendar-app.js"), "utf8");

type Opt = { value: string; group: string; i18nKey: string };

/** 只取 name="reminder" 那个 <select> 里的选项，别把重复规则那个下拉也扫进来。 */
function reminderOptions(): Opt[] {
  const block = /<select\s+name="reminder"[\s\S]*?<\/select>/.exec(EJS);
  if (!block) throw new Error('calendar-app.ejs 里找不到 <select name="reminder">');
  const re = /<option\s+value="([^"]*)"\s+data-group="([^"]+)"\s*>\s*<%=\s*t\("([^"]+)"\)\s*%>\s*<\/option>/g;
  const out: Opt[] = [];
  for (let m = re.exec(block[0]); m; m = re.exec(block[0])) {
    out.push({ value: m[1], group: m[2], i18nKey: m[3] });
  }
  return out;
}

/** 某一组在模板里的选项：data-group="both"（两组共用的「不提醒」）也算。 */
function optionsOfGroup(group: "timed" | "allday"): Opt[] {
  return reminderOptions().filter((o) => o.group === "both" || o.group === group);
}

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

describe("网页提醒下拉 ↔ reminder_triggers.ts 档位逐值一致", () => {
  it("模板里真的抽得到选项（正则失效时先在这里红，而不是让下面几条空对空地绿）", () => {
    expect(reminderOptions().length).toBeGreaterThan(0);
  });

  it("定时档位：value 和顺序逐值一致", () => {
    expect(optionsOfGroup("timed").map((o) => o.value)).toEqual(TIMED_TRIGGERS.map((t) => t.value));
  });

  it("全天档位：value 和顺序逐值一致", () => {
    expect(optionsOfGroup("allday").map((o) => o.value)).toEqual(ALLDAY_TRIGGERS.map((t) => t.value));
  });

  it("每个档位挂的 i18nKey 就是模块导出的那个", () => {
    expect(optionsOfGroup("timed").map((o) => o.i18nKey)).toEqual(TIMED_TRIGGERS.map((t) => t.i18nKey));
    expect(optionsOfGroup("allday").map((o) => o.i18nKey)).toEqual(ALLDAY_TRIGGERS.map((t) => t.i18nKey));
  });

  it("模板里没有第三组：data-group 只能是 both/timed/allday，且总数不多不少", () => {
    const all = reminderOptions();
    for (const o of all) expect(["both", "timed", "allday"]).toContain(o.group);
    // "" 那一档两组共用，所以总数是两组之和减一。写错 data-group（比如 "allDay"）
    // 会让那一档从两组里同时消失，上面两条却还是绿的 —— 这条专门挡它。
    expect(all.length).toBe(TIMED_TRIGGERS.length + ALLDAY_TRIGGERS.length - 1);
    expect(all.filter((o) => o.group === "both").map((o) => o.value)).toEqual([""]);
  });
});

describe("提醒文案在八个 locale 里都写全了", () => {
  const optionKeys = [...new Set([...TIMED_TRIGGERS, ...ALLDAY_TRIGGERS].map((t: TriggerOption) => t.i18nKey))];
  // 客户端另外要的两条：下拉里没有的 trigger 怎么显示、其余几条提醒的保留提示。
  const jsKeys = ["app.js.reminder.customValue", "app.js.reminder.extraKept"];
  const allKeys = [...optionKeys, ...jsKeys];

  for (const [code, dict] of LOCALES) {
    it(`${code} 一条不缺`, () => {
      const missing = allKeys.filter((k) => typeof dict[k] !== "string" || !dict[k]!.trim());
      expect(missing).toEqual([]);
    });
  }

  it("非英文 locale 没有留英文占位", () => {
    for (const [code, dict] of LOCALES) {
      if (code === "en") continue;
      for (const k of allKeys) {
        expect(`${code} ${k} = ${dict[k]}`).not.toBe(`${code} ${k} = ${en[k as keyof typeof en]}`);
      }
    }
  });

  it("客户端那两条必须在 app.js.* 命名空间里，否则浏览器根本收不到", () => {
    // 服务端只把 app.js.* 前缀的串注入 window.BWC_T（见 i18n.ts clientStrings）。
    // 放错命名空间不会报错，只会在下拉里显示成 key 本身。
    const shipped = Object.keys(clientStrings("fr"));
    for (const k of jsKeys) expect(shipped).toContain(k);
  });
});

describe("extra 的每个键都发显式 null", () => {
  // 服务端把 extra 改成浅合并之后，省略的含义从「删除」变成了「保留」。
  // 这里漏一个键，用户就再也清不掉那个字段，而且页面照常保存成功、不报错 ——
  // 正是这一期在修的那类「不报错但做错」。
  it("submit 里的 extra 字面量没有 undefined，六个键一个不少", () => {
    const m = /extra: \{([\s\S]*?)\n      \},/.exec(APP_JS);
    expect(m, "calendar-app.js 里找不到 submit 的 extra 字面量").toBeTruthy();
    const block = m![1];
    for (const key of ["category", "timezone", "attendees", "url", "meetingPassword", "alarms"]) {
      expect(block).toContain(`${key}:`);
    }
    expect(block).not.toContain("undefined");
  });
});
