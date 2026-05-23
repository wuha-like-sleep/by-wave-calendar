// AppState.swift
// Global state, refactored in v0.10.0 to support multiple signed-in
// profiles (Google-style account switcher).
//
// One Profile == one signed-in account on one server. Each Profile has
// its own Keychain-stored refresh token (scoped by Profile.id), its own
// EventCache namespace, and its own email / display name. The active
// profile is the one currently driving the UI; switching profiles is a
// matter of re-pointing `activeProfileId` and reloading.
//
// Legacy compat: builds before v0.10.0 stored everything under unscoped
// keys (bwc.serverURL, bwc.refreshToken, bwc.userEmail). On first launch
// of v0.10.0 we migrate those into a single Profile so the existing
// signed-in user isn't kicked out.

import Foundation
import Combine
import SwiftUI

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark
    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var label: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }
}

@MainActor
final class AppState: ObservableObject {
    // MARK: - Published state

    /// All profiles the user has ever added (signed-in OR signed-out).
    /// Sorted by most-recently-used first when shown in the switcher.
    @Published var profiles: [Profile] = []
    /// Currently driving the UI. Nil means SetupView gets shown.
    @Published var activeProfileId: String?

    /// True while bootstrap is in flight (silent refresh attempt). UI
    /// shows the splash overlay while this is true.
    @Published var isBootstrapping: Bool = true

    /// True when the active profile has a working refresh + access
    /// token. Drives Setup ↔ Calendar branching in RootView.
    @Published var isSignedIn: Bool = false

    /// User-chosen appearance override (跟随系统 / 浅色 / 深色). Cross-
    /// profile setting — persisted globally, not per profile.
    @Published var appearance: AppearanceMode = AppearanceMode(rawValue:
        UserDefaults.standard.string(forKey: "bwc.appearance") ?? ""
    ) ?? .system {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: Self.appearanceKey) }
    }

    /// Brand accent for the current profile. Mirrored from
    /// activeProfile.themeAccentHex; falls back to brand purple. Kept
    /// as @Published so the .tint modifier at the root re-renders
    /// when the user switches profile or server admin updates the
    /// palette.
    @Published var themeAccentHex: String = UserDefaults.standard.string(forKey: "bwc.themeAccent") ?? "#4F46E5"
    var themeAccent: Color {
        Color(hex: themeAccentHex) ?? Color(red: 79/255, green: 70/255, blue: 229/255)
    }

    /// Backwards-compat: what server version are we talking to, and
    /// which iOS-facing features does it support. Refreshed alongside
    /// the theme on every bootstrap + profile switch. Defaults to
    /// .unknown which optimistically enables every feature (so a brand
    /// new server we haven't probed yet doesn't get UI hidden).
    @Published var serverCapabilities: ServerCapabilities = .unknown

    /// Hidden calendar IDs — cross-profile to match legacy behavior.
    /// Could become per-profile in a future refactor but most users
    /// only have one server, so global is fine for now.
    @Published var hiddenCalendarIds: Set<String> = Set(
        UserDefaults.standard.stringArray(forKey: "bwc.hiddenCalendarIds") ?? []
    ) {
        didSet {
            UserDefaults.standard.set(Array(hiddenCalendarIds), forKey: Self.hiddenCalsKey)
        }
    }

    // MARK: - Access token (in-memory only)

    /// Per-active-profile access JWT + expiry. Wiped on profile switch
    /// so the next API call refreshes from the new profile's refresh
    /// token. Never persisted.
    private(set) var accessToken: String?
    private var accessTokenExpiresAt: Date?

    // MARK: - UserDefaults keys

    private static let profilesKey = "bwc.profiles"
    private static let activeProfileKey = "bwc.activeProfileId"
    private static let appearanceKey = "bwc.appearance"
    private static let hiddenCalsKey = "bwc.hiddenCalendarIds"
    // Legacy keys from pre-multi-account builds — only read for migration.
    private static let legacyServerURLKey = "bwc.serverURL"
    private static let legacyUserEmailKey = "bwc.userEmail"
    private static let legacyUserNameKey = "bwc.userName"

    // MARK: - Convenience accessors (active profile)

    /// Active profile's server URL. Read by every API call.
    var serverURL: URL? { activeProfile?.serverURL }
    var currentUserEmail: String? { activeProfile?.userEmail }
    var currentUserName: String? { activeProfile?.userName }
    var activeProfile: Profile? {
        guard let id = activeProfileId else { return nil }
        return profiles.first(where: { $0.id == id })
    }

    func visibleEvents(_ events: [EventDTO]) -> [EventDTO] {
        if hiddenCalendarIds.isEmpty { return events }
        return events.filter { !hiddenCalendarIds.contains($0.calendarId) }
    }

    // MARK: - Bootstrap

    init() {
        loadProfiles()
        Task { await bootstrap() }
    }

    /// Read persisted profiles + migrate legacy single-profile state
    /// from older versions.
    private func loadProfiles() {
        if let data = UserDefaults.standard.data(forKey: Self.profilesKey),
           let decoded = try? JSONDecoder.iso().decode([Profile].self, from: data)
        {
            profiles = decoded
        }
        activeProfileId = UserDefaults.standard.string(forKey: Self.activeProfileKey)

        // Migration: if no profiles yet but the legacy bwc.serverURL +
        // bwc.refreshToken are present, lift them into a single profile.
        if profiles.isEmpty,
           let urlStr = UserDefaults.standard.string(forKey: Self.legacyServerURLKey),
           let legacyToken = Keychain.read(.legacyRefreshToken)
        {
            let id = UUID().uuidString
            let migrated = Profile(
                id: id,
                serverURLString: urlStr,
                userEmail: UserDefaults.standard.string(forKey: Self.legacyUserEmailKey),
                userName: UserDefaults.standard.string(forKey: Self.legacyUserNameKey),
                themeAccentHex: UserDefaults.standard.string(forKey: "bwc.themeAccent"),
                lastUsedAt: Date(),
            )
            // Move the refresh token to the scoped key, then nuke legacy.
            Keychain.write(.refreshToken(profileId: id), value: legacyToken)
            Keychain.delete(.legacyRefreshToken)
            UserDefaults.standard.removeObject(forKey: Self.legacyServerURLKey)
            UserDefaults.standard.removeObject(forKey: Self.legacyUserEmailKey)
            UserDefaults.standard.removeObject(forKey: Self.legacyUserNameKey)

            profiles = [migrated]
            activeProfileId = id
            persistProfiles()
        }

        // Validate active id — if it points to a deleted profile, snap
        // to the most-recent surviving one (or nil if none).
        if let id = activeProfileId, !profiles.contains(where: { $0.id == id }) {
            activeProfileId = profiles.sorted(by: { $0.lastUsedAt > $1.lastUsedAt }).first?.id
        }

        // If we have profiles but no active selection, pick the most
        // recent one.
        if activeProfileId == nil, let mostRecent = profiles.sorted(by: { $0.lastUsedAt > $1.lastUsedAt }).first {
            activeProfileId = mostRecent.id
        }

        // Sync accent hex from active profile (if it has one).
        if let accent = activeProfile?.themeAccentHex, !accent.isEmpty {
            themeAccentHex = accent
        }
    }

    /// Try to silently refresh the active profile's access token. Called
    /// once at launch.
    func bootstrap() async {
        defer { isBootstrapping = false }
        guard let activeId = activeProfileId else {
            isSignedIn = false
            return
        }
        // Probe for the refresh token under this profile's scope.
        guard Keychain.read(.refreshToken(profileId: activeId)) != nil else {
            isSignedIn = false
            return
        }
        do {
            try await refreshIfNeeded(force: true)
            isSignedIn = true
        } catch {
            // Refresh failed — token revoked / network down. User sees
            // SetupView (since there's no signed-in profile right now).
            isSignedIn = false
        }
        // Fire-and-forget theme fetch for the active profile.
        Task { await self.refreshThemeFromServer() }
    }

    /// Pull /api/v1/health/app and update the active profile's theme
    /// PLUS the cached `serverCapabilities` so the rest of the APP can
    /// branch on what the server supports. Older servers don't have
    /// /api/v1/health/app — we fall back to the much older /health
    /// (which only returns version + status, no theme).
    func refreshThemeFromServer() async {
        guard let serverURL else { return }
        let base = serverURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        // Try the modern endpoint first (v0.7.4+).
        var payload: [String: Any]?
        if let url = URL(string: base + "/api/v1/health/app") {
            var req = URLRequest(url: url)
            req.timeoutInterval = 8
            if let (data, resp) = try? await URLSession.shared.data(for: req),
               let http = resp as? HTTPURLResponse,
               (200..<300).contains(http.statusCode)
            {
                let outer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                payload = (outer["data"] as? [String: Any]) ?? outer
            }
        }

        // Fall back to /health for older servers. Only gives us version,
        // not theme — accent stays at the previously-cached value.
        if payload == nil, let url = URL(string: base + "/health") {
            var req = URLRequest(url: url)
            req.timeoutInterval = 8
            if let (data, _) = try? await URLSession.shared.data(for: req) {
                payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            }
        }

        guard let payload else { return }

        // Update server version → ServerCapabilities. This branch runs
        // even when only /health responded.
        if let version = payload["version"] as? String, !version.isEmpty {
            serverCapabilities = ServerCapabilities(version: version)
        }

        // Update theme only when the response actually has the field
        // (newer endpoint only).
        if let accent = payload["themeAccent"] as? String, !accent.isEmpty {
            themeAccentHex = accent
            UserDefaults.standard.set(accent, forKey: "bwc.themeAccent")
            if let id = activeProfileId,
               let idx = profiles.firstIndex(where: { $0.id == id })
            {
                profiles[idx].themeAccentHex = accent
                persistProfiles()
            }
        }
    }

    // MARK: - Profile lifecycle

    /// Called by SetupView after a successful pair-claim / login. If a
    /// profile already exists for (serverURL, userEmail), updates it in
    /// place (refreshing the token). Otherwise creates a new profile.
    func completePairing(serverURL: URL, refreshToken: String, accessToken: String, accessTokenExpiresAt: Date, userEmail: String?, userName: String?) {
        // De-dup: same server + same email = same profile.
        let urlStr = serverURL.absoluteString
        let existingIdx = profiles.firstIndex(where: { p in
            p.serverURLString == urlStr && (p.userEmail ?? "") == (userEmail ?? "")
        })
        let profileId: String
        if let idx = existingIdx {
            profileId = profiles[idx].id
            profiles[idx].userEmail = userEmail ?? profiles[idx].userEmail
            profiles[idx].userName = userName ?? profiles[idx].userName
            profiles[idx].lastUsedAt = Date()
        } else {
            let p = Profile(
                id: UUID().uuidString,
                serverURLString: urlStr,
                userEmail: userEmail,
                userName: userName,
                themeAccentHex: nil,
                lastUsedAt: Date(),
            )
            profileId = p.id
            profiles.append(p)
        }
        Keychain.write(.refreshToken(profileId: profileId), value: refreshToken)
        activeProfileId = profileId
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        isSignedIn = true
        persistProfiles()
        Task { await self.refreshThemeFromServer() }
    }

    /// Switch to a previously-added profile. If that profile is signed
    /// out (no refresh token), it shows SetupView pre-filled. Otherwise
    /// it silently refreshes and the calendar loads with new data.
    func switchProfile(to id: String) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        // Clear in-memory token from old profile.
        accessToken = nil
        accessTokenExpiresAt = nil
        activeProfileId = id
        if let idx = profiles.firstIndex(where: { $0.id == id }) {
            profiles[idx].lastUsedAt = Date()
        }
        if let accent = activeProfile?.themeAccentHex {
            themeAccentHex = accent
        }
        persistProfiles()
        // Clear cross-profile caches so the new profile's events don't
        // get mixed with the previous one's.
        Task {
            await LocalNotifications.shared.clearAll()
        }
        EventKitMirror.shared.tearDown()
        // Re-bootstrap to refresh access token + theme for the new profile.
        Task {
            isBootstrapping = true
            await bootstrap()
        }
    }

    /// Soft sign-out: clear refresh token for the active profile but
    /// KEEP the profile entry in the list (so the user can sign back
    /// in without re-typing the host). UI flips to SetupView.
    func signOut() {
        guard let id = activeProfileId else { return }
        Keychain.delete(.refreshToken(profileId: id))
        accessToken = nil
        accessTokenExpiresAt = nil
        isSignedIn = false
        // Clear per-profile EventCache + cross-profile EventKit mirror.
        EventCache.shared.clearAll()
        EventKitMirror.shared.tearDown()
        Task { await LocalNotifications.shared.clearAll() }
        // Stay on the same activeProfileId — SetupView pre-fills its URL.
    }

    /// Hard remove a profile from the list. Used by the switcher's
    /// "remove account" swipe action. Deletes Keychain refresh token
    /// and the on-disk event cache.
    func removeProfile(id: String) {
        Keychain.delete(.refreshToken(profileId: id))
        EventCache.shared.clearForProfile(id)
        profiles.removeAll(where: { $0.id == id })
        // If we removed the active profile, pick another (or go signed-out).
        if activeProfileId == id {
            accessToken = nil
            accessTokenExpiresAt = nil
            activeProfileId = profiles.sorted(by: { $0.lastUsedAt > $1.lastUsedAt }).first?.id
            isSignedIn = activeProfileId != nil
                && Keychain.read(.refreshToken(profileId: activeProfileId!)) != nil
        }
        persistProfiles()
    }

    /// Persist the profiles array + active id to UserDefaults.
    private func persistProfiles() {
        if let data = try? JSONEncoder.iso().encode(profiles) {
            UserDefaults.standard.set(data, forKey: Self.profilesKey)
        }
        UserDefaults.standard.set(activeProfileId, forKey: Self.activeProfileKey)
    }

    // MARK: - Access-token plumbing

    func currentAccessToken() async throws -> String {
        try await refreshIfNeeded(force: false)
        guard let token = accessToken else { throw APIError.notSignedIn }
        return token
    }

    func invalidateAccessToken() {
        accessToken = nil
        accessTokenExpiresAt = nil
    }

    /// Hits /api/v1/auth/refresh using the active profile's refresh token.
    private func refreshIfNeeded(force: Bool) async throws {
        if !force,
           let exp = accessTokenExpiresAt,
           exp.timeIntervalSinceNow > 300
        {
            return
        }
        guard let id = activeProfileId else { throw APIError.notSignedIn }
        guard let serverURL = activeProfile?.serverURL else { throw APIError.notSignedIn }
        guard let refresh = Keychain.read(.refreshToken(profileId: id)) else { throw APIError.notSignedIn }
        var req = URLRequest(url: serverURL.appendingPathComponent("/api/v1/auth/refresh"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["refreshToken": refresh])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.refreshFailed(status: (resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        let outer = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let payload = (outer["data"] as? [String: Any]) ?? outer
        guard let token = payload["accessToken"] as? String,
              let expIso = payload["accessTokenExpiresAt"] as? String,
              let exp = ISO8601DateFormatter().date(from: expIso)
        else {
            throw APIError.refreshFailed(status: 200)
        }
        self.accessToken = token
        self.accessTokenExpiresAt = exp
    }
}

// JSONEncoder.iso() / JSONDecoder.iso() helpers are defined in
// APIClient.swift as internal extensions, so they're already visible
// here. Don't redeclare — that's what caused the v0.10.3 build break.
