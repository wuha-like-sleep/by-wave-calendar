import { describe, it, expect } from "vitest";
import { resolveLocale } from "../src/lib/i18n.js";

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
