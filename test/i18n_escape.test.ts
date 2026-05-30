import { describe, it, expect } from "vitest";
import { translate } from "../src/lib/i18n.js";

// t() output is rendered RAW (`<%- t(...) %>`) because the dictionary
// strings themselves contain trusted markup (e.g. "<strong>{host}</strong>").
// The *interpolated values* are frequently user-controlled, so they must be
// HTML-escaped. These tests pin that behavior so a future refactor can't
// silently reintroduce the XSS.

describe("translate() — HTML-escapes interpolated variable values", () => {
  it("escapes a script-injection payload in {host} on the public booking page", () => {
    // "booking.public.withHost" = "With <strong>{host}</strong> · {minutes} min"
    const out = translate("en", "booking.public.withHost", {
      host: '<img src=x onerror=alert(document.cookie)>',
      minutes: 30,
    });
    // The trusted template markup survives...
    expect(out).toContain("<strong>");
    expect(out).toContain("</strong>");
    // ...but the user-controlled value is neutralized.
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("onerror=alert(document.cookie)".replace(/"/g, "&quot;"));
  });

  it("escapes < > & \" ' in interpolated values", () => {
    const out = translate("en", "inviteAccept.invitedAs", { email: `a"<b>&'c` });
    // "inviteAccept.invitedAs" = "Invited as <strong>{email}</strong>"
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("&amp;");
    expect(out).toContain("&quot;");
    expect(out).toContain("&#39;");
    expect(out).not.toContain("<b>");
  });

  it("leaves benign values intact and readable", () => {
    const out = translate("en", "booking.public.withHost", { host: "Alice Smith", minutes: 45 });
    expect(out).toContain("Alice Smith");
    expect(out).toContain("45");
  });

  it("does not double-escape the trusted template's own markup", () => {
    // The <strong>/<a> in the template must NOT be entity-encoded.
    const out = translate("en", "inviteAccept.loginPrompt", { email: "x@y.z" });
    expect(out).toContain('<a href="/login"');
    expect(out).not.toContain("&lt;a href");
  });
});
