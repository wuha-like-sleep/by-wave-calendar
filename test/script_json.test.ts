import { describe, it, expect } from "vitest";
import { jsonForScript } from "../src/lib/script_json.js";

describe("jsonForScript — XSS-safe JSON for inline <script>", () => {
  it("escapes a </script> breakout in a string value", () => {
    const out = jsonForScript({ summary: "</script><img src=x onerror=alert(1)>" });
    // No literal "</script" or "<" survives — the browser can't close the tag.
    expect(out).not.toContain("</script");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    // The escaped form is present instead.
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u003e");
  });

  it("round-trips back to the original value via JSON.parse", () => {
    const value = {
      a: "</script>",
      b: "a & b < c > d",
      c: ["x", { nested: "</SCRIPT >" }],
    };
    const serialized = jsonForScript(value);
    expect(JSON.parse(serialized)).toEqual(value);
  });

  it("escapes ampersands", () => {
    const out = jsonForScript({ s: "Tom & Jerry" });
    expect(out).toContain("\\u0026");
    expect(out).not.toContain(" & ");
  });

  it("escapes U+2028 / U+2029 line separators (illegal raw in JS strings)", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const out = jsonForScript({ s: `before${ls}mid${ps}after` });
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(out).not.toContain(ls);
    expect(out).not.toContain(ps);
    // Still parses back correctly.
    expect(JSON.parse(out).s).toBe(`before${ls}mid${ps}after`);
  });

  it("leaves benign content readable after parse", () => {
    const out = jsonForScript({ name: "工作日历", color: "#6366f1" });
    expect(JSON.parse(out)).toEqual({ name: "工作日历", color: "#6366f1" });
  });
});
