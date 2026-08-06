// The CSP ships `script-src-attr 'none'`, which means the browser refuses to
// run inline event handlers — an injected `<img onerror=alert(1)>` is inert
// even if a sanitizer upstream is bypassed. That guarantee is only worth
// anything while the templates actually stay free of them: add one
// `onclick="…"` back and it will silently do nothing in production (works
// fine locally if you happen to have CSP disabled), which is a nasty way to
// find out.
//
// So: fail here instead. Use a delegated listener in src/public/app.js —
// data-bwc-copy / -toggle / -hide / -autosubmit / -checkall / -switch, or
// data-confirm — or a <script nonce="…"> block.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "node:fs";

const VIEWS = path.resolve("src/views");

// Every event-handler content attribute the HTML spec defines that a template
// might plausibly reach for. Matching on the `on…=` shape generally would also
// hit legitimate attributes (e.g. a Tailwind class ending in "on"), so the
// list is explicit.
const HANDLERS = [
  "abort", "animationend", "animationiteration", "animationstart", "auxclick",
  "beforeinput", "blur", "cancel", "canplay", "change", "click", "close",
  "contextmenu", "copy", "cut", "dblclick", "drag", "dragend", "dragenter",
  "dragleave", "dragover", "dragstart", "drop", "durationchange", "ended",
  "error", "focus", "focusin", "focusout", "input", "invalid", "keydown",
  "keypress", "keyup", "load", "loadeddata", "loadstart", "mousedown",
  "mouseenter", "mouseleave", "mousemove", "mouseout", "mouseover", "mouseup",
  "paste", "pause", "play", "playing", "pointerdown", "pointerup", "progress",
  "ratechange", "reset", "resize", "scroll", "search", "seeked", "seeking",
  "select", "submit", "toggle", "touchend", "touchmove", "touchstart",
  "transitionend", "volumechange", "waiting", "wheel",
];

const RE = new RegExp(`\\son(${HANDLERS.join("|")})\\s*=`, "i");

function listTemplates(): string[] {
  return globSync("**/*.ejs", { cwd: VIEWS }).map((f) => path.join(VIEWS, f));
}

describe("templates carry no inline event handlers", () => {
  it("finds templates to check at all (guards against a broken glob)", () => {
    expect(listTemplates().length).toBeGreaterThan(20);
  });

  it("has zero on*= attributes, so script-src-attr 'none' stays honest", () => {
    const offenders: string[] = [];
    for (const file of listTemplates()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (RE.test(line)) {
          offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}\n    ${line.trim().slice(0, 140)}`);
        }
      });
    }
    expect(offenders, `Inline event handlers found — the CSP blocks these in production.\nUse a delegated listener in src/public/app.js instead.\n\n${offenders.join("\n")}\n`).toEqual([]);
  });
});
