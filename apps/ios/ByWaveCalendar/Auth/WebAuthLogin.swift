// WebAuthLogin.swift
// ASWebAuthenticationSession-based login flow — used when the user has
// Passkey, MFA, or SSO enabled (where typing email+password in the
// native form doesn't work).
//
// Flow:
//   1. Open ASWebAuthenticationSession to https://server/app/auth/native?state=<uuid>
//   2. User logs in via WHATEVER method (password, passkey, MFA, SSO)
//   3. Server mints a one-time pairing code, redirects to bywave://auth/complete?code=…&state=…
//   4. iOS catches the URL, we extract the code, call existing pair-claim
//   5. Caller gets back the same ClaimResponse it would get from QR scanning

import Foundation
import AuthenticationServices

enum WebAuthError: Error, LocalizedError {
    case userCancelled
    case missingCode
    case stateMismatch
    case underlying(Error)
    var errorDescription: String? {
        switch self {
        case .userCancelled: return "已取消"
        case .missingCode: return "服务器没有返回配对码"
        case .stateMismatch: return "状态不匹配 — 可能被中间人篡改了，请重试"
        case .underlying(let e): return e.localizedDescription
        }
    }
}

@MainActor
final class WebAuthLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    // Custom URL scheme registered in the APP's Info.plist. The server
    // honors this when redirecting on auth success. Keep in sync with
    // INFOPLIST_KEY_CFBundleURLTypes in project.pbxproj.
    private static let urlScheme = "bywave"

    // Singleton so the session's presentation context survives for the
    // lifetime of the auth flow.
    private static let shared = WebAuthLogin()

    private var session: ASWebAuthenticationSession?

    // Open the web login session and return a pairing code on success.
    // Caller then exchanges the code via PairingService.claim().
    static func start(serverURL: URL) async throws -> String {
        return try await shared.run(serverURL: serverURL)
    }

    private func run(serverURL: URL) async throws -> String {
        // Per-call state token defends against another app intercepting
        // the URL scheme handoff (TOCTOU). Both sides must see the same
        // string; we generate fresh per attempt.
        let state = UUID().uuidString

        var url = serverURL.appendingPathComponent("/app/auth/native")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) ?? URLComponents()
        comps.queryItems = [
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "scheme", value: Self.urlScheme),
        ]
        url = comps.url ?? url

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: Self.urlScheme,
            ) { callbackURL, error in
                if let error = error as? NSError,
                   error.domain == ASWebAuthenticationSessionError.errorDomain,
                   error.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                    continuation.resume(throwing: WebAuthError.userCancelled)
                    return
                }
                if let error {
                    continuation.resume(throwing: WebAuthError.underlying(error))
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: WebAuthError.missingCode)
                    return
                }
                // Parse code + state out of bywave://auth/complete?code=…&state=…
                let parts = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
                let returnedState = parts?.queryItems?.first(where: { $0.name == "state" })?.value
                let code = parts?.queryItems?.first(where: { $0.name == "code" })?.value
                guard let code, !code.isEmpty else {
                    continuation.resume(throwing: WebAuthError.missingCode)
                    return
                }
                if returnedState != state {
                    continuation.resume(throwing: WebAuthError.stateMismatch)
                    return
                }
                continuation.resume(returning: code)
            }
            // Share Safari cookies → user stays signed in if they already
            // are; lighter touch than ephemeral sessions for repeat use.
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            self.session = session
            session.start()
        }
    }

    // ASWebAuthenticationPresentationContextProviding
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Find the active key window. iOS 16+ uses connectedScenes.
        if let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
           let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first {
            return window
        }
        return ASPresentationAnchor()
    }
}
