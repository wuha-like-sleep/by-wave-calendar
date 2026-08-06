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

// Per-locale dictionaries. `en` is the source of truth; `TranslationKey`
// is derived from it. See the DICTIONARIES block below for how to add a
// language. `npm run i18n:check` reports per-locale coverage.
import { en, type TranslationKey } from "./i18n/locales/en.js";
import { zhCN } from "./i18n/locales/zh-CN.js";
import { zhTW } from "./i18n/locales/zh-TW.js";
import { ja } from "./i18n/locales/ja.js";
import { ko } from "./i18n/locales/ko.js";
import { es } from "./i18n/locales/es.js";
import { fr } from "./i18n/locales/fr.js";
import { de } from "./i18n/locales/de.js";

export type { TranslationKey };

/** Supported locale tags. Order here = order shown in the picker. */
export const LOCALES = [
  { code: "zh-CN", label: "简体中文", labelEn: "Chinese (Simplified)" },
  { code: "zh-TW", label: "繁體中文", labelEn: "Chinese (Traditional)" },
  { code: "en", label: "English", labelEn: "English" },
  { code: "ja", label: "日本語", labelEn: "Japanese" },
  { code: "ko", label: "한국어", labelEn: "Korean" },
  { code: "es", label: "Español", labelEn: "Spanish" },
  { code: "fr", label: "Français", labelEn: "French" },
  { code: "de", label: "Deutsch", labelEn: "German" },
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
 * Translation dictionaries live in per-locale files under ./i18n/locales/.
 * `en` is the SOURCE OF TRUTH (every key must exist there); other locales
 * are `Partial<Record<TranslationKey, string>>` so they translate
 * incrementally and missing keys fall back to English. Typos / stale keys
 * fail to compile; `npm run i18n:check` reports coverage.
 *
 * ── Adding a new language (e.g. Japanese "ja") ──────────────────────────
 *   1. Add `{ code: "ja", label: "日本語", labelEn: "Japanese" }` to LOCALES above.
 *   2. Create src/lib/i18n/locales/ja.ts:
 *        import type { TranslationKey } from "./en.js";
 *        export const ja: Partial<Record<TranslationKey, string>> = { … };
 *      (copy zh-CN.ts as a skeleton, or start empty and fill in.)
 *   3. Import it at the top of this file and add it to DICTIONARIES below.
 *   4. Run `npm run i18n:check` to see what's still untranslated — unfilled
 *      keys fall back to English, so you can ship partial.
 *
 * Namespace conventions:
 *   common.* · nav.* · footer.*           — shared chrome
 *   login.* · register.* · resetPassword.* — auth pages
 *   settings.* · adminSite.* · adminApi.* · adminUsers.* · adminBackup.* · adminUpdate.* — settings + admin
 *   calendar.*                            — main /app/calendars/:id view
 *   booking.* · inviteAccept.* · embed.* · search.* · layout.* — public + app surfaces
 *   error.*                               — error views
 */
const DICTIONARIES: Record<LocaleCode, Partial<Record<TranslationKey, string>>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
  es,
  fr,
  de,
};

/** Translate a single key under a given locale, with a graceful fallback
 *  chain: requested locale → English → the key string itself. Optional
 *  `vars` substitutes `{name}` placeholders.
 *
 *  `key` is typed as a plain `string` (not `TranslationKey`) on purpose:
 *  callers include EJS templates and JS bundles that pass dynamically-built
 *  keys we can't statically verify. Unknown keys degrade to the readable,
 *  greppable key text rather than throwing. The compile-time safety lives
 *  on the dict definitions (each locale is `Partial<Record<TranslationKey,
 *  string>>`), so a typo in a *dictionary* is caught even though a typo in
 *  a *call site* is not. */
export function translate(locale: LocaleCode, key: string, vars?: Record<string, string | number>): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES.en;
  const k = key as TranslationKey;
  let value = dict[k] ?? DICTIONARIES.en[k] ?? key;
  if (vars) {
    for (const [name, v] of Object.entries(vars)) {
      // XSS hardening: t() output is emitted RAW (`<%- t(...) %>`) in every
      // EJS template, because the dictionary strings themselves legitimately
      // contain trusted markup (e.g. "With <strong>{host}</strong>" and
      // "<a href=...>Sign in as {email}</a>"). The *interpolated* values,
      // however, are frequently user-controlled — a host display name, a
      // subscription's upstream error preview, an invitee email — so they
      // MUST be HTML-escaped before substitution. Escaping only the values
      // (not the template) kills stored/reflected XSS via the public booking
      // page, attendee lists, subscription-status banners, etc., while
      // preserving the intended markup of the trusted template text.
      value = value.replaceAll(`{${name}}`, escapeHtml(String(v)));
    }
  }
  return value;
}

/** Minimal HTML-entity escape for the 5 significant chars. Used to make
 *  user-controlled interpolation values safe inside the raw-rendered
 *  translation templates. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Per-locale translation coverage, for `scripts/i18n-coverage.ts`. The
 *  English dict is the source of truth (always 100%); every other locale
 *  reports how many of those keys it actually translates and which are
 *  still missing (those fall back to English at runtime). This is the tool
 *  a translator runs when adding / topping up a language. */
export function i18nCoverage(): Array<{
  locale: LocaleCode;
  label: string;
  total: number;
  translated: number;
  missing: string[];
}> {
  const allKeys = Object.keys(en) as TranslationKey[];
  return LOCALES.map((l) => {
    const dict = DICTIONARIES[l.code] ?? {};
    const missing = allKeys.filter((k) => dict[k] === undefined);
    return {
      locale: l.code,
      label: l.label,
      total: allKeys.length,
      translated: allKeys.length - missing.length,
      missing,
    };
  });
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
  queryLang?: string;
  cookieValue?: string;
  userLocale?: string | null;
  siteDefault?: string;
  acceptLanguage?: string;
}): LocaleCode {
  // 0) explicit ?lang= query — highest precedence. Lets the native apps open
  //    any in-app web page in the app's current language by appending ?lang=xx,
  //    overriding a stale webview cookie. Transient (does NOT set the cookie).
  if (isValidLocale(opts.queryLang)) return opts.queryLang;
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
  const q = (req.query as Record<string, unknown> | undefined)?.lang;
  return resolveLocale({
    queryLang: typeof q === "string" ? q : undefined,
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

/** Resolve every key under a prefix into a flat { key: translated } map.
 *  Used to hand a locale's strings to CLIENT-SIDE code that can't call
 *  the server-side t() — e.g. /app injects `window.BWC_T` with all
 *  `app.js.*` strings so calendar-app.js can localize toasts, modals,
 *  and dynamically-built markup. `{name}`-style placeholders are left
 *  intact; the client substitutes them at call time. */
export function clientStrings(locale: LocaleCode, prefix = "app.js."): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(en) as TranslationKey[]) {
    if (key.startsWith(prefix)) out[key] = translate(locale, key);
  }
  return out;
}
