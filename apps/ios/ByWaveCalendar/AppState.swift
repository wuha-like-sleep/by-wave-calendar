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

    private static let serverURLKey = "bwc.serverURL"
    private static let userEmailKey = "bwc.userEmail"
    private static let userNameKey = "bwc.userName"

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
