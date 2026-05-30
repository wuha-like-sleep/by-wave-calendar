# Pluggable CAPTCHA — integration guide

This module replaces the legacy arithmetic captcha (`src/lib/captcha.ts`) with a
provider-based, pluggable human-verification system. It is self-contained; the
files below are new and do not modify anything you own. **You** do the wiring
described here (schema, web/index.ts, admin.ts, register.ejs, site_settings.ts).

## Files in this module

| File | Role |
|------|------|
| `src/lib/captcha/types.ts` | `CaptchaProvider`, `CaptchaConfig`, `ClientRender`, `VerifyResult`. |
| `src/lib/captcha/index.ts` | Façade: `getClientRender`, `verifyCaptcha`, `FIELD`, re-exports. |
| `src/lib/captcha/builtin_pow.ts` | Self-hosted invisible Proof-of-Work (issue/verify). |
| `src/lib/captcha/providers.ts` | Turnstile + reCAPTCHA server-side siteverify. |
| `src/public/bwc-captcha.js` | Self-contained client widget (served at `/static/bwc-captcha.js`). |
| `test/captcha_pow.test.ts` | Unit tests. |

## The integration contract (field names)

The client widget writes these hidden `<input>`s into the form; the server reads
the same names in `verifyCaptcha`. They are exported as `FIELD` from
`src/lib/captcha/index.js` — import them rather than hard-coding strings.

```ts
import { FIELD } from "./lib/captcha/index.js";
// FIELD.challenge === "bwc-captcha-challenge"  (builtin: the SIGNED token)
// FIELD.nonce     === "bwc-captcha-nonce"      (builtin: the solved nonce)
// FIELD.token     === "bwc-captcha-token"      (turnstile/recaptcha token)
// (advisory extras the widget also posts: "bwc-captcha-elapsed",
//  "bwc-captcha-interacted" — ignore them unless you want weak heuristics.)
```

`verifyCaptcha` accepts the whole parsed form body and pulls the fields it
needs, so you can just hand it `req.body`.

---

## 1. site_settings — fields to add

### `src/db/schema.ts` (siteSettings table)
Add three columns (mirroring how `ssoKeycloak*` columns are defined):

```ts
captchaProvider: text("captcha_provider").notNull().default("builtin"),
captchaSiteKey:  text("captcha_site_key"),   // nullable
captchaSecret:   text("captcha_secret"),     // nullable; treat as a secret
```

Generate + run a migration (`npm run db:generate` then `npm run db:migrate`).
Default `"builtin"` means: privacy-preserving offline PoW is on out of the box.

### `src/lib/site_settings.ts`
1. Add to `SettingsView`:
   ```ts
   captchaProvider: CaptchaProvider; // "none" | "builtin" | "turnstile" | "recaptcha"
   captchaSiteKey: string | null;
   ```
   (Import `CaptchaProvider` / `isCaptchaProvider` from `./captcha/index.js`.)
   **Do NOT put `captchaSecret` in `SettingsView`** — that view is read widely
   and may reach templates. Expose the secret only through a dedicated getter,
   like the existing `getSsoConfig()`:
   ```ts
   export async function getCaptchaConfig(): Promise<CaptchaConfig> {
     const [row] = await db.select().from(schema.siteSettings)
       .where(eq(schema.siteSettings.id, 1)).limit(1);
     const provider = isCaptchaProvider(row?.captchaProvider) ? row!.captchaProvider : "builtin";
     return { provider, siteKey: row?.captchaSiteKey ?? null, secret: row?.captchaSecret ?? null };
   }
   ```
2. In `toView`, map `captchaProvider` (validate via `isCaptchaProvider`, default
   `"builtin"`) and `captchaSiteKey`.
3. Add the three fields to the `updateSettings` patch type so admin can save them.

---

## 2. GET /register — mint the widget data

In `src/web/index.ts`, replace the legacy `issueCaptcha()` call:

```ts
import { getClientRender } from "../lib/captcha/index.js";
import { getCaptchaConfig } from "../lib/site_settings.js";
// ...
const captcha = getClientRender(await getCaptchaConfig());
return reply.view("auth/register", {
  title: "注册",
  user: null,
  csrfToken: csrfTokenFor(req),
  flash: flashFromQuery(req),
  form: {},
  captcha, // ClientRender: { provider, siteKey?, builtin? }
});
```

`getClientRender` mints a fresh PoW challenge per render for `builtin`. Call it
on every GET (don't cache) so each visitor gets a unique challenge.

---

## 3. register.ejs — widget container + script

Replace the old `<% if (captcha) { %> … arithmetic … <% } %>` block with a
single container div whose `data-*` attributes carry the render data, plus the
script tag. No inline JS (CSP-clean).

```ejs
<% if (typeof captcha !== "undefined" && captcha && captcha.provider !== "none") { %>
  <div class="mt-1">
    <% if (captcha.provider === "builtin") { %>
      <div data-bwc-captcha="builtin"
           data-token="<%= captcha.builtin.token %>"
           data-challenge="<%= captcha.builtin.challenge %>"
           data-salt="<%= captcha.builtin.salt %>"
           data-difficulty="<%= captcha.builtin.difficulty %>"></div>
    <% } else { %>
      <div data-bwc-captcha="<%= captcha.provider %>"
           data-sitekey="<%= captcha.siteKey %>"></div>
    <% } %>
  </div>
<% } %>
```

Then load the widget once, before `</body>` (or wherever the page's deferred
scripts go). In production the layout serves minified bundles from
`/static/_built/`; in dev from `/static/`. Follow whatever pattern the other
page scripts use, e.g.:

```ejs
<script src="/static/bwc-captcha.js" defer></script>
```

The widget auto-inits every `[data-bwc-captcha]` on DOMContentLoaded, finds the
enclosing `<form>`, and writes the hidden fields. For `builtin` it disables the
submit button until the PoW is solved (≈0.1–0.5 s), then shows a green check.

> The values are random hex / a base64url token / an integer — all HTML-attribute
> safe. EJS `<%= %>` escaping is fine. The `data-sitekey` for third-party
> providers is the public key, also safe to render.

---

## 4. POST /register — verify

```ts
import { verifyCaptcha } from "../lib/captcha/index.js";
import { getCaptchaConfig } from "../lib/site_settings.js";
// ...
// Add the captcha fields to your zod body schema (all optional strings):
//   "bwc-captcha-challenge": z.string().max(2048).optional(),
//   "bwc-captcha-nonce":     z.string().max(64).optional(),
//   "bwc-captcha-token":     z.string().max(4096).optional(),
// Easiest: keep your existing schema and pass req.body straight through —
// verifyCaptcha reads by field name and ignores everything else.

const cfg = await getCaptchaConfig();
const captchaResult = await verifyCaptcha(cfg, req.body as Record<string, string | undefined>, req.ip);
if (!captchaResult.ok) {
  req.log.warn({ reason: captchaResult.reason }, "captcha failed"); // reason is for logs only
  return redirectWith(reply, "/register", { error: "人机验证未通过，请刷新页面后重试" });
}
```

Notes:
- `verifyCaptcha` never throws; it always resolves `{ ok, reason? }`.
- `reason` is diagnostic — **never** surface it to the user (don't leak provider
  internals). Show a generic Chinese message only.
- It is `async` (third-party providers make a network call); the builtin path
  resolves synchronously-fast but still returns a promise — `await` it.
- `req.ip` is forwarded to Turnstile/reCAPTCHA as `remoteip`. Make sure Fastify
  `trustProxy` is set correctly behind nginx so `req.ip` is the real client IP.

### zod field names with hyphens
Hyphenated keys need quotes in zod:
`z.object({ "bwc-captcha-nonce": z.string().max(64).optional(), ... })`.
If you prefer, skip adding them to the schema entirely and just pass `req.body`
to `verifyCaptcha` — `@fastify/formbody` already parsed them into `req.body`.

---

## 5. Admin settings page — what to expose

On the admin security/settings page (`src/web/admin.ts` + its EJS):
- A **select** for provider: `内置无感验证 (builtin)` / `关闭 (none)` /
  `Cloudflare Turnstile` / `Google reCAPTCHA`. Use `CAPTCHA_PROVIDERS` from the
  module to render options, and validate the POST with `isCaptchaProvider`.
- A **Site Key** text input (shown for turnstile/recaptcha).
- A **Secret** password input (shown for turnstile/recaptcha). On save, treat it
  like the SSO client secret: never echo it back to the page; if the field is
  submitted blank, keep the stored value (don't overwrite with empty).
- A short note that turnstile/recaptcha load third-party scripts (Cloudflare /
  Google) and are off by default for privacy / China-reachability; `builtin` is
  fully self-hosted and offline.

---

## 6. Where each provider's keys come from

| Provider | Site Key | Secret | Scripts loaded |
|----------|----------|--------|----------------|
| `builtin` | n/a (uses `SESSION_SECRET`) | n/a | none (self-hosted) |
| `turnstile` | Cloudflare dashboard → Turnstile → site | same dashboard | `https://challenges.cloudflare.com/turnstile/v0/api.js` |
| `recaptcha` | Google reCAPTCHA admin console (v2 "I'm not a robot" checkbox) | same console | `https://www.google.com/recaptcha/api.js` |

### CSP note (important)
If a third-party provider is enabled, your Content-Security-Policy
(`@fastify/helmet` config in `src/server.ts`) must allow those hosts:
- Turnstile: add `https://challenges.cloudflare.com` to `script-src` and
  `frame-src`.
- reCAPTCHA: add `https://www.google.com` and `https://www.gstatic.com` to
  `script-src` and `frame-src`.

`builtin` needs **no** CSP changes — it ships one same-origin script
(`/static/bwc-captcha.js`) and runs a Web Worker built from a same-origin Blob.
If your CSP sets `worker-src`/`child-src`, include `blob:` so the PoW Worker can
spawn (it falls back to a main-thread chunked solver if Workers are blocked, so
this is a performance nicety, not a hard requirement).

---

## Removing the legacy captcha

Once wired, delete `src/lib/captcha.ts`, `test/captcha.test.ts`, and the legacy
`captchaToken` / `captchaAnswer` fields from the register schema/view. (Left to
you per the task split.)
