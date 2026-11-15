import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync("src/public/js/settings-navigation.js", "utf8");
function mount(pathname: string, hash: string) {
  const replace = vi.fn(), listeners: Record<string, () => void> = {};
  const location = { pathname, hash, replace, search: "?success=private-message" };
  runInNewContext(source, { window: { location, addEventListener: (key: string, fn: () => void) => { listeners[key] = fn; } } });
  return { replace, listeners, location };
}
describe("settings links from older desktop and mobile clients", () => {
  it.each([
    ["passkey", "/security#passkey"], ["passkeys", "/security#passkey"],
    ["mfa", "/security#mfa"], ["password", "/security#password"],
    ["sso", "/security#login-methods"], ["devices", "/devices#devices"],
    ["app-passwords", "/devices#app-passwords"], ["caldav-connect", "/devices#caldav-connect"],
    ["push", "/notifications#push"], ["theme", "/appearance#theme"], ["danger-zone", "#danger"],
  ])("routes #%s to its visible section, dropping old message parameters", (fragment, target) => {
    expect(mount("/app/settings", "#" + fragment).replace).toHaveBeenCalledExactlyOnceWith("/app/settings" + target);
  });
  it("does not loop on canonical links and handles subsequent fragment navigation", () => {
    const page = mount("/app/settings/security", "#mfa");
    expect(page.replace).not.toHaveBeenCalled();
    page.location.hash = "#theme"; page.listeners.hashchange!();
    expect(page.replace).toHaveBeenCalledWith("/app/settings/appearance#theme");
  });
  it.each(["#constructor", "#__proto__", "#https://evil.test", "#%zz", "#unknown", ""])("ignores untrusted or unknown fragment %s", hash => {
    expect(mount("/app/settings", hash).replace).not.toHaveBeenCalled();
  });
  it("does not redirect MFA enrollment or unrelated routes", () => {
    expect(mount("/app/settings/mfa/setup", "#mfa").replace).not.toHaveBeenCalled();
    expect(mount("/admin", "#theme").replace).not.toHaveBeenCalled();
  });
});
