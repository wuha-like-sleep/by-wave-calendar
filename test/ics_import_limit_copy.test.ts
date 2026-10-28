import { describe, it, expect } from "vitest";
import { LOCALES, translatePlain } from "../src/lib/i18n.js";
import {
  MAX_ICS_IMPORT_BYTES, MAX_ICS_IMPORT_MB, MAX_ICS_PASTE_CHARS, MAX_ICS_PASTE_BODY_BYTES,
} from "../src/lib/ics_limits.js";

// 导入日历文件的大小上限：代码里的数字、页面上的提示、报错里的数字必须是同一个。
//
// 这已经错过两轮：
//   · 一开始代码写 5MB、实际生效的是全局 2MB，页面写 5MB；
//   · 后来路由显式放到了 8MB，八门语言的页面提示和报错还写着 5MB。
// 两个数字各自看都合理，只有放在一起看才知道有一个是假的 —— 用户照着页面上的
// 「最大 5MB」去拆分文件，或者看着「>5MB」的报错去找一个 6MB 的文件哪里不对。
//
// 导入弹窗那句提示是前端直接显示的，八门语言里写的是字面量；报错文案用占位符、
// 由路由从常量填进去。两种都在这里对账。

/** 文案里所有「数字 + MB/Mo」。 */
function sizesIn(text: string): number[] {
  return [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:MB|Mo)\b/g)].map((m) => Number(m[1]!.replace(",", ".")));
}

describe(".ics 导入上限的文案和代码一致", () => {
  it("常量本身是个整 MB（presence —— 不然下面的比对没有意义）", () => {
    expect(MAX_ICS_IMPORT_MB).toBe(MAX_ICS_IMPORT_BYTES / 1048576);
    expect(Number.isInteger(MAX_ICS_IMPORT_MB) && MAX_ICS_IMPORT_MB > 0).toBe(true);
  });

  it.each(LOCALES.map((l) => l.code))("%s：导入弹窗里写的上限就是代码里的上限", (code) => {
    const text = translatePlain(code, "app.js.import.hintFile");
    const sizes = sizesIn(text);
    expect(sizes.length, `${code} 的提示里没写上限：${text}`).toBeGreaterThan(0);
    expect(
      sizes,
      `${code} 的导入提示写的上限和代码对不上（代码是 ${MAX_ICS_IMPORT_MB}MB）：${text}`,
    ).toEqual(sizes.map(() => MAX_ICS_IMPORT_MB));
  });

  it.each(LOCALES.map((l) => l.code))("%s：「文件过大」报错里的数字从代码来，不写死", (code) => {
    const raw = translatePlain(code, "flash.import.fileTooLarge");
    expect(raw, `${code} 的「文件过大」把数字写死了，改了常量它不会跟着变`).toContain("{mb}");
    expect(sizesIn(raw), `${code} 里除了占位符还写死了一个数字：${raw}`).toEqual([]);
    const shown = translatePlain(code, "flash.import.fileTooLarge", { mb: MAX_ICS_IMPORT_MB });
    expect(sizesIn(shown)).toEqual([MAX_ICS_IMPORT_MB]);
  });

  it.each(LOCALES.map((l) => l.code))("%s：「粘贴太长」报错里两个数字都从代码来", (code) => {
    const raw = translatePlain(code, "flash.import.pasteTooLong");
    expect(raw).toContain("{max}");
    expect(raw).toContain("{mb}");
    expect(sizesIn(raw), `${code} 里写死了数字：${raw}`).toEqual([]);
  });

  it("粘贴那条路的请求体上限装得下最坏情况的转义（一个汉字 = 9 字节）", () => {
    // 表单是 urlencoded 提交的。上限按 ASCII 估的话，中文多的日历在
    // MAX_ICS_PASTE_CHARS 之前就撞上请求体上限，用户收到的是英文 413。
    expect(encodeURIComponent("中").length, "判据本身错了").toBe(9);
    expect(MAX_ICS_PASTE_BODY_BYTES).toBeGreaterThanOrEqual(MAX_ICS_PASTE_CHARS * 9);
  });
});
