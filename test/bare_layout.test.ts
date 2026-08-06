// Regression guard for the single-purpose auth pages (reset-password, MFA,
// device-challenge, verify-email). They render the global layout with
// `bareLayout: true`, which MUST strip the header nav, the ⌘K command palette,
// the search entry, and the footer — even when the browser is logged in — so a
// one-time-token / verification page offers exactly one action and no way to
// navigate elsewhere. If anyone breaks that branch, these go red.

import { describe, it, expect } from "vitest";
import ejs from "ejs";
import path from "node:path";

const VIEWS = path.resolve("src/views");
const LAYOUT = path.join(VIEWS, "layout.ejs");

function render(extra: Record<string, unknown>): Promise<string> {
  const locals = {
    t: (k: string) => k,
    title: "T",
    body: "<div id=BODYMARKER></div>",
    siteName: "Test",
    siteLogoUrl: null,
    flash: {},
    csrfToken: "c",
    // A fully logged-in user — the worst case the bare page must still lock down.
    user: { id: "u1", email: "a@b.c", isAdmin: true, displayName: "A" },
    currentUser: { id: "u1" },
    cspNonce: "n",
    jsBasePath: "/static",
    assetVersion: "1",
    icpNumber: null,
    icpUrl: "",
    appShell: false,
    currentLocale: "zh-CN",
    registrationOpen: true,
    ...extra,
  };
  return new Promise((resolve, reject) => {
    ejs.renderFile(LAYOUT, locals, { root: VIEWS, views: [VIEWS] } as ejs.Options, (err, html) =>
      err ? reject(err) : resolve(html!),
    );
  });
}

describe("bareLayout strips all chrome (single-purpose auth pages)", () => {
  it("bareLayout=true: body only — NO nav / logout / admin / search / palette / footer", async () => {
    const html = await render({ bareLayout: true });
    expect(html).toContain("BODYMARKER");
    // Nav labels are i18n keys since the full-localization pass; the stub `t`
    // above returns the key verbatim, so we assert on the keys rather than
    // the (now translated) Chinese literals.
    expect(html).not.toContain(">nav.calendar<");           // header nav link
    expect(html).not.toContain("nav.signOut");              // logout
    expect(html).not.toContain("nav.admin");                // admin link
    expect(html).not.toContain("nav.search");               // search entry
    expect(html).not.toContain('id="bwc-palette"');         // ⌘K palette modal
    expect(html).not.toContain("palette.js");               // palette script
    expect(html).not.toContain("github.com/wuha-like-sleep"); // footer
  });

  it("normal layout (logged in): nav + palette + footer all present (no over-stripping)", async () => {
    const html = await render({ bareLayout: false });
    expect(html).toContain("BODYMARKER");
    expect(html).toContain(">nav.calendar<");
    expect(html).toContain('id="bwc-palette"');
    expect(html).toContain("palette.js");
    expect(html).toContain("github.com/wuha-like-sleep");
  });
});
