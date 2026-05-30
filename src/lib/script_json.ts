// Safe JSON-for-<script> serializer.
//
// `<%- JSON.stringify(x) %>` inside an inline <script> is a classic XSS
// sink: if any string value contains the substring "</script" the browser
// closes the <script> element early and the trailing markup the attacker
// supplied is parsed as HTML. Our CSP allows inline event handlers
// (script-src-attr 'unsafe-inline'), so `</script><img src=x onerror=...>`
// runs. User-controlled fields -- event summary/description/location,
// calendar name/description -- flow into these blocks (embed widget,
// calendar app bootstrap), so this is a real stored-XSS vector.
//
// Escaping the four HTML-significant chars below, plus the two Unicode
// line/paragraph separators (code points 0x2028 / 0x2029, which terminate
// JavaScript string literals when emitted raw), neutralizes the breakout.
// The result is still valid JSON: the page's JSON.parse (or a direct
// `const X = <%- ... %>` assignment) reads back the identical value because
// the escaped forms are standard JSON unicode escapes.
//
// Use this anywhere a template does `<%- jsonForScript(x) %>` in place of
// the unsafe `<%- JSON.stringify(x) %>`.

// The separator regex is built from a string so this source file never
// contains a raw 0x2028 / 0x2029 char (which would itself terminate a line
// in JS/TS source and break parsing).
const SEPARATORS = new RegExp("[\\u2028\\u2029]", "g");

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(SEPARATORS, (ch) => "\\u202" + (ch.charCodeAt(0) === 0x2028 ? "8" : "9"));
}
