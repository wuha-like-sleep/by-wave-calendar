// auth-guard.js — when the web session/credential expires, send the user
// back to /login instead of letting API calls silently fail in place.
//
// Server-rendered page navigations already bounce to /login (loadAuthedUser
// → bounceToLogin). The gap this closes is the SPA side: the calendar app
// and friends call the API via fetch(); on an expired session those return
// 401 and the UI previously just toasted "失败" and left you stuck on a dead
// page. Now:
//
//   1. Reactive — ANY same-origin /api/* response with 401 → redirect to
//      /login. This fires on the next button/action you take, and on the
//      calendar's 30s background poll (so an expired session self-bounces
//      within ~30s even if you touch nothing).
//   2. Proactive — when the tab regains focus/visibility, ping the cheap
//      authed endpoint /api/v1/auth/me; its 401 (if any) flows through the
//      same wrapper → redirect. So returning to a long-idle tab bounces you
//      to login right away.
//
// Excluded: auth ACTION endpoints (/auth/login, /auth/register,
// /auth/login-mfa-verify, …) — a 401 there is a wrong password / failed
// MFA, NOT an expired session, so we must not redirect. /auth/me is the one
// /auth/* path we DO act on (it's our liveness probe).
//
// Loaded first among layout.ejs's deferred scripts so window.fetch is
// wrapped before calendar-app.js (and everything else) makes a request.
(function () {
  "use strict";

  // Only arm on the authenticated areas (/app, /admin). On /login, the
  // public booking pages (/book), SSO/OAuth screens, etc. a 401 is expected
  // and redirecting to /login would be wrong (or loop). Keeps the guard
  // inert everywhere a logged-out visitor is legitimately allowed.
  if (!/^\/(app|admin)(\/|$)/.test(window.location.pathname)) return;

  var redirecting = false;

  function toLogin() {
    if (redirecting) return;            // one bounce per page; navigation unloads us
    redirecting = true;
    // replace() so the dead page doesn't linger in history (Back would
    // otherwise land the user right back on the expired view).
    try { window.location.replace("/login"); }
    catch (e) { window.location.href = "/login"; }
  }

  function shouldGuard(rawUrl) {
    try {
      var u = new URL(rawUrl, window.location.origin);
      if (u.origin !== window.location.origin) return false;   // third-party
      if (!/^\/api(\/|$)/.test(u.pathname)) return false;      // only our API surface
      // Auth-action endpoints: 401 = bad credentials, not expired session.
      // /auth/me is the exception — it's our session-liveness probe.
      if (/^\/api\/(v1\/)?auth\//.test(u.pathname) && !/\/auth\/me$/.test(u.pathname)) {
        return false;
      }
      return true;
    } catch (e) { return false; }
  }

  // 1 — wrap fetch (covers calendar-app.js, event-store.js outbox, etc).
  if (window.fetch) {
    var orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      return orig(input, init).then(function (resp) {
        try {
          if (resp && resp.status === 401) {
            var url = (typeof input === "string") ? input : (input && input.url) || "";
            if (shouldGuard(url)) toLogin();
          }
        } catch (e) { /* never let the guard break the response */ }
        return resp;
      });
    };
  }

  // htmx requests use XMLHttpRequest, not fetch — catch their 401 separately.
  document.addEventListener("htmx:responseError", function (e) {
    try {
      var xhr = e && e.detail && e.detail.xhr;
      if (xhr && xhr.status === 401) {
        var path = (e.detail.pathInfo && e.detail.pathInfo.requestPath) || "";
        if (!path || shouldGuard(path)) toLogin();
      }
    } catch (e2) {}
  });

  // 2 — re-check auth when the tab comes back to the foreground (debounced).
  var lastPing = 0;
  function recheck() {
    var now = Date.now();
    if (redirecting || now - lastPing < 10000) return;
    lastPing = now;
    // A 401 here flows through the fetch wrapper above and triggers toLogin().
    try { window.fetch("/api/v1/auth/me", { credentials: "same-origin" }).catch(function () {}); }
    catch (e) {}
  }
  window.addEventListener("focus", recheck);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") recheck();
  });
})();
