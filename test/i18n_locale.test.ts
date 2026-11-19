import { describe, it, expect } from "vitest";
import { resolveLocale, localeOptionLabel, LOCALES, SITE_LOCALE_OPTIONS } from "../src/lib/i18n.js";

describe("resolveLocale precedence", () => {
  it("?lang= wins over cookie / user / site default", () => {
    expect(resolveLocale({ queryLang: "en", cookieValue: "zh-CN", userLocale: "ja", siteDefault: "fr" })).toBe("en");
  });

  it("an invalid ?lang= is ignored and falls through to cookie", () => {
    expect(resolveLocale({ queryLang: "xx-YY", cookieValue: "ja" })).toBe("ja");
  });

  it("without ?lang=, cookie wins over user / site", () => {
    expect(resolveLocale({ cookieValue: "ko", userLocale: "es", siteDefault: "fr" })).toBe("ko");
  });

  it("user preference is used when no ?lang= / cookie", () => {
    expect(resolveLocale({ userLocale: "de", siteDefault: "fr" })).toBe("de");
  });

  it("hard-falls back to zh-CN when nothing matches", () => {
    expect(resolveLocale({})).toBe("zh-CN");
    expect(resolveLocale({ queryLang: "nope", cookieValue: "also-bad" })).toBe("zh-CN");
  });

  it("accepts every supported locale via ?lang=", () => {
    for (const code of ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de"]) {
      expect(resolveLocale({ queryLang: code })).toBe(code);
    }
  });
});

describe("localeOptionLabel — the one picker display rule", () => {
  const byCode = (code: string) => LOCALES.find((l) => l.code === code)!;

  it("always shows the native name, whatever the UI language", () => {
    // The old header rule swapped zh/ja names to English in non-CJK UIs
    // but left ko in Hangul; the unified rule never swaps.
    for (const ui of ["en", "fr", "de", "ko", "es"]) {
      expect(localeOptionLabel(byCode("zh-CN"), ui)).toBe("简体中文");
      expect(localeOptionLabel(byCode("ja"), ui)).toBe("日本語");
      expect(localeOptionLabel(byCode("ko"), ui)).toBe("한국어");
    }
    expect(localeOptionLabel(byCode("es"), "en")).toBe("Español");
    expect(localeOptionLabel(byCode("en"), "zh-CN")).toBe("English");
  });

  it("gloss appends the English name only in an English UI", () => {
    expect(localeOptionLabel(byCode("zh-CN"), "en", true)).toBe("简体中文 (Chinese (Simplified))");
    expect(localeOptionLabel(byCode("ja"), "en", true)).toBe("日本語 (Japanese)");
    expect(localeOptionLabel(byCode("zh-CN"), "fr", true)).toBe("简体中文");
    // No self-gloss for English itself.
    expect(localeOptionLabel(byCode("en"), "en", true)).toBe("English");
  });

  it("the site-default 'auto' entry follows the UI language", () => {
    const auto = SITE_LOCALE_OPTIONS.find((o) => o.code === "auto")!;
    expect(localeOptionLabel(auto, "zh-CN", true)).toBe("跟随浏览器");
    expect(localeOptionLabel(auto, "zh-TW", true)).toBe("跟随浏览器");
    expect(localeOptionLabel(auto, "en", true)).toBe("Follow browser");
    expect(localeOptionLabel(auto, "ja", true)).toBe("Follow browser");
  });

  it("the picker order is stable: zh-CN, zh-TW, en, ja, ko, es, fr, de", () => {
    expect(LOCALES.map((l) => l.code)).toEqual(["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de"]);
  });
});
