// Server-side i18n. EJS templates and route handlers call `t(req, key)`
// or rely on the auto-injected `t()` view local. The translation
// dictionaries below are flat string maps; missing keys fall back to
// the English value, then to the key itself (so an untranslated
// surface degrades to a readable, machine-greppable label rather than
// breaking the page).
//
// Resolution order per request, highest priority first:
//
//   1. Cookie `bwc_locale` — explicit override the user set via the
//      language switcher on /login or /app/settings. Wins over the
//      logged-in user's saved locale because it represents the user's
//      "right now" intent (e.g. they're on a public computer or
//      borrowing someone else's account temporarily).
//   2. user.locale       — logged-in user's saved preference
//   3. site default      — site_settings.default_locale (admin choice)
//                           If site default is "auto", treat as fallthrough.
//   4. Accept-Language   — best-effort sniff from the request header
//   5. "zh-CN"           — hard fallback
//
// Adding a language:
//   - Add a new entry to LOCALES with { code, label, labelEn }
//   - Add a new dictionary block to DICTIONARIES keyed by the code
//   - Update src/db/schema.ts SUPPORTED_LOCALES comment if needed
//   - Translate as much of `zhCN` below as you can (English fallback
//     covers the rest)

import type { FastifyRequest } from "fastify";

/** Supported locale tags. Order here = order shown in the picker. */
export const LOCALES = [
  { code: "zh-CN", label: "简体中文", labelEn: "Chinese (Simplified)" },
  { code: "en", label: "English", labelEn: "English" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

/** "auto" is special — only valid as the site default. Means "detect
 *  from browser Accept-Language at request time." */
export const SITE_LOCALE_OPTIONS = [
  { code: "auto", label: "跟随浏览器", labelEn: "Follow browser" },
  ...LOCALES,
] as const;

/** Validate that a string is one of the supported locale codes. Used
 *  before persisting to DB or setting the bwc_locale cookie. */
export function isValidLocale(s: unknown): s is LocaleCode {
  return typeof s === "string" && LOCALES.some((l) => l.code === s);
}

export function isValidSiteLocale(s: unknown): s is "auto" | LocaleCode {
  return typeof s === "string" && (s === "auto" || isValidLocale(s));
}

/**
 * Translation dictionaries. The English dict (`en`) is the source of
 * truth — keys MUST exist there; other locales are allowed to omit
 * keys and fall back to English.
 *
 * Namespace conventions:
 *   common.*    — buttons, generic words used everywhere
 *   nav.*       — top-nav + footer
 *   login.*     — /login page
 *   register.*  — /register page
 *   settings.*  — /app/settings page
 *   admin.*     — /admin/* pages
 *   error.*     — error views
 */
const en: Record<string, string> = {
  // common
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.confirm": "Confirm",
  "common.back": "Back",
  "common.continue": "Continue",
  "common.required": "required",

  // nav
  "nav.calendar": "Calendar",
  "nav.search": "Search",
  "nav.settings": "Settings",
  "nav.admin": "Admin",
  "nav.signOut": "Sign out",
  "nav.signIn": "Sign in",
  "nav.register": "Sign up",
  "footer.tagline": "Self-hosted calendar sharing platform",
  "footer.openSource": "Open source",

  // login
  "login.title": "Sign in",
  "login.subtitle.withQr": "Sign in with password / Passkey, or scan from phone APP",
  "login.subtitle.noQr": "Sign in with password or Passkey",
  "login.tabPassword": "Password",
  "login.tabQr": "Scan QR",
  "login.passkeyButton": "Sign in with Passkey",
  "login.passkeyWaiting": "Waiting for Passkey…",
  "login.email": "Email",
  "login.password": "Password",
  "login.forgotPassword": "Forgot password?",
  "login.submit": "Sign in",
  "login.rememberMe": "Stay signed in (30 days)",
  "login.rememberMeHint": "· otherwise sign out when browser closes",
  "login.noAccount": "No account yet?",
  "login.qrLoading": "Generating QR code…",
  "login.qrInstructions": "Open the <strong>ByWave Calendar</strong> mobile APP, tap <em>Settings → Scan to sign in on web</em>, and scan the code above.",
  "login.qrWaiting": "Waiting for phone to approve…",
  "login.qrApproved": "✓ Approved — redirecting…",
  "login.qrExpired": "QR code expired",
  "login.qrDenied": "Authorization denied",
  "login.qrError": "Failed to generate QR code — please refresh",
  "login.qrFallback": "Phone APP needs to sign in once with password / Passkey first · then scanning works",
  "login.qrRefresh": "Generate a new QR code",
  "login.qrAdminDisabled": "Admin has disabled web scan-to-sign-in. Please use password.",

  // settings - language section
  "settings.languageTitle": "Language",
  "settings.languageDesc": "Choose the language for the web UI. This is per-account and overrides the site default.",
  "settings.languageFollowSite": "Follow site default",
  "settings.languageSaveSuccess": "Language updated",

  // admin - site language
  "admin.siteLanguageTitle": "Site language",
  "admin.siteLanguageDesc": "Default UI language for visitors and users who haven't set their own preference.",
  "admin.siteLanguageSaveSuccess": "Site language updated",

  // error
  "error.title": "Something went wrong",
  "error.notFoundTitle": "Page not found",
  "error.notFoundMessage": "What you're looking for doesn't exist or has been removed.",
  "error.internal": "Internal server error",
  "error.backHome": "Back to home",
};

const zhCN: Record<string, string> = {
  "common.save": "保存",
  "common.cancel": "取消",
  "common.delete": "删除",
  "common.confirm": "确认",
  "common.back": "返回",
  "common.continue": "继续",
  "common.required": "必填",

  "nav.calendar": "日历",
  "nav.search": "搜索",
  "nav.settings": "设置",
  "nav.admin": "管理后台",
  "nav.signOut": "退出登录",
  "nav.signIn": "登录",
  "nav.register": "注册",
  "footer.tagline": "自托管的日历共享平台",
  "footer.openSource": "开源项目",

  "login.title": "登录",
  "login.subtitle.withQr": "用密码 / Passkey 登录，或用手机 APP 扫码授权",
  "login.subtitle.noQr": "用密码或 Passkey 登录",
  "login.tabPassword": "密码登录",
  "login.tabQr": "扫码登录",
  "login.passkeyButton": "使用 Passkey 登录",
  "login.passkeyWaiting": "等待 Passkey…",
  "login.email": "邮箱",
  "login.password": "密码",
  "login.forgotPassword": "忘记密码？",
  "login.submit": "登录",
  "login.rememberMe": "保持登录（30 天）",
  "login.rememberMeHint": "· 不勾选则关闭浏览器即退出",
  "login.noAccount": "还没账号？",
  "login.qrLoading": "正在生成二维码…",
  "login.qrInstructions": "打开 <strong>ByWave Calendar</strong> 手机 APP，<br>点「设置 → 扫码登录网页版」，扫上面二维码。",
  "login.qrWaiting": "等待手机扫码授权…",
  "login.qrApproved": "✓ 已批准 —— 正在跳转…",
  "login.qrExpired": "二维码已过期",
  "login.qrDenied": "已拒绝授权",
  "login.qrError": "二维码生成失败 —— 请刷新页面重试",
  "login.qrFallback": "手机 APP 需要先用密码 / Passkey 登录一次 · 之后扫码即可",
  "login.qrRefresh": "重新生成二维码",
  "login.qrAdminDisabled": "管理员已停用网页扫码登录，请用密码登录",

  "settings.languageTitle": "语言",
  "settings.languageDesc": "选择网页 UI 语言。仅当前账号生效，覆盖网站默认语言。",
  "settings.languageFollowSite": "跟随网站默认",
  "settings.languageSaveSuccess": "语言已更新",

  "admin.siteLanguageTitle": "网站语言",
  "admin.siteLanguageDesc": "未登录访客 + 没设置过自己语言的用户看到的默认语言。",
  "admin.siteLanguageSaveSuccess": "网站语言已更新",

  "error.title": "出错了",
  "error.notFoundTitle": "页面未找到",
  "error.notFoundMessage": "你访问的内容不存在或已被移除。",
  "error.internal": "服务器内部错误",
  "error.backHome": "回到首页",
};

const DICTIONARIES: Record<LocaleCode, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
};

/** Translate a single key under a given locale, with a graceful
 *  fallback chain. Optional `vars` substitutes `{name}` placeholders. */
export function translate(locale: LocaleCode, key: string, vars?: Record<string, string | number>): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES.en;
  let value = dict[key] ?? DICTIONARIES.en[key] ?? key;
  if (vars) {
    for (const [name, v] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(v));
    }
  }
  return value;
}

/** Cookie name for explicit user override. Lifetime: 1 year. Cleared
 *  when user selects 「跟随网站默认」 in the picker. */
export const LOCALE_COOKIE = "bwc_locale";
export const LOCALE_COOKIE_TTL_S = 365 * 24 * 60 * 60;

/** Parse the most-preferred supported locale from an Accept-Language
 *  header. Returns null when nothing matches — caller falls back. */
function pickFromAcceptLanguage(header: string | undefined): LocaleCode | null {
  if (!header) return null;
  // Accept-Language: "zh-CN,zh;q=0.9,en;q=0.8" → ranked list.
  const entries = header.split(",").map((s) => {
    const [tag, qPart] = s.trim().split(";");
    const q = qPart?.trim().startsWith("q=") ? parseFloat(qPart.trim().slice(2)) : 1;
    return { tag: tag?.toLowerCase() ?? "", q: isNaN(q) ? 0 : q };
  }).sort((a, b) => b.q - a.q);
  for (const e of entries) {
    if (!e.tag) continue;
    // Exact match (zh-cn → zh-CN)
    for (const l of LOCALES) {
      if (e.tag === l.code.toLowerCase()) return l.code;
    }
    // Language-only prefix (zh → zh-CN)
    const primary = e.tag.split("-")[0];
    for (const l of LOCALES) {
      if (l.code.toLowerCase().startsWith(primary + "-") || l.code.toLowerCase() === primary) {
        return l.code;
      }
    }
  }
  return null;
}

/** Resolve the effective locale for a request. Pass `siteDefault` and
 *  `userLocale` from the closest call site so this stays a pure
 *  function (testable, no DB I/O). */
export function resolveLocale(opts: {
  cookieValue?: string;
  userLocale?: string | null;
  siteDefault?: string;
  acceptLanguage?: string;
}): LocaleCode {
  // 1) explicit cookie
  if (isValidLocale(opts.cookieValue)) return opts.cookieValue;
  // 2) user preference
  if (isValidLocale(opts.userLocale)) return opts.userLocale;
  // 3) site default — "auto" means fall through to browser detection
  if (opts.siteDefault && opts.siteDefault !== "auto" && isValidLocale(opts.siteDefault)) {
    return opts.siteDefault;
  }
  // 4) Accept-Language
  const fromHeader = pickFromAcceptLanguage(opts.acceptLanguage);
  if (fromHeader) return fromHeader;
  // 5) hard fallback
  return "zh-CN";
}

/**
 * Convenience for route handlers / hooks: pulls cookie + Accept-Language
 * from the request, callers pass userLocale + siteDefault.
 */
export function resolveLocaleFromRequest(
  req: FastifyRequest,
  userLocale: string | null | undefined,
  siteDefault: string | undefined,
): LocaleCode {
  return resolveLocale({
    cookieValue: req.cookies[LOCALE_COOKIE],
    userLocale,
    siteDefault,
    acceptLanguage: req.headers["accept-language"] as string | undefined,
  });
}

/** Make a `t(key, vars?)` closure bound to a locale. Stashed on
 *  req.locals / view locals so EJS templates can call `t("login.email")`. */
export function makeT(locale: LocaleCode): (key: string, vars?: Record<string, string | number>) => string {
  return (key, vars) => translate(locale, key, vars);
}
