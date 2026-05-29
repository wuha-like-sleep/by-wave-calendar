// ServerCapabilities.swift
// Detect which server features are available against the currently-bound
// host, and provide booleans the UI can branch on. Lets the iOS APP work
// against any server version that has the phone-binding feature (added
// v0.6.0, server-side) — gracefully degrading new features (native MFA,
// native account management, web-session bridge etc.) when the server
// is too old to know about them.
//
// We probe two endpoints on bind / bootstrap:
//   1. GET /api/v1/health/app  (added v0.7.4) — newer; returns
//      { version, appsEnabled, themeAccent, ... }
//   2. GET /health             (oldest endpoint, returns { status, version })
//
// Whichever responds first sets `serverVersion`. The booleans below are
// computed from that version string using simple semver comparison.

import Foundation

/// Minimum server version supporting each iOS feature. Bump these when
/// adding new features that depend on server endpoints.
struct ServerCapabilities {
    let version: String   // "0.10.2" — empty string when unknown

    /// Explicit per-feature flags the server reports under
    /// `health/app.capabilities` (added server-side for #77). When present
    /// these WIN over version-based inference — the server is the authority
    /// on what it actually has turned on (e.g. an admin can disable qrLogin
    /// even on a new server). `nil` means the server is old enough that it
    /// doesn't report the object at all; we then fall back to semver.
    let capabilities: [String: Bool]?

    /// `capabilityVersion` — coarse monotonic counter from the server. Lets
    /// us do cheap "is this server at least gen N" checks. 0 when unknown.
    let capabilityVersion: Int

    /// Read an explicit capability flag, falling back to a version-based
    /// guess when the server didn't report the object (old server). The
    /// fallback is the caller's responsibility to pass — usually a semver
    /// check that approximates when the feature shipped.
    private func cap(_ key: String, fallback: @autoclosure () -> Bool) -> Bool {
        if let caps = capabilities, let v = caps[key] { return v }
        return fallback()
    }

    /// /api/v1/health/app — first appeared v0.7.4. iOS uses this to pull
    /// the theme accent + appsEnabled diagnostic. Falls back to /health
    /// for older servers (gets just version, no theme).
    var hasHealthAppEndpoint: Bool { version.atLeast("0.7.4") }

    // ---- Explicit-capability-gated features (#77) ----
    // Each prefers the server's reported flag; falls back to a semver guess
    // for servers too old to report `capabilities`. UI hides the feature
    // when these are false so a user on an old server never taps a button
    // that 404s.

    /// Web 扫码登录 (QR tab on /login). Admin-toggleable, so the explicit
    /// flag matters even on new servers.
    var hasQrLogin: Bool { cap("qrLogin", fallback: version.atLeast("1.3.0")) }

    /// Third-party bearer-token API (admin-toggleable).
    var hasApiTokens: Bool { cap("apiTokens", fallback: version.atLeast("0.9.0")) }

    /// WebAuthn / Passkey register + login.
    var hasPasskey: Bool { cap("passkey", fallback: version.atLeast("0.3.0")) }

    /// CalDAV app-specific passwords.
    var hasAppPasswords: Bool { cap("appPasswords", fallback: version.atLeast("0.7.0")) }

    /// Auto-sync remote ICS subscriptions.
    var hasCalendarSubscriptions: Bool { cap("calendarSubscriptions", fallback: version.atLeast("0.8.0")) }

    /// Attendee invite + RSVP on events.
    var hasEventInvites: Bool { cap("eventInvites", fallback: version.atLeast("0.9.0")) }

    /// Per-user UI language (server i18n).
    var hasI18n: Bool { cap("i18n", fallback: version.atLeast("1.3.0")) }

    /// Desktop QR scan-to-login binding (admin-toggleable via appsEnabled).
    var hasDesktopPairing: Bool { cap("desktopPairing", fallback: version.atLeast("0.7.2")) }

    /// Native "Sign in with Apple" — POST /api/v1/auth/apple (server #67).
    /// Prefers the server's explicit `appleSignIn` capability flag when it
    /// reports one. Servers that predate the flag (it isn't in the v1
    /// capability set yet) fall back to a semver guess. The SetupView button
    /// shows whenever this is true OR the server version is unknown — and a
    /// server that has the route but no SIWA_CLIENT_IDS configured still
    /// degrades gracefully by returning 503 apple_signin_not_configured,
    /// which AppleSignInError maps to a friendly message.
    var hasAppleSignIn: Bool { cap("appleSignIn", fallback: version.atLeast("1.5.0")) }

    /// CSRF exempt list correctly allows /devices/pair-claim,
    /// /auth/login-password, /auth/refresh — v0.7.5+. Older servers
    /// return 403 csrf_invalid for any APP login attempt; iOS shows a
    /// "server too old" error message in that case.
    var hasCsrfBypass: Bool { version.atLeast("0.7.5") }

    /// /api/v1/auth/web-session bridge — added v0.8.0. Used by iOS
    /// Settings to open the web management pages auto-signed-in.
    var hasWebSessionBridge: Bool { version.atLeast("0.8.0") }

    /// /api/v1/account/password + /api/v1/account/delete — added v0.9.1.
    /// iOS native change-password / delete-account forms require these.
    /// When unavailable, the UI falls back to the web-session bridge
    /// (if available) or hides the row.
    var hasNativeAccountManagement: Bool { version.atLeast("0.9.1") }

    /// /api/v1/account/mfa/setup + /verify + /disable — added v0.10.0.
    /// Native MFA setup UI requires these.
    var hasNativeMfaEndpoints: Bool { version.atLeast("0.10.0") }

    /// client_device_id column on devices table + upsert dedup — added
    /// v0.8.0. Older servers ignore unknown body fields silently (zod
    /// strips them) so sending clientDeviceId is harmless either way;
    /// this flag exists for tests + diagnostics, not branching.
    var supportsClientDeviceId: Bool { version.atLeast("0.8.0") }

    /// Catch-all "is the server new enough" — most features need this.
    /// Anything older than v0.6.0 doesn't even have phone-binding routes.
    var isUsable: Bool { version.atLeast("0.6.0") || version.isEmpty }

    static let unknown = ServerCapabilities(version: "", capabilities: nil, capabilityVersion: 0)

    /// Build from a parsed health/app payload. Reads the explicit
    /// `capabilities` object + `capabilityVersion` when present (new
    /// servers), gracefully degrading to version-only (old servers).
    static func from(payload: [String: Any]) -> ServerCapabilities {
        let version = (payload["version"] as? String) ?? ""
        let caps = payload["capabilities"] as? [String: Bool]
        let capVer = (payload["capabilityVersion"] as? Int) ?? 0
        return ServerCapabilities(version: version, capabilities: caps, capabilityVersion: capVer)
    }
}

private extension String {
    /// Lightweight semver comparison — strips leading 'v', splits on '.',
    /// compares numerically component-by-component. Tolerant of trailing
    /// pre-release tags (e.g. "0.10.0-rc.1" compares > "0.9.1").
    ///
    /// Returns true if self >= `target`. Unknown / empty version strings
    /// (server didn't report one) optimistically return true to avoid
    /// blocking features against very old servers we can't identify.
    func atLeast(_ target: String) -> Bool {
        if self.isEmpty { return true }  // optimistic when unknown
        let lhs = parseSemver(self)
        let rhs = parseSemver(target)
        for i in 0..<max(lhs.count, rhs.count) {
            let a = i < lhs.count ? lhs[i] : 0
            let b = i < rhs.count ? rhs[i] : 0
            if a != b { return a > b }
        }
        return true
    }

    private func parseSemver(_ s: String) -> [Int] {
        let stripped = s.hasPrefix("v") ? String(s.dropFirst()) : s
        // Drop pre-release / build metadata after first '-' or '+'.
        let core = stripped
            .split(whereSeparator: { $0 == "-" || $0 == "+" })
            .first
            .map(String.init) ?? stripped
        return core
            .split(separator: ".")
            .map { Int($0) ?? 0 }
    }
}
