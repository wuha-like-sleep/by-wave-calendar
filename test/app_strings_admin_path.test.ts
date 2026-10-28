import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { zhCN } from "../src/lib/i18n/locales/zh-CN.js";
import { zhTW } from "../src/lib/i18n/locales/zh-TW.js";
import { en } from "../src/lib/i18n/locales/en.js";
import { ja } from "../src/lib/i18n/locales/ja.js";
import { ko } from "../src/lib/i18n/locales/ko.js";
import { fr } from "../src/lib/i18n/locales/fr.js";
import { es } from "../src/lib/i18n/locales/es.js";
import { de } from "../src/lib/i18n/locales/de.js";

// iOS / 安卓「管理员未启用 APP 同步」那句提示里给的后台位置，必须是后台网页上真的
// 点得到的那几个名字 —— 和服务端那句（test/apps_disabled_admin_path.test.ts）同一个判据。
//
// 以前三端都写「网页后台 → 管理 → API & APPs →『打开 APP 登录』」，后台里根本没有
// 叫这些名字的菜单和开关。App 用户把这句话转给站长，站长照着找一圈找不到，只能以为
// 是 App 坏了。改对之后又出现过同一门语言里 iOS 和安卓叫法不一样（iOS 用的是日历页
// 侧栏那个「管理控制台」链接的叫法，安卓用的是顶栏的「管理」），站长拿着两部手机的
// 截图会以为是两个地方。
//
// 真实叫法（App 里的文案按手机语言显示，后台按站点语言显示，所以同一门语言对同一门语言）：
//   顶栏入口：nav.admin（src/views/partials/nav.ejs，每一页都有，包括日历页和后台本身）
//   左侧菜单：/admin/api 那一项的 label（src/views/admin/_nav.ejs，写死的，不分语言）
//   卡片标题：adminApi.apps.heading、开关文字：adminApi.apps.toggleLabel（src/views/admin/api.ejs）

const read = (p: string) => readFileSync(path.resolve(p), "utf8");

type Locale = Partial<Record<string, string>>;
const LOCALES: Record<string, Locale> = {
  "zh-CN": zhCN, "zh-TW": zhTW, en, ja, ko, fr, es, de,
};

/** 后台网页上那几个名字，按站点语言。 */
function adminNames(lang: string) {
  const t = LOCALES[lang]!;
  const nav = read("src/views/admin/_nav.ejs");
  const api = /href:\s*'\/admin\/api',\s*label:\s*'([^']+)'/.exec(nav)?.[1];
  const names = {
    admin: t["nav.admin"],
    api,
    heading: t["adminApi.apps.heading"],
    toggle: t["adminApi.apps.toggleLabel"],
  };
  for (const [k, v] of Object.entries(names)) {
    expect(v, `${lang} 的后台叫法 ${k} 没取到 —— 判据瞎了`).toBeTruthy();
  }
  return names as Record<keyof typeof names, string>;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 各门语言包名字用的引号：「」“”„“«»‘’，外加直引号。
const OPEN = `[「“„«‘"]`;
const CLOSE = `[」”“»’"]`;
/** 一个名字作为独立的一项出现：前后不能紧贴着别的字（「管理」不能算进「システム管理」）。 */
const word = (s: string) => `(?<![\\p{L}\\p{N}])${esc(s)}(?![\\p{L}\\p{N}])`;

/**
 * 检查一句提示里写的后台位置。返回不对的地方（空数组 = 对）。
 *
 *  - 「入口 → API」这一步原样出现：入口名就是顶栏的 nav.admin，后面紧跟着 API 菜单；
 *    「API & APPs」这种后面还挂着字的不算。
 *  - 开关名原样出现。
 *  - 卡片标题原样出现。开关名里往往包着标题（「允许原生 APP 同步」包着「原生 APP 同步」），
 *    先把开关名抠掉再找，免得开关名替标题交了差。
 */
function checkPath(msg: string, n: ReturnType<typeof adminNames>): string[] {
  const bad: string[] = [];
  const step = new RegExp(
    `${word(n.admin)}(?:\\s*${CLOSE})?\\s*→\\s*(?:${OPEN}\\s*)?${esc(n.api)}(?![\\p{L}\\p{N}]|\\s*&)`,
    "u",
  );
  if (!step.test(msg)) bad.push(`没写「${n.admin} → ${n.api}」这一步（后台顶栏叫「${n.admin}」，菜单叫「${n.api}」）`);
  if (!new RegExp(word(n.toggle), "u").test(msg)) bad.push(`没写开关的真名「${n.toggle}」`);
  const withoutToggle = msg.split(n.toggle).join(" ");
  if (!new RegExp(word(n.heading), "u").test(withoutToggle)) bad.push(`没写卡片的真名「${n.heading}」`);
  if (/API\s*&\s*APPs?\b|API\s+(?:y|et|und)\s+apps?\b/i.test(msg)) bad.push("还留着旧的「API & APPs」菜单名");
  if (/打开\s*APP\s*登录|App sign-in|App-Anmeldung|Connexion de l’app|Inicio de sesión de la app|アプリのサインイン/i.test(msg)) {
    bad.push("还留着旧的「打开 APP 登录」开关名");
  }
  return bad;
}

// ---- iOS：Localizable.strings ----

/** 解析 .strings：只认 `"key" = "value";` 这一种行（本仓库就这么写），反转义 \n \" \\。 */
function parseStrings(file: string): Map<string, string> {
  const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
  const out = new Map<string, string>();
  for (const m of read(file).matchAll(/^"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)";/gm)) {
    out.set(unescape(m[1]!), unescape(m[2]!));
  }
  return out;
}

const IOS_DIR = "apps/ios/ByWaveCalendar";
const IOS_LPROJ: Record<string, string> = {
  "zh-Hans": "zh-CN", "zh-Hant": "zh-TW", en: "en", ja: "ja", ko: "ko", fr: "fr", es: "es", de: "de",
};

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.endsWith(".lproj") ? [] : swiftFiles(p);
    return e.name.endsWith(".swift") ? [p] : [];
  });
}

/**
 * iOS 每一处处理 apps_disabled 的分支（扫码、通过 Apple 登录、密码、两步验证），
 * 显示的都是哪个键 —— 查表查的是这个键。
 *
 * 认两种写法：`case "apps_disabled": return "…".loc` 和
 * `err == "apps_disabled" { // 注释… errorMessage = "…".loc`。
 * 代码里每出现一次 "apps_disabled" 都必须认得出来：以前密码和两步验证那两处
 * 显示的是一句不带后台路径的短话，和扫码、安卓不一样。
 */
function iosApps(): { where: string; key: string }[] {
  const branch =
    /"apps_disabled"\s*(?::|\{)\s*(?:\/\/[^\n]*\n\s*)*(?:return|errorMessage\s*=)\s*"((?:[^"\\]|\\.)*)"\.loc\b/g;
  const found: { where: string; key: string }[] = [];
  for (const f of swiftFiles(IOS_DIR)) {
    const src = read(f);
    const branches = [...src.matchAll(branch)];
    const mentions = src.split("\n").filter((l) => !/^\s*\/\//.test(l) && l.includes('"apps_disabled"')).length;
    expect(branches.length, `${f} 里有 ${mentions} 处 "apps_disabled"，只认出 ${branches.length} 处显示的是哪句`).toBe(mentions);
    for (const m of branches) found.push({ where: path.relative(IOS_DIR, f), key: m[1]!.replace(/\\n/g, "\n") });
  }
  expect(found.length, "iOS 里一处 apps_disabled 都没找到 —— 判据瞎了").toBeGreaterThan(0);
  return found;
}

function iosKeys(): string[] {
  return [...new Set(iosApps().map((b) => b.key))];
}

// ---- 安卓：res/values*/strings_*.xml ----

const ANDROID_RES = "apps/android/ByWaveCalendar/app/src/main/res";
const ANDROID_DIRS: Record<string, string> = {
  values: "zh-CN", "values-zh-rTW": "zh-TW", "values-en": "en", "values-ja": "ja",
  "values-ko": "ko", "values-fr": "fr", "values-es": "es", "values-de": "de",
};

function androidString(dir: string, name: string): string | undefined {
  const files = readdirSync(path.join(ANDROID_RES, dir)).filter((f) => f.endsWith(".xml"));
  for (const f of files) {
    const m = new RegExp(`<string name="${name}">([\\s\\S]*?)</string>`).exec(read(path.join(ANDROID_RES, dir, f)));
    if (m) {
      return m[1]!
        .replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"')
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    }
  }
  return undefined;
}

describe("App 里「管理员未启用 APP 同步」提示写的后台位置", () => {
  it("后台页面上真的用了这几个文案键（presence —— 不然下面比的是没人显示的字）", () => {
    const api = read("src/views/admin/api.ejs");
    expect(api).toContain('t("adminApi.apps.heading")');
    expect(api).toContain('t("adminApi.apps.toggleLabel")');
    expect(read("src/views/partials/nav.ejs")).toContain('t("nav.admin")');
  });

  it("两端都真的拿这条文案去显示 apps_disabled（presence）", () => {
    const where = iosApps().map((b) => b.where);
    for (const f of ["Auth/PairingService.swift", "Auth/AppleSignIn.swift", "Views/SetupView.swift"]) {
      expect(where, `${f} 处理 apps_disabled 的那一句没认出来 —— 判据瞎了`).toContain(f);
    }
    expect(
      iosKeys(),
      "iOS 各处 apps_disabled 显示的不是同一句：有的带后台路径、有的不带，用户换个登录方式就看不到去哪开",
    ).toHaveLength(1);
    const loginErrors = read("apps/android/ByWaveCalendar/app/src/main/kotlin/cn/bywave/calendar/ui/setup/LoginErrors.kt");
    expect(loginErrors).toMatch(/"apps_disabled"\s*->\s*R\.string\.setupvm_err_apps_disabled\b/);
  });

  it("判据自己会红：旧路径、错的入口名、只写开关不写标题，都判得出来", () => {
    const n = adminNames("zh-CN");
    const good = "管理员未启用 APP 同步功能。\n请进入网页「管理后台」→「API」→「原生 APP 同步」，勾选「允许原生 APP 同步」并点「保存」后重试。";
    expect(checkPath(good, n)).toEqual([]);
    expect(checkPath("管理员未启用 APP 同步功能。\n请进入网页后台 → 管理 → API & APPs → 「打开 APP 登录」开关后重试。", n).length).toBeGreaterThan(0);
    expect(checkPath(good.replace("「API」", "「API & APPs」"), n).length).toBeGreaterThan(0);
    expect(checkPath(good.replace("→「原生 APP 同步」", ""), n), "开关名包着标题，不能替标题交差").toHaveLength(1);
    // 日文顶栏叫「管理」，两个字太短，很容易被别的词带着蒙过去。
    const nja = adminNames("ja");
    const tail = "を開き、「ネイティブアプリ同期」の「ネイティブアプリ同期を許可」";
    expect(checkPath(`ウェブで「管理」→「API」${tail}`, nja)).toEqual([]);
    expect(checkPath(`ウェブで「管理コンソール」→「API」${tail}`, nja), "入口名后面还挂着字，不是顶栏那个「管理」").toHaveLength(1);
    expect(checkPath(`ウェブで「システム管理」→「API」${tail}`, nja), "入口名前面还挂着字，不是顶栏那个「管理」").toHaveLength(1);
  });

  for (const [lproj, lang] of Object.entries(IOS_LPROJ)) {
    it(`iOS ${lproj}：后台位置是后台网页（${lang}）上的真名`, () => {
      const table = parseStrings(path.join(IOS_DIR, `${lproj}.lproj/Localizable.strings`));
      for (const key of iosKeys()) {
        const msg = table.get(key);
        expect(msg, `${lproj}.lproj 里没有 apps_disabled 那一条 —— 这门语言会显示中文原文的旧路径`).toBeTruthy();
        expect(checkPath(msg!, adminNames(lang)), `iOS ${lproj}：${msg}`).toEqual([]);
      }
    });
  }

  for (const [dir, lang] of Object.entries(ANDROID_DIRS)) {
    it(`安卓 ${dir}：后台位置是后台网页（${lang}）上的真名`, () => {
      const msg = androidString(dir, "setupvm_err_apps_disabled");
      expect(msg, `${dir} 里没有 setupvm_err_apps_disabled`).toBeTruthy();
      expect(checkPath(msg!, adminNames(lang)), `安卓 ${dir}：${msg}`).toEqual([]);
    });
  }
});
