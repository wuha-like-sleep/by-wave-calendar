// Reformat every <time data-tz datetime="ISO"> element using the browser's
// timezone. The server emits a UTC-ISO datetime attribute plus a server-side
// fallback string (so no-JS / pre-hydration users still see something sane);
// this script swaps in a browser-local string once the page loads, then keeps
// it in sync if the user changes timezone mid-session.
(function () {
  "use strict";

  const STYLE_FORMATTERS = {
    datetime: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false },
    date: { year: "numeric", month: "2-digit", day: "2-digit" },
    time: { hour: "2-digit", minute: "2-digit", hour12: false },
    full: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
    relative: null, // handled below
  };

  const locale = navigator.language || "zh-CN";

  function fmtAbsolute(date, style) {
    const opts = STYLE_FORMATTERS[style] || STYLE_FORMATTERS.datetime;
    try { return new Intl.DateTimeFormat(locale, opts).format(date); }
    catch (_e) { return date.toISOString(); }
  }

  function fmtRelative(date) {
    const diffMs = date.getTime() - Date.now();
    const abs = Math.abs(diffMs);
    const MIN = 60_000, HR = 60 * MIN, DAY = 24 * HR;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (abs < HR)  return rtf.format(Math.round(diffMs / MIN), "minute");
    if (abs < DAY) return rtf.format(Math.round(diffMs / HR),  "hour");
    if (abs < 30 * DAY) return rtf.format(Math.round(diffMs / DAY), "day");
    return fmtAbsolute(date, "date");
  }

  function applyOne(el) {
    const iso = el.getAttribute("datetime");
    if (!iso) return;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return;
    const style = el.getAttribute("data-style") || "datetime";
    el.textContent = style === "relative" ? fmtRelative(date) : fmtAbsolute(date, style);
    el.title = new Intl.DateTimeFormat(locale, STYLE_FORMATTERS.full).format(date)
             + "  ·  UTC " + iso;
  }

  function applyAll() {
    document.querySelectorAll("time[data-tz]").forEach(applyOne);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyAll);
  } else {
    applyAll();
  }
  // Re-apply after HTMX swaps so newly inserted times are formatted too.
  document.body && document.body.addEventListener && document.body.addEventListener("htmx:afterSwap", applyAll);
  // Expose for other scripts (e.g., the Toast UI calendar app) to call when they
  // inject server-rendered fragments.
  window.bwcFormatTimes = applyAll;
})();
