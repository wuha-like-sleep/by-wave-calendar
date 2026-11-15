// Browser sign-in uses a proof-bound one-time code. The verifier never enters
// the browser or custom-scheme callback and is sent only to the original server.
import Foundation
import AuthenticationServices
import UIKit

enum WebAuthError: Error, LocalizedError {
    case userCancelled, invalidResponse, couldNotStart, expired, insecureServer
    case underlying(Error)
    var errorDescription: String? {
        switch self {
        case .userCancelled: return "已取消".loc
        case .invalidResponse: return "网页登录返回无效，请更新 App 和服务器后重试。".loc
        case .couldNotStart: return "无法打开登录窗口，请返回 App 后重试。".loc
        case .expired: return "网页登录已超时，请重新发起。".loc
        case .insecureServer: return "网页登录需要 HTTPS 服务器地址。".loc
        case .underlying(let error): return error.localizedDescription
        }
    }
}

@MainActor
final class WebAuthLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    private static let shared = WebAuthLogin()
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<WebAuthResult, Error>?
    private var attemptID: UUID?
    private var timeout: Task<Void, Never>?

    static func start(serverURL: URL) async throws -> WebAuthResult {
        try await shared.run(serverURL: serverURL)
    }

    private func finish(_ id: UUID, _ result: Result<WebAuthResult, Error>, cancelSession: Bool = false) {
        guard attemptID == id else { return }
        let pending = continuation
        let oldSession = session
        attemptID = nil; continuation = nil; session = nil
        timeout?.cancel(); timeout = nil
        if cancelSession { oldSession?.cancel() }
        pending?.resume(with: result)
    }

    private func run(serverURL: URL) async throws -> WebAuthResult {
        guard attemptID == nil else { throw WebAuthError.couldNotStart }
        let proof: WebLoginProof
        do { proof = try WebLoginProof(serverURL: serverURL) }
        catch { throw WebAuthError.insecureServer }
        let id = UUID()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(throwing: WebAuthError.userCancelled); return }
                self.attemptID = id
                self.continuation = continuation
                let session = ASWebAuthenticationSession(url: proof.authorizationURL, callbackURLScheme: proof.scheme) { [weak self] url, error in
                    Task { @MainActor in
                        guard let self else { return }
                        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                            self.finish(id, .failure(WebAuthError.userCancelled)); return
                        }
                        if let error { self.finish(id, .failure(WebAuthError.underlying(error))); return }
                        guard let url else { self.finish(id, .failure(WebAuthError.invalidResponse)); return }
                        do { self.finish(id, .success(try proof.consume(url))) }
                        catch WebLoginProofError.cancelled { self.finish(id, .failure(WebAuthError.userCancelled)) }
                        catch WebLoginProofError.expired { self.finish(id, .failure(WebAuthError.expired)) }
                        catch { self.finish(id, .failure(WebAuthError.invalidResponse)) }
                    }
                }
                session.prefersEphemeralWebBrowserSession = false
                session.presentationContextProvider = self
                self.session = session
                guard session.start() else {
                    finish(id, .failure(WebAuthError.couldNotStart)); return
                }
                timeout = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: 600_000_000_000) } catch { return }
                    self?.finish(id, .failure(WebAuthError.expired), cancelSession: true)
                }
            }
        }, onCancel: { [weak self] in
            Task { @MainActor in self?.finish(id, .failure(WebAuthError.userCancelled), cancelSession: true) }
        })
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
           let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first { return window }
        return ASPresentationAnchor()
    }
}
