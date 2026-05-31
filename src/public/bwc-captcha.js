// bwc-captcha.js — self-contained human-verification widget. No dependencies,
// no external CDN, no inline JS (loaded via <script src> so it satisfies a
// strict CSP). Renders a Turnstile-style one-line "I'm not a robot" control.
//
// It auto-initialises every element matching [data-bwc-captcha] on DOMContent-
// Loaded. Configuration comes from data-* attributes on that container:
//
//   data-bwc-captcha="builtin" | "turnstile" | "recaptcha" | "hcaptcha" | "none"
//   builtin:
//     data-token="<signed token>"           (echoed back unchanged on submit)
//     data-challenge="<raw challenge str>"   (hashed with salt + nonce)
//     data-salt="<hex>"
//     data-difficulty="<int leading-zero-bits>"
//   turnstile / recaptcha:
//     data-sitekey="<public site key>"
//
// On success it writes hidden inputs INTO THE ENCLOSING <form>:
//   builtin  → bwc-captcha-challenge, bwc-captcha-nonce (+ behavioural signals)
//   3rd-party→ bwc-captcha-token
// These names must match src/lib/captcha/index.ts FIELD.*.
//
// The PoW solve runs in a Web Worker (built from a Blob, so still no external
// file) to keep the main thread responsive; if Workers are unavailable it
// falls back to a chunked setTimeout loop. The widget is "invisible": it starts
// solving immediately and just shows a spinner → checkmark. There is no answer
// to read in DevTools — the browser must brute-force a sha256 preimage.
(function () {
  "use strict";

  var FIELD = {
    challenge: "bwc-captcha-challenge",
    nonce: "bwc-captcha-nonce",
    token: "bwc-captcha-token",
    // lightweight behavioural signals (advisory; server may ignore)
    elapsed: "bwc-captcha-elapsed",
    interacted: "bwc-captcha-interacted",
  };

  // --------------------------------------------------------------------------
  // Compact synchronous SHA-256 (FIPS 180-4). Operates on a UTF-8 string and
  // returns the digest as a lowercase hex string. ~80 lines, no deps. This is
  // also the body shipped into the Web Worker (see workerSource()).
  // --------------------------------------------------------------------------
  function sha256Factory() {
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

    // UTF-8 encode a JS string to an array of byte values.
    function utf8Bytes(str) {
      var out = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) {
          out.push(c);
        } else if (c < 0x800) {
          out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c < 0xd800 || c >= 0xe000) {
          out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
          // surrogate pair
          i++;
          var cp = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        }
      }
      return out;
    }

    function hex(words) {
      var s = "";
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        s += ("00000000" + (w >>> 0).toString(16)).slice(-8);
      }
      return s;
    }

    return function sha256Hex(message) {
      var bytes = utf8Bytes(message);
      var bitLen = bytes.length * 8;
      // append 0x80 then pad to 56 mod 64, then 64-bit big-endian length.
      bytes.push(0x80);
      while (bytes.length % 64 !== 56) bytes.push(0);
      // 64-bit length; JS bit ops are 32-bit, high word is bitLen/2^32.
      var hi = Math.floor(bitLen / 0x100000000);
      var lo = bitLen >>> 0;
      bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
      bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

      var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      var w = new Array(64);

      for (var off = 0; off < bytes.length; off += 64) {
        for (var i = 0; i < 16; i++) {
          w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
                 (bytes[off + i * 4 + 2] << 8) | (bytes[off + i * 4 + 3]);
        }
        for (i = 16; i < 64; i++) {
          var s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
          var s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (i = 0; i < 64; i++) {
          var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
          var ch = (e & f) ^ (~e & g);
          var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
          var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
          var maj = (a & b) ^ (a & c) ^ (b & c);
          var t2 = (S0 + maj) | 0;
          h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
      }
      return hex(H);
    };
  }

  var sha256Hex = sha256Factory();

  // Leading zero bits of a hex digest (matches server leadingZeroBits()).
  function leadingZeroBitsHex(hexDigest) {
    var bits = 0;
    for (var i = 0; i < hexDigest.length; i++) {
      var nibble = parseInt(hexDigest[i], 16);
      if (nibble === 0) { bits += 4; continue; }
      if (nibble >= 8) { bits += 0; }
      else if (nibble >= 4) { bits += 1; }
      else if (nibble >= 2) { bits += 2; }
      else { bits += 3; }
      break;
    }
    return bits;
  }

  // --------------------------------------------------------------------------
  // Worker source. We stringify the sha256 factory + a solve loop and run it in
  // a Blob-backed Worker so the main thread never janks. Same algorithm as the
  // server's verifyChallenge, so a found nonce always validates server-side.
  // --------------------------------------------------------------------------
  function workerSource() {
    return "var sha256Hex = (" + sha256Factory.toString() + ")();\n" +
      "var lzb = " + leadingZeroBitsHex.toString() + ";\n" +
      "self.onmessage = function (e) {\n" +
      "  var d = e.data; var challenge = d.challenge, salt = d.salt, difficulty = d.difficulty;\n" +
      "  var nonce = 0;\n" +
      "  while (true) {\n" +
      "    var h = sha256Hex(challenge + ':' + salt + ':' + nonce);\n" +
      "    if (lzb(h) >= difficulty) { self.postMessage({ nonce: String(nonce) }); return; }\n" +
      "    nonce++;\n" +
      "    if ((nonce & 0x3fff) === 0) self.postMessage({ progress: nonce });\n" +
      "  }\n" +
      "};\n";
  }

  // Solve via Worker, falling back to chunked setTimeout. Returns a promise.
  function solvePow(challenge, salt, difficulty) {
    return new Promise(function (resolve) {
      // Try a Web Worker first.
      if (typeof Worker !== "undefined" && typeof Blob !== "undefined" && window.URL && window.URL.createObjectURL) {
        var url = null, worker = null;
        try {
          var blob = new Blob([workerSource()], { type: "text/javascript" });
          url = window.URL.createObjectURL(blob);
          worker = new Worker(url);
          worker.onmessage = function (e) {
            if (e.data && e.data.nonce != null) {
              try { worker.terminate(); } catch (x) {}
              if (url) window.URL.revokeObjectURL(url);
              resolve(e.data.nonce);
            }
          };
          worker.onerror = function () {
            try { worker.terminate(); } catch (x) {}
            if (url) window.URL.revokeObjectURL(url);
            chunkedSolve(challenge, salt, difficulty, resolve);
          };
          worker.postMessage({ challenge: challenge, salt: salt, difficulty: difficulty });
          return;
        } catch (err) {
          if (url) { try { window.URL.revokeObjectURL(url); } catch (x) {} }
          // fall through to chunked solve
        }
      }
      chunkedSolve(challenge, salt, difficulty, resolve);
    });
  }

  // Main-thread fallback: hash in ~3ms slices via setTimeout so the UI stays
  // responsive even without Workers.
  function chunkedSolve(challenge, salt, difficulty, resolve) {
    var nonce = 0;
    function step() {
      var start = Date.now();
      // Run until ~12ms elapsed, then yield to the event loop.
      while (Date.now() - start < 12) {
        var h = sha256Hex(challenge + ":" + salt + ":" + nonce);
        if (leadingZeroBitsHex(h) >= difficulty) { resolve(String(nonce)); return; }
        nonce++;
      }
      setTimeout(step, 0);
    }
    var schedule = window.requestIdleCallback || function (fn) { setTimeout(fn, 0); };
    schedule(step);
  }

  // --------------------------------------------------------------------------
  // Behavioural signals — advisory only. Records whether the user moved a
  // pointer / pressed a key, and how long from widget-arm to submit. The server
  // may use these as weak heuristics; they are never the sole gate.
  // --------------------------------------------------------------------------
  function behaviour(container, form) {
    var armedAt = Date.now();
    var interacted = false;
    function mark() { interacted = true; }
    window.addEventListener("pointerdown", mark, { once: true, passive: true });
    window.addEventListener("mousemove", mark, { once: true, passive: true });
    window.addEventListener("keydown", mark, { once: true, passive: true });
    window.addEventListener("touchstart", mark, { once: true, passive: true });
    form.addEventListener("submit", function () {
      setHidden(form, FIELD.elapsed, String(Date.now() - armedAt));
      setHidden(form, FIELD.interacted, interacted ? "1" : "0");
    });
  }

  // --------------------------------------------------------------------------
  // DOM helpers + the one-line "I'm not a robot" control.
  // --------------------------------------------------------------------------
  function setHidden(form, name, value) {
    var input = form.querySelector('input[type="hidden"][name="' + name + '"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  function buildShell(container, label) {
    container.innerHTML = "";
    var box = document.createElement("div");
    box.className = "bwc-captcha-box";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    box.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px 12px;" +
      "border:1px solid #cbd5e1;border-radius:10px;background:#f8fafc;font-size:14px;" +
      "color:#334155;min-height:42px;max-width:320px;box-sizing:border-box;";

    var icon = document.createElement("span");
    icon.className = "bwc-captcha-icon";
    icon.style.cssText = "width:18px;height:18px;flex:0 0 18px;display:inline-block;";
    icon.innerHTML = spinnerSvg();

    var text = document.createElement("span");
    text.className = "bwc-captcha-text";
    text.textContent = label;

    box.appendChild(icon);
    box.appendChild(text);
    container.appendChild(box);
    return { box: box, icon: icon, text: text };
  }

  function spinnerSvg() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9" fill="none" stroke="#cbd5e1" stroke-width="3"/>' +
      '<path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="#6366f1" stroke-width="3" stroke-linecap="round">' +
      '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/>' +
      '</path></svg>';
  }

  function checkSvg() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10" fill="#16a34a"/>' +
      '<path d="M7 12.5l3 3 7-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
  }

  function errorSvg() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10" fill="#dc2626"/>' +
      '<path d="M12 7v6M12 16.5v.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>' +
      '</svg>';
  }

  function setVerifying(ui, label) { ui.icon.innerHTML = spinnerSvg(); ui.text.textContent = label; }
  function setPassed(ui, label) {
    ui.icon.innerHTML = checkSvg();
    ui.text.textContent = label;
    ui.box.style.borderColor = "#86efac";
    ui.box.style.background = "#f0fdf4";
  }
  function setFailed(ui, label) {
    ui.icon.innerHTML = errorSvg();
    ui.text.textContent = label;
    ui.box.style.borderColor = "#fca5a5";
    ui.box.style.background = "#fef2f2";
  }

  // i18n-lite: read optional override labels off the container, else defaults.
  function labels(container) {
    return {
      verifying: container.getAttribute("data-label-verifying") || "正在验证…",
      passed: container.getAttribute("data-label-passed") || "已通过人机验证",
      failed: container.getAttribute("data-label-failed") || "验证失败，请刷新页面重试",
      click: container.getAttribute("data-label-click") || "点击进行人机验证",
    };
  }

  // Empty checkbox icon for the interactive (click-to-verify) mode.
  function uncheckedSvg() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="4" fill="#fff" stroke="#94a3b8" stroke-width="2"/>' +
      '</svg>';
  }

  // --------------------------------------------------------------------------
  // builtin: invisible PoW.
  // --------------------------------------------------------------------------
  function initBuiltin(container, form) {
    var L = labels(container);
    var token = container.getAttribute("data-token") || "";
    var challenge = container.getAttribute("data-challenge") || "";
    var salt = container.getAttribute("data-salt") || "";
    var difficulty = parseInt(container.getAttribute("data-difficulty") || "16", 10);
    var mode = container.getAttribute("data-mode") === "interactive" ? "interactive" : "invisible";

    // Either mode shows a verifying shell first; build it now so we can fail into it.
    var ui = buildShell(container, mode === "interactive" ? L.click : L.verifying);
    if (mode === "interactive") {
      ui.icon.innerHTML = uncheckedSvg();
      ui.box.style.cursor = "pointer";
      ui.box.setAttribute("role", "button");
      ui.box.setAttribute("tabindex", "0");
    }
    if (!token || !challenge || !salt || !(difficulty > 0)) { setFailed(ui, L.failed); return; }

    // Echo the (unmodified) signed token back immediately; the nonce lands once
    // we solve. We hash the RAW challenge (not the token). The submit button is
    // disabled until solved so a user can't post a token without its nonce and
    // bounce off the server rejection.
    setHidden(form, FIELD.challenge, token);
    behaviour(container, form);

    var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    var reenable = null;
    if (submitBtn && !submitBtn.disabled) {
      submitBtn.disabled = true;
      reenable = function () { submitBtn.disabled = false; };
    }

    // Run the PoW solve, then flip to the green "passed" state + re-enable submit.
    // Shared by both modes — the only difference is WHEN this is triggered.
    function solveAndPass() {
      setVerifying(ui, L.verifying);
      var start = Date.now();
      solvePow(challenge, salt, difficulty).then(function (nonce) {
        setHidden(form, FIELD.nonce, nonce);
        // brief minimum spinner so the transition reads as "verified", not flicker
        var elapsed = Date.now() - start;
        var delay = elapsed < 350 ? 350 - elapsed : 0;
        setTimeout(function () {
          setPassed(ui, L.passed);
          if (reenable) reenable();
        }, delay);
      });
    }

    var schedule = window.requestIdleCallback || function (fn) { setTimeout(fn, 0); };

    if (mode === "interactive") {
      // Manual mode: wait for an explicit click/keypress, THEN solve.
      var started = false;
      function trigger() {
        if (started) return;
        started = true;
        ui.box.style.cursor = "default";
        ui.box.removeAttribute("role");
        ui.box.removeAttribute("tabindex");
        schedule(solveAndPass);
      }
      ui.box.addEventListener("click", trigger);
      ui.box.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.keyCode === 13 || e.keyCode === 32) {
          e.preventDefault();
          trigger();
        }
      });
    } else {
      // Invisible mode: solve automatically on idle, no interaction.
      schedule(solveAndPass);
    }
  }

  // --------------------------------------------------------------------------
  // turnstile / recaptcha: load the official script, render the official
  // widget, mirror its token into our hidden field on success.
  // --------------------------------------------------------------------------
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.getAttribute("data-loaded") === "1") { resolve(); return; }
        existing.addEventListener("load", function () { resolve(); });
        existing.addEventListener("error", reject);
        return;
      }
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.defer = true;
      s.addEventListener("load", function () { s.setAttribute("data-loaded", "1"); resolve(); });
      s.addEventListener("error", reject);
      document.head.appendChild(s);
    });
  }

  function initTurnstile(container, form) {
    var L = labels(container);
    var ui = buildShell(container, L.verifying);
    var sitekey = container.getAttribute("data-sitekey") || "";
    if (!sitekey) { setFailed(ui, L.failed); return; }
    behaviour(container, form);

    // Replace our shell with Turnstile's own widget mount point.
    var mount = document.createElement("div");
    container.appendChild(mount);

    loadScript("https://challenges.cloudflare.com/turnstile/v0/api.js")
      .then(function () {
        var tries = 0;
        (function waitForApi() {
          if (window.turnstile && window.turnstile.render) {
            ui.box.style.display = "none";
            window.turnstile.render(mount, {
              sitekey: sitekey,
              callback: function (token) { setHidden(form, FIELD.token, token); },
              "error-callback": function () { setHidden(form, FIELD.token, ""); },
              "expired-callback": function () { setHidden(form, FIELD.token, ""); },
            });
          } else if (tries++ < 100) {
            setTimeout(waitForApi, 50);
          } else {
            setFailed(ui, L.failed);
          }
        })();
      })
      .catch(function () { setFailed(ui, L.failed); });
  }

  function initRecaptcha(container, form) {
    var L = labels(container);
    var ui = buildShell(container, L.verifying);
    var sitekey = container.getAttribute("data-sitekey") || "";
    if (!sitekey) { setFailed(ui, L.failed); return; }
    behaviour(container, form);

    var mount = document.createElement("div");
    container.appendChild(mount);

    loadScript("https://www.google.com/recaptcha/api.js")
      .then(function () {
        var tries = 0;
        (function waitForApi() {
          if (window.grecaptcha && window.grecaptcha.render) {
            ui.box.style.display = "none";
            window.grecaptcha.render(mount, {
              sitekey: sitekey,
              callback: function (token) { setHidden(form, FIELD.token, token); },
              "expired-callback": function () { setHidden(form, FIELD.token, ""); },
              "error-callback": function () { setHidden(form, FIELD.token, ""); },
            });
          } else if (tries++ < 100) {
            setTimeout(waitForApi, 50);
          } else {
            setFailed(ui, L.failed);
          }
        })();
      })
      .catch(function () { setFailed(ui, L.failed); });
  }

  function initHcaptcha(container, form) {
    var L = labels(container);
    var ui = buildShell(container, L.verifying);
    var sitekey = container.getAttribute("data-sitekey") || "";
    if (!sitekey) { setFailed(ui, L.failed); return; }
    behaviour(container, form);

    var mount = document.createElement("div");
    container.appendChild(mount);

    loadScript("https://js.hcaptcha.com/1/api.js")
      .then(function () {
        var tries = 0;
        (function waitForApi() {
          if (window.hcaptcha && window.hcaptcha.render) {
            ui.box.style.display = "none";
            window.hcaptcha.render(mount, {
              sitekey: sitekey,
              callback: function (token) { setHidden(form, FIELD.token, token); },
              "expired-callback": function () { setHidden(form, FIELD.token, ""); },
              "error-callback": function () { setHidden(form, FIELD.token, ""); },
            });
          } else if (tries++ < 100) {
            setTimeout(waitForApi, 50);
          } else {
            setFailed(ui, L.failed);
          }
        })();
      })
      .catch(function () { setFailed(ui, L.failed); });
  }

  // --------------------------------------------------------------------------
  // Bootstrap.
  // --------------------------------------------------------------------------
  function initOne(container) {
    if (container.getAttribute("data-bwc-init") === "1") return;
    container.setAttribute("data-bwc-init", "1");
    var form = container.closest("form");
    if (!form) return; // nothing to attach hidden fields to
    var provider = container.getAttribute("data-bwc-captcha") || "none";
    if (provider === "builtin") return initBuiltin(container, form);
    if (provider === "turnstile") return initTurnstile(container, form);
    if (provider === "recaptcha") return initRecaptcha(container, form);
    if (provider === "hcaptcha") return initHcaptcha(container, form);
    // "none" → nothing to render.
  }

  function initAll() {
    var nodes = document.querySelectorAll("[data-bwc-captcha]");
    for (var i = 0; i < nodes.length; i++) initOne(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  // Expose for SPA/manual re-init if a form is injected later.
  window.bwcCaptcha = { init: initAll, initOne: initOne };
})();
