// 本地地址簿 v2 的纯逻辑口径（calendar-app.js 顶上的 bwcAddressBook）：
// 规范化（缩写/标点/大小写归一）、记使用（来源/首次出现/标题关键词）、
// 播种、编辑学习、卫生合并与封顶、带打分的匹配（词元任意序 / 模糊 /
// 拼音首字母 / 标题上下文）。接线层（下拉 UI、IndexedDB、保存后学习）
// 只能对源码做检查——仓库里没有 jsdom，弹窗不在 node 里跑。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import "../src/public/calendar-app.js";

type Entry = {
  address: string; normalized: string; useCount: number; lastUsedAt: number;
  firstSeenAt: number; source: string; keywords: Record<string, number>;
  street?: string; city?: string; lat?: number; lon?: number;
};
const AB = (globalThis as unknown as {
  bwcAddressBook: {
    normalizeAddress: (v: unknown) => string;
    canonicalize: (v: unknown) => string;
    editDistance: (a: string, b: string, m: number) => number;
    pinyinInitials: (t: string) => string;
    titleKeywords: (t: string) => string[];
    upsertEntry: (e: Entry[], a: string, now: number, opts?: object) => Entry[];
    seedEntries: (e: Entry[], locs: string[], now: number) => Entry[];
    similarAddress: (a: string, b: string) => boolean;
    learnFromSave: (e: Entry[], picked: string | null, saved: string, now: number, opts?: object) => Entry[];
    matchLocal: (e: Entry[], q: string, opts?: object) => string[];
    mergeSuggestions: (l: string[], o: unknown[], limit?: number) => { address: string; online: boolean; geo: unknown }[];
  };
}).bwcAddressBook;

const NOW = 1_800_000_000_000;
const mk = (address: string, useCount = 1, lastUsedAt = 0, keywords: Record<string, number> = {}): Entry => ({
  address,
  normalized: AB.canonicalize(address),
  useCount,
  lastUsedAt,
  firstSeenAt: lastUsedAt,
  source: "typed",
  keywords,
});

describe("canonicalize", () => {
  it("缩写/标点/大小写都归到同一键", () => {
    expect(AB.canonicalize("7 Kitchen Rd")).toBe(AB.canonicalize("7 Kitchen Road"));
    expect(AB.canonicalize("  MELBOURNE  Central, ")).toBe("melbourne central");
    expect(AB.canonicalize("1 Smith St.")).toBe(AB.canonicalize("1 Smith Street"));
  });
});

describe("pinyinInitials / editDistance", () => {
  it("常用汉字取首字母", () => {
    expect(AB.pinyinInitials("北京站")).toBe("bjz");
    expect(AB.pinyinInitials("上海")).toBe("sh");
  });
  it("编辑距离有界", () => {
    expect(AB.editDistance("melbourne", "melborne", 2)).toBe(1);
    expect(AB.editDistance("abc", "xyz", 1)).toBeGreaterThan(1);
  });
});

describe("titleKeywords", () => {
  it("英文词 + 汉字二元组，去停用词", () => {
    expect(AB.titleKeywords("Team lunch with Sam")).toContain("lunch");
    expect(AB.titleKeywords("Team lunch with Sam")).not.toContain("with");
    expect(AB.titleKeywords("和老王开会")).toContain("老王");
  });
});

describe("upsertEntry", () => {
  it("新条目带来源与首次出现；缩写变体并入同一条", () => {
    let entries = AB.upsertEntry([], "7 Kitchen Rd", NOW, { source: "typed", title: "BBQ night" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ address: "7 Kitchen Rd", useCount: 1, firstSeenAt: NOW, source: "typed" });
    expect(entries[0]!.keywords["bbq"]).toBe(1);
    entries = AB.upsertEntry(entries, "7 Kitchen Road", NOW + 1000, {});
    expect(entries).toHaveLength(1);
    expect(entries[0]!.useCount).toBe(2);
    expect(entries[0]!.address).toBe("7 Kitchen Road");
  });

  it("在线来源带回的组件/坐标被记下", () => {
    const entries = AB.upsertEntry([], "Melbourne Central", NOW, {
      source: "online",
      geo: { street: "La Trobe Street", city: "Melbourne", lat: -37.8, lon: 144.9 },
    });
    expect(entries[0]).toMatchObject({ source: "online", street: "La Trobe Street", city: "Melbourne", lat: -37.8, lon: 144.9 });
  });
});

describe("seedEntries", () => {
  it("只加不覆盖，source=seed", () => {
    const before = [mk("Home", 7, 999)];
    const out = AB.seedEntries(before, ["home", "Office", "Office"], NOW);
    expect(out.find((e) => e.address === "Home")!.useCount).toBe(7);
    expect(out.find((e) => e.address === "Office")).toMatchObject({ useCount: 2, source: "seed", firstSeenAt: NOW });
  });
});

describe("learnFromSave（编辑学习）", () => {
  it("选中后补全了地址再保存 → 原条目改成新写法，不裂成两条", () => {
    const before = [mk("Melbourne Central", 3, 500)];
    const out = AB.learnFromSave(before, "Melbourne Central", "Melbourne Central, La Trobe Street", NOW, {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: "Melbourne Central, La Trobe Street", useCount: 4, firstSeenAt: 500 });
  });

  it("改得面目全非 → 当新地址另记一条", () => {
    const before = [mk("Melbourne Central", 3, 500)];
    const out = AB.learnFromSave(before, "Melbourne Central", "Sydney Opera House", NOW, {});
    expect(out).toHaveLength(2);
  });

  it("没选中过建议（picked 为空）→ 正常记使用", () => {
    const out = AB.learnFromSave([], null, "Home", NOW, {});
    expect(out).toHaveLength(1);
    expect(out[0]!.useCount).toBe(1);
  });
});

describe("matchLocal（打分匹配）", () => {
  const entries = [
    mk("Melbourne Central", 1, 10),
    mk("Central Station, Sydney", 9, 20),
    mk("Melbourne Zoo", 3, 30),
    mk("北京站", 2, 40),
  ];

  it("词元任意序都能命中", () => {
    expect(AB.matchLocal(entries, "central melbourne", { now: NOW })).toContain("Melbourne Central");
  });

  it("打错一个字母（模糊）也能命中", () => {
    expect(AB.matchLocal(entries, "melborne central", { now: NOW })).toContain("Melbourne Central");
  });

  it("拼音首字母命中中文地址", () => {
    expect(AB.matchLocal(entries, "bjz", { now: NOW })).toEqual(["北京站"]);
  });

  it("标题上下文能把常配的地址顶上来", () => {
    const pair = [
      mk("Office Park", 2, 10, { dentist: 4 }),
      mk("Office Park North", 2, 10),
    ];
    // 无上下文时两者同分、按最近（相同）保持原序附近；带 dentist 上下文时第一条胜出
    const withCtx = AB.matchLocal(pair, "office park", { now: NOW, title: "Dentist appointment" });
    expect(withCtx[0]).toBe("Office Park");
  });

  it("完全不匹配返回空", () => {
    expect(AB.matchLocal(entries, "perth airport", { now: NOW })).toEqual([]);
  });
});

describe("mergeSuggestions", () => {
  it("本地在前，在线按规范键去重，在线对象带 geo", () => {
    const out = AB.mergeSuggestions(["7 Kitchen Rd"], [{ label: "7 Kitchen Road" }, { label: "Other St", lat: 1 }], 8);
    expect(out).toEqual([
      { address: "7 Kitchen Rd", online: false, geo: null },
      { address: "Other St", online: true, geo: { label: "Other St", lat: 1 } },
    ]);
  });
});

describe("卫生：封顶", () => {
  it("超过 300 条按价值淘汰到 300", () => {
    let entries: Entry[] = [];
    for (let i = 0; i < 305; i++) entries.push(mk(`Place ${i}`, 1, i));
    const out = AB.upsertEntry(entries, "New Place", NOW, {});
    expect(out.length).toBeLessThanOrEqual(300);
  });
});

describe("接线（源码检查）", () => {
  const src = readFileSync(path.join(process.cwd(), "src/public/calendar-app.js"), "utf8");
  const ejs = readFileSync(path.join(process.cwd(), "src/views/app/calendar-app.ejs"), "utf8");

  it("模板里有联想下拉容器，地点输入关掉了浏览器自带自动完成", () => {
    expect(ejs).toContain('id="location-suggest"');
    expect(ejs).toMatch(/name="location"[\s\S]{0,200}?autocomplete="off"/);
  });

  it("存储走 IndexedDB，旧 localStorage 只做一次性迁移", () => {
    expect(src).toContain('indexedDB.open("bwc-address-book"');
    expect(src).toContain("ADDR_LEGACY_KEY");
  });

  it("保存后走编辑学习（含一句话直存），且学习入口只有一个", () => {
    expect(src).toContain("learnLocationOnSave(data)");
    expect(src).toContain("learnLocationOnSave({ location: parsed.location, summary: parsed.summary })");
    expect(src).not.toContain("recordLocationUse(");
  });

  it("在线兜底只在本地不足 3 条时查；选中在线结果带组件入库", () => {
    expect(src).toContain("local.length >= 3");
    expect(src).toContain("/api/geo/suggest");
    expect(src).toContain('source: "online"');
  });

  it("匹配带上事件标题做上下文", () => {
    expect(src).toContain('title: summaryInput ? summaryInput.value : ""');
  });
});
