# Security Policy · 安全策略

## Reporting a vulnerability · 报告漏洞

Found a security issue? **Please do NOT open a public issue.** Instead email
**info@by-wave.com** with details and a way to reproduce. We aim to respond
within a few days. Responsible disclosure is appreciated — we'll credit you
(if you want) once a fix ships.

发现安全问题？**请不要公开提 issue**，发邮件到 **info@by-wave.com** 说明
细节和复现步骤。我们会尽快响应。感谢负责任的披露。

---

## Security posture · 安全现状

This is a self-hosted product — each deployment is its own trust boundary.
The codebase ships with defense-in-depth defaults so an out-of-the-box
install is reasonably hardened. Audited 2026-05.

### Web / server

| Control | Implementation |
|---|---|
| HTTP security headers | `@fastify/helmet` — CSP with per-request nonce (no `unsafe-inline` in `script-src`), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` |
| HSTS | 1 year + `includeSubDomains` in production |
| CORS | locked to `PUBLIC_BASE_URL` in production (not `*`) |
| Sessions | signed, `httpOnly` + `secure` (prod) + `sameSite=lax` cookies; server-side session table |
| CSRF | token-based, verified on all state-changing form posts; native-app auth endpoints explicitly exempted by an allow-list |
| Rate limiting | global per-IP + tighter per-route limits on login / pairing / token issuance |
| Password storage | bcrypt; SSO / passwordless accounts store an unguessable bcrypt stub so no compare path can succeed |
| MFA | TOTP + backup codes; Passkey (WebAuthn) counts as both factors |
| Account lockout | failed-login counter + temporary lock; stranger-device email codes |
| SQL injection | Drizzle ORM parameterized queries throughout; **no** dynamic SQL identifiers built from user input |
| XSS | EJS auto-escapes (`<%= %>`); HTML-bearing i18n strings use audited `<%- %>` only |
| Uploads | multipart limited to 2 MB / 1 file / 5 fields |
| CSP reporting | `report-uri /csp-report` for visibility into blocked content |
| Transport | gzip/brotli compression; TLS terminated by the app or a fronting proxy |

### Native apps — token-at-rest

| Platform | Refresh token storage |
|---|---|
| iOS | **Keychain**, scoped per profile. Only the non-secret profile list lives in UserDefaults. |
| Android | **EncryptedSharedPreferences** (AES256-GCM value + AES256-SIV key, Android Keystore-backed `MasterKey`). |
| Desktop | `~/.bywave-calendar/profiles.json` at `0600` (POSIX) / NTFS ACL (Windows). Access tokens are **in-memory only** (1 h TTL, refreshed via `/auth/refresh`), so a leaked file only exposes revocable refresh tokens. Written atomically (temp + rename) so a crash can't corrupt the token file. |

### Native apps — update channel

- **Desktop auto-update**: manifest fetched over HTTPS (server endpoint with
  a GitHub-raw fallback) → downloaded DMG verified against the manifest's
  SHA-256 → **`codesign --verify --deep --strict`** of the new `.app` before
  the in-place swap (defense-in-depth, since the swap strips the
  `com.apple.quarantine` attr that would otherwise trigger Gatekeeper). A
  failed signature check aborts the install.
- **Desktop DMG** is Apple Developer ID signed + notarized + stapled.
- **Android APK** signing-cert fingerprint is pinned in the release script so
  a recovered/wrong keystore can't ship an APK that locks users out of
  in-place updates.

### Sign in with Apple (#67)

The native `/api/v1/auth/apple` endpoint verifies Apple's identity token
against Apple's JWKS (RS256, issuer + audience + expiry checked, `alg=none`
rejected). The server trusts **only** the verified token's `sub`/`email`,
never any app-supplied identity field. Private-relay emails are not used to
auto-link existing accounts.

---

## Known items / accepted risk

- **`script-src-attr: 'unsafe-inline'`** — a handful of legacy inline
  `onclick`/`onsubmit` handlers in EJS templates still need this. Tracked for
  a future refactor to event-delegation; the nonce-gated `script-src` already
  blocks injected `<script>` tags.
- **drizzle-orm advisory GHSA-gpj5-g38j-94v9** (SQLi via unescaped
  identifiers, fixed in 0.45.2) — the codebase builds **no** SQL identifiers
  from user input (verified by audit), so exposure is nil. The 0.36→0.45
  upgrade is a breaking change deferred until it can be validated separately.
- **Desktop token file is not OS-keychain-encrypted** — a deliberate choice:
  on desktop the user's home dir + `0600` perms are the isolation boundary;
  prompting for a master password every launch or storing a key beside the
  data would be UX hell or security theater respectively. Mobile uses the
  platform secure store because the FS isn't user-isolated there.
