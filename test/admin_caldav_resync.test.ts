// 后台「让所有设备重新同步日历」这一块里,不需要数据库就能验的三件事:
// 纪元那一列怎么被翻译成人话、两张模板长没长出该有的东西、八门语言有没有齐。
//
// 真正的行为(鉴权 / 纪元真的变了 / CSRF)在
// test/integration/admin_caldav_resync.int.test.ts 里从 HTTP 打进去。
// 这一档只管「不报错就是不响」里那些看得见的部分。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ejs from "ejs";
import { describeCaldavEpoch } from "../src/web/admin.js";
import { en } from "../src/lib/i18n/locales/en.js";
import { zhCN } from "../src/lib/i18n/locales/zh-CN.js";
import { zhTW } from "../src/lib/i18n/locales/zh-TW.js";
import { ja } from "../src/lib/i18n/locales/ja.js";
import { ko } from "../src/lib/i18n/locales/ko.js";
import { es } from "../src/lib/i18n/locales/es.js";
import { fr } from "../src/lib/i18n/locales/fr.js";
import { de } from "../src/lib/i18n/locales/de.js";

const VIEWS = path.resolve("src/views");

// ---------------------------------------------------------------------------
// 纪元那一列 → 人话
// ---------------------------------------------------------------------------

describe("describeCaldavEpoch", () => {
  it("空串 = 从来没有触发过", () => {
    const v = describeCaldavEpoch("");
    expect(v.kind).toBe("none");
    expect(v.atIso).toBeNull();
  });

  it("认得后台按钮写的那种,并把时间拆出来", () => {
    const v = describeCaldavEpoch("manual:2026-09-21T10:11:12.000Z:a1b2c3d4e5f6");
    expect(v.kind).toBe("manual");
    // ISO 串自己带冒号 —— 按 ":" 切的话这里会是 "2026-09-21T10"。
    expect(v.atIso).toBe("2026-09-21T10:11:12.000Z");
  });

  it("迁移写的版本字面量算「随版本更新」,不冒充手动", () => {
    const v = describeCaldavEpoch("2026-09-21-alarm-vevent");
    expect(v.kind).toBe("release");
    expect(v.atIso).toBeNull();
  });

  it("时间坏掉也照样认得出是手动的 —— 来源和时间是两件事", () => {
    const v = describeCaldavEpoch("manual:not-a-date:ffff");
    expect(v.kind).toBe("manual");
    expect(v.atIso).toBeNull();
  });

  it("原样取值一个字都不改 —— 页面上摆出来的就是库里那一个", () => {
    for (const raw of ["", "manual:2026-09-21T10:11:12.000Z:abc123", "2026-09-21-alarm-vevent"]) {
      expect(describeCaldavEpoch(raw).raw).toBe(raw);
    }
  });
});

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

// t() 直接回 key:断言的是「模板挑了哪个分支、摆了哪些字段」,跟具体译文无关。
const tStub = (key: string) => key;

function render(view: string, data: Record<string, unknown>): string {
  return ejs.render(
    readFileSync(path.join(VIEWS, view), "utf8"),
    { t: tStub, csrfToken: "csrf-token-here", flash: {}, ...data },
    { filename: path.join(VIEWS, view), views: [VIEWS], async: false },
  ) as string;
}

const adminUser = { id: "me", email: "admin@example.com", isAdmin: true };

describe("admin/caldav.ejs", () => {
  it("摆出当前标记和来源 —— 按完回到这一页,这里是唯一能看出「真的变了」的地方", () => {
    const html = render("admin/caldav.ejs", {
      user: adminUser,
      activeNav: "/admin/caldav",
      epoch: describeCaldavEpoch("manual:2026-09-21T10:11:12.000Z:a1b2c3d4e5f6"),
    });
    expect(html).toContain("manual:2026-09-21T10:11:12.000Z:a1b2c3d4e5f6");
    expect(html).toContain("adminCaldav.state.manual");
    expect(html).toContain('datetime="2026-09-21T10:11:12.000Z"');
  });

  it("没有时间可显示时,那一行留一个横杠而不是整行消失", () => {
    const html = render("admin/caldav.ejs", {
      user: adminUser,
      activeNav: "/admin/caldav",
      epoch: describeCaldavEpoch(""),
    });
    // presence:三个字段名都还在(行没消失)。
    expect(html).toContain("adminCaldav.state.sourceLabel");
    expect(html).toContain("adminCaldav.state.timeLabel");
    expect(html).toContain("adminCaldav.state.markerLabel");
    expect(html).toContain("adminCaldav.state.never");
    // 横杠必须落在「时间」和「当前标记」这两个字段名之间 —— 只写
    // toContain("—") 是抓不住的:标记那一行自己也会渲染一个横杠,
    // 时间那一行整个消失时它照样绿。
    expect(
      html,
      "「时间」这一行没了 —— 页面看上去像本来就没有这一项",
    ).toMatch(/adminCaldav\.state\.timeLabel[\s\S]*?—[\s\S]*?adminCaldav\.state\.markerLabel/);
  });

  it("按钮指向确认页,而不是直接提交 —— 一点就执行是这个功能最不该有的样子", () => {
    const html = render("admin/caldav.ejs", {
      user: adminUser,
      activeNav: "/admin/caldav",
      epoch: describeCaldavEpoch(""),
    });
    expect(html).toContain('href="/admin/caldav/resync"');
    // absence 的配套 presence 在上一行:确实有那个 href,才谈得上「它不是个表单」。
    expect(html).not.toMatch(/<form[^>]*action="\/admin\/caldav\/resync"/);
  });
});

describe("admin/caldav-resync-confirm.ejs", () => {
  const html = () => render("admin/caldav-resync-confirm.ejs", {
    user: adminUser,
    activeNav: "/admin/caldav",
  });

  it("确认页上四条代价说明一条都不少", () => {
    const out = html();
    for (const key of [
      "adminCaldav.confirm.willHappen",
      "adminCaldav.confirm.wontHappen",
      "adminCaldav.confirm.cost",
      "adminCaldav.confirm.notInstant",
      "adminCaldav.confirm.multiProcess",
    ]) {
      expect(out, `确认页少了「${key}」这一条`).toContain(key);
    }
  });

  it("真正执行的那个表单带 CSRF 令牌和确认字段", () => {
    const out = html();
    expect(out).toMatch(/<form[^>]*method="post"[^>]*action="\/admin\/caldav\/resync"/);
    expect(out).toContain('name="_csrf" value="csrf-token-here"');
    expect(out).toContain('name="confirm" value="yes"');
  });

  it("留了一条退路 —— 走到确认页不等于必须执行", () => {
    expect(html()).toContain('href="/admin/caldav"');
  });
});

describe("后台导航", () => {
  it("这一页能从侧边栏点到 —— 否则路由存在也等于不存在", () => {
    const nav = readFileSync(path.join(VIEWS, "admin/_nav.ejs"), "utf8");
    expect(nav).toContain("/admin/caldav");
    expect(nav).toContain("adminCaldav.navLabel");
  });
});

// ---------------------------------------------------------------------------
// 八门语言
// ---------------------------------------------------------------------------
//
// i18n:check 盯的是全局覆盖率,少一个键它也会红。这里再单独盯这一批,是因为
// 全局那道门是「总数对不对」,读不出来「新加的这一批里漏了哪个」。

describe("adminCaldav.* 的八门语言", () => {
  const DICTS: Array<[string, Partial<Record<string, string>>]> = [
    ["zh-CN", zhCN], ["zh-TW", zhTW], ["ja", ja], ["ko", ko],
    ["es", es], ["fr", fr], ["de", de],
  ];
  const keys = Object.keys(en).filter((k) => k.startsWith("adminCaldav."));

  it("英文源里这一批键确实存在 —— 不然下面那些循环一圈都不跑,永远是绿的", () => {
    expect(keys.length).toBeGreaterThanOrEqual(20);
  });

  for (const [code, dict] of DICTS) {
    it(`${code} 一个键都不少,且没有空值`, () => {
      const missing = keys.filter((k) => typeof dict[k] !== "string");
      expect(missing, `${code} 缺这些键:${missing.join(", ")}`).toEqual([]);
      const blank = keys.filter((k) => (dict[k] ?? "").trim() === "");
      // 「键在、值是空白」在页面上是真的渲染成空的,不会回落成英文。
      expect(blank, `${code} 这些键的值是空白:${blank.join(", ")}`).toEqual([]);
    });
  }

  it("英文自己也不许有空值", () => {
    const blank = keys.filter((k) => (en as Record<string, string>)[k]!.trim() === "");
    expect(blank).toEqual([]);
  });
});
