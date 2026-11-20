// 本地地址簿的纯逻辑口径（calendar-app.js 顶上的 bwcAddressBook）：
// 归一化、记使用（计数 + 最近时间 + 封顶淘汰）、播种只加不覆盖、
// 本地匹配排序、本地/在线合并去重。接线层（下拉 UI、localStorage、
// 保存后记一次）只能对源码做检查——仓库里没有 jsdom，弹窗不在 node 里跑。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import "../src/public/calendar-app.js";

type Entry = { address: string; useCount: number; lastUsedAt: number };
const AB = (globalThis as unknown as {
  bwcAddressBook: {
    normalizeAddress: (v: unknown) => string;
    upsertEntry: (e: Entry[], a: string, now: number) => Entry[];
    seedEntries: (e: Entry[], locs: string[]) => Entry[];
    matchLocal: (e: Entry[], q: string, limit?: number) => string[];
    mergeSuggestions: (l: string[], o: string[], limit?: number) => { address: string; online: boolean }[];
  };
}).bwcAddressBook;

describe("normalizeAddress", () => {
  it("去首尾空白、内部连续空白压成一个", () => {
    expect(AB.normalizeAddress("  7  Kitchen   Rd ")).toBe("7 Kitchen Rd");
    expect(AB.normalizeAddress(null)).toBe("");
    expect(AB.normalizeAddress("")).toBe("");
  });
});

describe("upsertEntry", () => {
  it("新地址新增，计数 1", () => {
    expect(AB.upsertEntry([], "A St", 100)).toEqual([{ address: "A St", useCount: 1, lastUsedAt: 100 }]);
  });

  it("已存在（大小写/空白不同也算同一个）→ 计数 +1 并采用新写法", () => {
    const before = [{ address: "a  st", useCount: 2, lastUsedAt: 50 }];
    expect(AB.upsertEntry(before, "A St", 200)).toEqual([{ address: "A St", useCount: 3, lastUsedAt: 200 }]);
  });

  it("空地址不记", () => {
    expect(AB.upsertEntry([], "   ", 1)).toEqual([]);
  });
});

describe("seedEntries", () => {
  it("只加不覆盖：已有条目的计数原样保留", () => {
    const before = [{ address: "Home", useCount: 7, lastUsedAt: 999 }];
    const out = AB.seedEntries(before, ["home", "Office", "Office"]);
    expect(out).toContainEqual({ address: "Home", useCount: 7, lastUsedAt: 999 });
    expect(out).toContainEqual({ address: "Office", useCount: 2, lastUsedAt: 0 });
  });

  it("空地址与重复地址不进簿", () => {
    expect(AB.seedEntries([], ["", "  ", "X", "x"])).toEqual([{ address: "X", useCount: 2, lastUsedAt: 0 }]);
  });
});

describe("matchLocal", () => {
  const entries: Entry[] = [
    { address: "Melbourne Central", useCount: 1, lastUsedAt: 10 },
    { address: "Central Station, Sydney", useCount: 9, lastUsedAt: 20 },
    { address: "Melbourne Zoo", useCount: 3, lastUsedAt: 30 },
  ];

  it("子串匹配，开头命中优先于高频的中间命中", () => {
    expect(AB.matchLocal(entries, "central")).toEqual(["Central Station, Sydney", "Melbourne Central"]);
  });

  it("同为开头命中时，用得多的在前", () => {
    expect(AB.matchLocal(entries, "melbourne")).toEqual(["Melbourne Zoo", "Melbourne Central"]);
  });

  it("空查询返回最常用的几条", () => {
    expect(AB.matchLocal(entries, "", 2)).toEqual(["Central Station, Sydney", "Melbourne Zoo"]);
  });

  it("不匹配返回空", () => {
    expect(AB.matchLocal(entries, "perth")).toEqual([]);
  });
});

describe("mergeSuggestions", () => {
  it("本地在前，在线去重，总数封顶", () => {
    const out = AB.mergeSuggestions(["A St", "B St"], ["a st", "C St", "D St"], 3);
    expect(out).toEqual([
      { address: "A St", online: false },
      { address: "B St", online: false },
      { address: "C St", online: true },
    ]);
  });
});

describe("接线（源码检查）", () => {
  const src = readFileSync(path.join(process.cwd(), "src/public/calendar-app.js"), "utf8");
  const ejs = readFileSync(path.join(process.cwd(), "src/views/app/calendar-app.ejs"), "utf8");

  it("模板里有联想下拉容器，地点输入关掉了浏览器自带自动完成", () => {
    expect(ejs).toContain('id="location-suggest"');
    expect(ejs).toMatch(/name="location"[\s\S]{0,200}?autocomplete="off"/);
  });

  it("保存在所有成功分支后记一次地点使用（含一句话直存）", () => {
    expect(src.match(/recordLocationUse\(/g)?.length).toBeGreaterThanOrEqual(5); // 定义 1 + 调用 ≥4
    expect(src).toContain("recordLocationUse(parsed.location)");
  });

  it("在线兜底只在本地不足 3 条时查，且带防抖与开关", () => {
    expect(src).toContain("local.length >= 3");
    expect(src).toContain("/api/geo/suggest");
    expect(src).toContain("onlineSuggestEnabled()");
  });

  it("播种走每历全量事件接口且只跑一次（标记位）", () => {
    expect(src).toContain("/api/calendars/");
    expect(src).toContain("bwc.addressBook.seeded.v1");
  });
});
