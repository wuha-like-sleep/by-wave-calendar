// AppState.swift
// Global app state. Holds server config + auth tokens + current user.
//
// On launch we try to restore from Keychain + UserDefaults. If both
// (serverUrl, refreshToken) exist we attempt a silent refresh; success
// → CalendarView. Failure → SetupView (user re-pairs).
//
// Token strategy mirrors the server's design:
//   - refresh token: long-lived opaque string (`bwd_...`), stored in
//     Keychain so it survives app restarts but not device wipes.
//   - access token: short-lived JWT (~1h), kept only in memory. Re-
//     issued via /api/v1/auth/refresh whenever it's stale or 401.

import Foundation
import Combine
import SwiftUI

// Theme override the user picks in Settings. Defaulting to .system lets
// iOS Settings → Display & Brightness drive everything; the other two
// force a specific scheme. Stored in UserDefaults as the raw String.
enum AppearanceMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark
    var id: String { rawValue }

    /// Maps to SwiftUI's preferredColorScheme. `.system` → nil = let
    /// the OS decide. The other two pin the scheme regardless of OS.
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
    // Published state observed by SwiftUI views.
    @Published var serverURL: URL?
    @Published var isSignedIn: Bool = false
    @Published var currentUserEmail: String?
    @Published var currentUserName: String?
    @Published var isBootstrapping: Bool = true

    // In-memory access token + expiry. Never persisted; we always have a
    // refresh token in Keychain so a fresh access token is one HTTP away.
    private(set) var accessToken: String?
    private var accessTokenExpiresAt: Date?

    // Server-driven theme accent. Fetched from /api/v1/health/app on
    // bootstrap so APP branding matches the web (admin can pick
    // indigo / emerald / rose / etc. and both surfaces sync). Default
    // matches the app icon's purple so cold-launch before fetch still
    // looks right. Persisted to UserDefaults so the next launch is
    // instantly themed without waiting for the network round-trip.
    @Published var themeAccentHex: String = UserDefaults.standard.string(forKey: "bwc.themeAccent") ?? "#4F46E5"
    var themeAccent: Color {
        Color(hex: themeAccentHex) ?? Color(red: 79/255, green: 70/255, blue: 229/255)
    }

    private static let serverURLKey = "bwc.serverURL"
    private static let userEmailKey = "bwc.userEmail"
    private static let userNameKey = "bwc.userName"
    private static let hiddenCalsKey = "bwc.hiddenCalendarIds"
    private static let appearanceKey = "bwc.appearance"

    // User-chosen appearance override. `.system` follows iOS Settings →
    // Display & Brightness; `.light` / `.dark` force regardless. Bound
    // to the root view via .preferredColorScheme. Persisted across
    // launches so user doesn't see a flash on cold start.
    @Published var appearance: AppearanceMode = AppearanceMode(rawValue:
        UserDefaults.standard.string(forKey: "bwc.appearance") ?? ""
    ) ?? .system {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: Self.appearanceKey) }
    }

    // Calendars the user has chosen to hide from the visible event list.
    // Persisted across launches. Empty set = show everything.
    @Published var hiddenCalendarIds: Set<String> = Set(
        UserDefaults.standard.stringArray(forKey: "bwc.hiddenCalendarIds") ?? []
    ) {
        didSet {
            UserDefaults.standard.set(Array(hiddenCalendarIds), forKey: Self.hiddenCalsKey)
        }
    }

    // Helper: filter an event list to only visible calendars.
    func visibleEvents(_ events: [EventDTO]) -> [EventDTO] {
        if hiddenCalendarIds.isEmpty { return events }
        return events.filter { !hiddenCalendarIds.contains($0.calendarId) }
    }

    init() {
        Task { await bootstrap() }
    }

    // Try to restore the previous session. Called once at launch.
    func bootstrap() async {
        defer { isBootstrapping = false }
        if let urlString = UserDefaults.standard.string(forKey: Self.serverURLKey),
           let url = URL(string: urlString)
        {
            self.serverURL = url
            self.currentUserEmail = UserDefaults.standard.string(forKey: Self.userEmailKey)
            self.currentUserName = UserDefaults.standard.string(forKey: Self.userNameKey)
            // Try to refresh access token silently.
            if let _ = Keychain.read(.refreshToken) {
                do {
                    try await refreshIfNeeded(force: true)
                    self.isSignedIn = true
                } catch {
                    // Refresh failed — token revoked / network down. User
                    // sees SetupView; they can re-scan a new pairing QR.
                    self.isSignedIn = false
                }
            }
            // Fire-and-forget theme fetch — no auth needed, low risk if
            // it fails (we just keep the cached hex from last launch).
            Task { await self.refreshThemeFromServer() }
        }
    }

    /// Pull /api/v1/health/app and update themeAccentHex. Cheap, anonymous,
    /// 30/min rate limited. Failures are silent — APP keeps using cache.
    func refreshThemeFromServer() async {
        guard let serverURL else { return }
        guard let url = URL(string: serverURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/v1/health/app") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            // Server v1 envelope wraps as { ok, data: {...} }; older
            // versions returned the body directly. Handle both.
            let outer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let payload = (outer["data"] as? [String: Any]) ?? outer
            if let accent = payload["themeAccent"] as? String, !accent.isEmpty {
                self.themeAccentHex = accent
                UserDefaults.standard.set(accent, forKey: "bwc.themeAccent")
            }
        } catch {
            // Network blip — keep last cached value.
        }
    }

    // Called by PairingService after a successful claim. Persists tokens
    // + flips the app into "signed in" mode.
    func completePairing(serverURL: URL, refreshToken: String, accessToken: String, accessTokenExpiresAt: Date, userEmail: String?, userName: String?) {
        self.serverURL = serverURL
        UserDefaults.standard.set(serverURL.absoluteString, forKey: Self.serverURLKey)
        Keychain.write(.refreshToken, value: refreshToken)
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.currentUserEmail = userEmail
        self.currentUserName = userName
        if let userEmail { UserDefaults.standard.set(userEmail, forKey: Self.userEmailKey) }
        if let userName { UserDefaults.standard.set(userName, forKey: Self.userNameKey) }
        self.isSignedIn = true
    }

    // Sign out: clear tokens. We don't tell the server (no /devices/me
    // revoke from inside the app yet — user can revoke from the web).
    func signOut() {
        Keychain.delete(.refreshToken)
        UserDefaults.standard.removeObject(forKey: Self.userEmailKey)
        UserDefaults.standard.removeObject(forKey: Self.userNameKey)
        accessToken = nil
        accessTokenExpiresAt = nil
        currentUserEmail = nil
        currentUserName = nil
        isSignedIn = false
        // Clear local caches so the next signed-in user doesn't inherit:
        // - event cache JSON (no event data lingers on disk)
        // - EventKit mirror (the user might be a different account)
        // - pending local notifications (would alert for events that
        //   belong to the previous account)
        EventCache.shared.clearAll()
        EventKitMirror.shared.tearDown()
        Task { await LocalNotifications.shared.clearAll() }
    }

    // Returns a non-expired access token, refreshing from refresh token
    // when needed. Throws if no refresh token is available or refresh
    // itself fails (e.g. token revoked server-side).
    func currentAccessToken() async throws -> String {
        try await refreshIfNeeded(force: false)
        guard let token = accessToken else {
            throw APIError.notSignedIn
        }
        return token
    }

    // Marks the current access token as invalid (e.g. server returned 401)
    // so the next call refreshes. Used by APIClient's 401 retry path.
    func invalidateAccessToken() {
        accessToken = nil
        accessTokenExpiresAt = nil
    }

    // Internal: hits /api/v1/auth/refresh. Throws on failure.
    private func refreshIfNeeded(force: Bool) async throws {
        // Skip if we have a token good for at least 5 more minutes.
        if !force,
           let exp = accessTokenExpiresAt,
           exp.timeIntervalSinceNow > 300
        {
            return
        }
        guard let serverURL else { throw APIError.notSignedIn }
        guard let refresh = Keychain.read(.refreshToken) else { throw APIError.notSignedIn }
        var req = URLRequest(url: serverURL.appendingPathComponent("/api/v1/auth/refresh"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["refreshToken": refresh])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.refreshFailed(status: (resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        // Server envelope: routes might return raw {accessToken,...} or
        // {data: {accessToken,...}}. Try both shapes.
        let outer = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let payload = (outer["data"] as? [String: Any]) ?? outer
        guard let accessToken = payload["accessToken"] as? String,
              let expIso = payload["accessTokenExpiresAt"] as? String,
              let exp = ISO8601DateFormatter().date(from: expIso)
        else {
            throw APIError.refreshFailed(status: 200)
        }
        self.accessToken = accessToken
        self.accessTokenExpiresAt = exp
    }
}
