// Nav bell unread badge. Polls the ETag-aware unread-count endpoint:
// no new notifications → 304 with an empty body, so an idle tab costs
// one tiny conditional request a minute. The badge element only exists
// for signed-in users; without it this script is a no-op.
(function () {
  "use strict";
  var badge = document.getElementById("bwc-notif-badge");
  if (!badge) return;

  var etag = null;
  var timer = null;

  function render(count) {
    if (!count || count <= 0) {
      badge.hidden = true;
      badge.textContent = "";
      return;
    }
    badge.hidden = false;
    badge.textContent = count > 99 ? "99+" : String(count);
  }

  function poll() {
    var headers = {};
    if (etag) headers["If-None-Match"] = etag;
    fetch("/api/notifications/unread-count", { headers: headers, credentials: "same-origin" })
      .then(function (res) {
        if (res.status === 304) return null;
        if (!res.ok) return null;
        var tag = res.headers.get("ETag");
        if (tag) etag = tag;
        return res.json();
      })
      .then(function (data) {
        if (data && typeof data.count === "number") render(data.count);
      })
      .catch(function () { /* offline / signed out — keep the last state */ });
  }

  poll();
  timer = setInterval(function () {
    if (!document.hidden) poll();
  }, 60_000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) poll();
  });
  // Keep the interval handle reachable for tests/debugging; also avoids
  // an unused-var warning in strict lint setups.
  window.__bwcNotifBadgeTimer = timer;
})();
