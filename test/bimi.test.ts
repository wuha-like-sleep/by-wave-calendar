import { describe, it, expect } from "vitest";
import { normalizeBimiSvg, emailDomain, bimiDnsRecord } from "../src/lib/bimi.js";

const COMPLIANT = `<svg version="1.2" baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>X</title><rect width="32" height="32" fill="#000"/></svg>`;

describe("normalizeBimiSvg", () => {
  it("accepts an already-compliant SVG without changes", () => {
    const r = normalizeBimiSvg(COMPLIANT, { title: "ByWave" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe(false);
      expect(r.notes).toEqual([]);
    }
  });

  it("auto-injects baseProfile / version / title when missing but otherwise clean", () => {
    const bare = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#123"/></svg>`;
    const r = normalizeBimiSvg(bare, { title: "ByWave" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe(true);
      expect(r.svg).toContain('baseProfile="tiny-ps"');
      expect(r.svg).toContain('version="1.2"');
      expect(r.svg).toContain("<title>ByWave</title>");
    }
  });

  it("rejects an SVG containing <script>", () => {
    const bad = `<svg viewBox="0 0 32 32"><script>alert(1)</script><rect width="32" height="32"/></svg>`;
    const r = normalizeBimiSvg(bad, { title: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("")).toContain("script");
  });

  it("rejects embedded raster <image>", () => {
    const bad = `<svg viewBox="0 0 32 32"><image href="data:image/png;base64,AAAA"/></svg>`;
    const r = normalizeBimiSvg(bad, { title: "X" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-square viewBox", () => {
    const bad = `<svg version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 32"><title>X</title><rect width="64" height="32"/></svg>`;
    const r = normalizeBimiSvg(bad, { title: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("")).toContain("正方形");
  });

  it("rejects event-handler attributes and external xlink refs", () => {
    expect(normalizeBimiSvg(`<svg viewBox="0 0 8 8"><rect onload="x()" width="8" height="8"/></svg>`, { title: "X" }).ok).toBe(false);
    expect(normalizeBimiSvg(`<svg viewBox="0 0 8 8"><use xlink:href="#a"/></svg>`, { title: "X" }).ok).toBe(false);
  });

  it("rejects input with no <svg> root", () => {
    expect(normalizeBimiSvg("not an svg", { title: "X" }).ok).toBe(false);
  });
});

describe("emailDomain", () => {
  it("extracts the domain, lower-cased", () => {
    expect(emailDomain("noreply@e14.lz-ss.com")).toBe("e14.lz-ss.com");
    expect(emailDomain("Noreply@Example.COM")).toBe("example.com");
  });
  it("returns null for junk / missing", () => {
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain("")).toBeNull();
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain("a@b")).toBeNull();
  });
});

describe("bimiDnsRecord", () => {
  it("builds the default._bimi host + value from the sending domain", () => {
    const r = bimiDnsRecord({ fromAddress: "noreply@e14.lz-ss.com", svgUrl: "https://rl.lz-ss.com/static/bimi/logo.svg" });
    expect(r).not.toBeNull();
    expect(r!.host).toBe("default._bimi.e14.lz-ss.com");
    expect(r!.type).toBe("TXT");
    expect(r!.value).toBe("v=BIMI1; l=https://rl.lz-ss.com/static/bimi/logo.svg;");
  });

  it("appends a= when a VMC url is set", () => {
    const r = bimiDnsRecord({
      fromAddress: "noreply@e14.lz-ss.com",
      svgUrl: "https://rl.lz-ss.com/static/bimi/logo.svg",
      vmcUrl: "https://rl.lz-ss.com/static/bimi/vmc.pem",
    });
    expect(r!.value).toContain(" a=https://rl.lz-ss.com/static/bimi/vmc.pem");
  });

  it("returns null when the From address has no usable domain", () => {
    expect(bimiDnsRecord({ fromAddress: null, svgUrl: "x" })).toBeNull();
    expect(bimiDnsRecord({ fromAddress: "bogus", svgUrl: "x" })).toBeNull();
  });
});
