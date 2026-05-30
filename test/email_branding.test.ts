import { describe, it, expect } from "vitest";
import {
  normalizeHexColor,
  renderPreviewHtml,
  EMAIL_PREVIEW_TEMPLATES,
} from "../src/lib/email_templates.js";

const NOW = new Date("2026-05-31T12:00:00Z");

describe("normalizeHexColor", () => {
  it("accepts #rrggbb and lowercases", () => {
    expect(normalizeHexColor("#AABBCC")).toBe("#aabbcc");
  });
  it("accepts rrggbb without leading #", () => {
    expect(normalizeHexColor("aabbcc")).toBe("#aabbcc");
  });
  it("expands #rgb shorthand", () => {
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
  });
  it("rejects junk / wrong length / empty / null", () => {
    expect(normalizeHexColor("nope")).toBeNull();
    expect(normalizeHexColor("#12")).toBeNull();
    expect(normalizeHexColor("#1234")).toBeNull();
    expect(normalizeHexColor("")).toBeNull();
    expect(normalizeHexColor(null)).toBeNull();
    expect(normalizeHexColor(undefined)).toBeNull();
  });
});

describe("renderPreviewHtml — draft branding override", () => {
  it("injects the override brand color into the rendered email", () => {
    const html = renderPreviewHtml("verification", "x@example.com", NOW, { brandColor: "#ff0000" });
    expect(html).toContain("#ff0000");
  });

  it("restores module state after an override (no leakage to the next render)", () => {
    renderPreviewHtml("verification", "x@example.com", NOW, { brandColor: "#ff0000" });
    const dflt = renderPreviewHtml("verification", "x@example.com", NOW, {});
    expect(dflt).not.toContain("#ff0000");
    expect(dflt).toContain("#4f46e5"); // back to the indigo default
  });

  it("applies a footer-note override", () => {
    const html = renderPreviewHtml("welcome", "x@example.com", NOW, { footerNote: "测试页脚XYZ" });
    expect(html).toContain("测试页脚XYZ");
  });

  it("returns null for an unknown template key", () => {
    expect(renderPreviewHtml("does-not-exist", "x@example.com", NOW, {})).toBeNull();
  });

  it("every registered preview template renders to non-empty HTML", () => {
    for (const t of EMAIL_PREVIEW_TEMPLATES) {
      const html = renderPreviewHtml(t.key, "you@example.com", NOW, {});
      expect(html, t.key).toBeTruthy();
      expect(html!.length, t.key).toBeGreaterThan(200);
      expect(html!, t.key).toContain("<!doctype html>");
    }
  });
});
