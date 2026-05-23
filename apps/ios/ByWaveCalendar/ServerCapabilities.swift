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

    /// /api/v1/health/app — first appeared v0.7.4. iOS uses this to pull
    /// the theme accent + appsEnabled diagnostic. Falls back to /health
    /// for older servers (gets just version, no theme).
    var hasHealthAppEndpoint: Bool { version.atLeast("0.7.4") }

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

    static let unknown = ServerCapabilities(version: "")
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
