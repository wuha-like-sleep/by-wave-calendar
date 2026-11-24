// Old desktop/mobile clients link to fragments on the account page.
// A fragment never reaches the server, so route it before the hidden section renders.
(function () {
  "use strict";
  var sections = {
    profile: "", language: "", danger: "",
    passkey: "/security", mfa: "/security", password: "/security", "login-methods": "/security",
    devices: "/devices", "app-passwords": "/devices", "caldav-connect": "/devices", oauth: "/devices",
    push: "/notifications", theme: "/appearance"
  };
  var aliases = { passkeys: "passkey", sso: "login-methods", "danger-zone": "danger" };
  function route() {
    if (!/^\/app\/settings(?:\/(?:security|devices|notifications|appearance))?\/?$/.test(window.location.pathname)) return;
    var fragment;
    try { fragment = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    if (Object.prototype.hasOwnProperty.call(aliases, fragment)) fragment = aliases[fragment];
    if (!Object.prototype.hasOwnProperty.call(sections, fragment)) return;
    var path = "/app/settings" + sections[fragment];
    if (window.location.pathname !== path || window.location.hash !== "#" + fragment) {
      window.location.replace(path + "#" + fragment);
    }
  }
  route();
  window.addEventListener("hashchange", route);
  window.addEventListener("pageshow", route);
})();
