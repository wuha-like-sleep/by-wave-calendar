// Profile.swift
// One signed-in account on one server. AppState holds an array of these
// + an active-profile pointer; switching accounts is purely a matter of
// re-pointing activeProfileId and the rest of the APP reacts.
//
// Each Profile gets its own Keychain refresh token (scoped by profile id)
// and its own on-disk event cache namespace, so switching never leaks
// data between accounts (Google account switcher semantics).
//
// Persisted as a JSON array in UserDefaults under "bwc.profiles". A
// signed-out profile stays in the list — Keychain refresh token is
// deleted, but serverURL / email stay so the user can tap "sign back in"
// without re-typing the host.

import Foundation

struct Profile: Codable, Identifiable, Hashable {
    /// Locally generated UUID — stable for the lifetime of this account
    /// on this device. Used as the Keychain scope + EventCache namespace.
    let id: String
    /// Server URL — stored as a String for clean Codable, parsed lazily.
    var serverURLString: String
    /// Email shown in the switcher + as "signed in as" subtitle. Set
    /// from the pair-claim / password-login response. Nil only for
    /// legacy migrated profiles where we never had the email.
    var userEmail: String?
    /// Display name (if the user set one on the server). Optional.
    var userName: String?
    /// Brand accent fetched from the server's /api/v1/health/app. Used
    /// to tint the APP when this profile is active. Falls back to the
    /// default brand purple when nil.
    var themeAccentHex: String?
    /// Last time the user successfully sync'd or switched into this
    /// profile. Used to sort the switcher list (most-recent first).
    var lastUsedAt: Date

    var serverURL: URL? { URL(string: serverURLString) }

    /// Two-line label for the switcher. "alice@example.com — server.com"
    /// when both available; falls back to whichever is set.
    var displayLabel: String {
        if let userEmail, !userEmail.isEmpty { return userEmail }
        if let url = URL(string: serverURLString), let host = url.host { return host }
        return serverURLString
    }

    /// Host name shown as the smaller subtitle.
    var displaySubtitle: String {
        if let url = URL(string: serverURLString), let host = url.host { return host }
        return serverURLString
    }
}
