// AppleSignIn.swift
// "Sign in with Apple" — native auth path (server #67).
//
// Flow (mirrors WebAuthLogin's shape, but the proof is an Apple-signed
// JWT instead of a web-session round-trip):
//   1. ASAuthorizationAppleIDProvider mints a request for .fullName +
//      .email scopes; the system shows the Apple sheet (Face ID / Touch ID).
//   2. On success we get an ASAuthorizationAppleIDCredential carrying an
//      identityToken (RS256 JWT) the server verifies against Apple's JWKS.
//      We NEVER trust anything we read locally as identity — the token is
//      the source of truth; we forward fullName only as first-auth
//      decoration (Apple supplies the name exactly once, on first consent).
//   3. POST <server>/api/v1/auth/apple → server verifies the token, links
//      or creates the account, and mints the SAME token bundle that
//      /auth/login-password returns.
//   4. We decode that into PasswordLoginResponse (reused — the shapes are
//      identical) and hand it to the caller, who persists it via
//      AppState.completePairing exactly like every other login method.
//
// The whole thing is wrapped in an NSObject coordinator because
// ASAuthorizationController talks back through delegate callbacks, not
// async/await. We bridge those callbacks into a CheckedContinuation so
// SetupView can `await AppleSignIn.start(...)` like the other methods.

import Foundation
import AuthenticationServices
import UIKit

/// 「通过 Apple 登录」的结果：要么直接登进去了，要么这个账号开了两步验证、
/// 还要一个验证码。后一种和密码登录遇到两步验证时是同一件事。
enum AppleSignInOutcome {
    case signedIn(PasswordLoginResponse)
    case mfaRequired(mfaToken: String)
}

enum AppleSignInError: Error, LocalizedError {
    /// User dismissed the Apple sheet — handled silently by the caller
    /// (no error banner), same as WebAuthError.userCancelled.
    case userCancelled
    /// Apple returned a credential with no identityToken, or it wasn't
    /// decodable as UTF-8. Shouldn't happen in practice on a real device.
    case missingIdentityToken
    /// The credential we got back wasn't an Apple ID credential (e.g. a
    /// password credential from the shared keychain). We only handle the
    /// Apple ID path here.
    case unexpectedCredential
    /// Server rejected the request. Carries the HTTP status + the server's
    /// `error` slug so the caller can map it to friendly Chinese text.
    case server(status: Int, errorCode: String?, message: String?)
    case network(Error)
    /// 上一次「通过 Apple 登录」还没结束又发起了一次。拒绝这一次，
    /// 上一次照常走完（见 AppleSignIn.run）。调用方静默处理。
    case alreadyInProgress

    var errorDescription: String? {
        switch self {
        case .userCancelled:
            return "已取消".loc
        case .alreadyInProgress:
            return "Apple 登录正在进行，请稍候".loc
        case .missingIdentityToken:
            return "未能从 Apple 获取登录凭证，请重试".loc
        case .unexpectedCredential:
            return "Apple 返回了无法识别的凭证，请重试".loc
        case .server(let status, let code, let msg):
            // Map the documented server error slugs to friendly text.
            switch code {
            case "apple_token_invalid":
                return "Apple 登录凭证无效或已过期，请重试".loc
            case "account_disabled":
                return "账号已停用，请联系管理员".loc
            case "apple_signin_not_configured":
                return "该服务器尚未启用 Apple 登录。\n请管理员在服务器设置 SIWA_CLIENT_IDS 后重试。".loc
            case "apps_disabled":
                return "管理员未启用 APP 同步功能。\n请进入网页后台 → 管理 → API & APPs → 「打开 APP 登录」开关后重试。".loc
            default:
                // 5xx 的 message 只有服务端专门翻译过的那几个码会留到这里（见 exchange 里的
                // serverError 调用）；全局错误处理器那句写死的中文已经丢掉了。
                if let msg, !msg.isEmpty { return msg }
                if let text = APIError.unavailableMessage(status: status) { return text }
                return "Apple 登录失败 (HTTP %lld)".locFormat(status) + (code.map { " - \($0)" } ?? "")
            }
        case .network(let e):
            return "网络错误：%@".locFormat(e.localizedDescription)
        }
    }
}

@MainActor
final class AppleSignIn: NSObject {
    // Singleton so the controller's delegate + presentation context survive
    // for the lifetime of the (async) auth flow — same pattern WebAuthLogin
    // uses to keep its ASWebAuthenticationSession alive.
    private static let shared = AppleSignIn()

    /// The continuation for the in-flight request. Set when start() kicks
    /// off the controller, resumed exactly once from a delegate callback.
    private var continuation: CheckedContinuation<AppleSignInOutcome, Error>?
    /// Server URL captured for the duration of one request so the delegate
    /// callback knows where to POST the identityToken.
    private var serverURL: URL?

    /// Kick off Sign in with Apple against `serverURL` and return the
    /// decoded token bundle on success. Throws AppleSignInError otherwise
    /// (caller treats `.userCancelled` as a silent no-op, like the browser
    /// login path).
    static func start(serverURL: URL) async throws -> AppleSignInOutcome {
        try await shared.run(serverURL: serverURL)
    }

    private func run(serverURL: URL) async throws -> AppleSignInOutcome {
        // 已经有一次在等 Apple 回话了：拒绝这一次，**不许**覆盖 continuation。
        // 以前这里直接覆盖：前一次的 continuation 再也没人 resume，等它的那个登录
        // 永远挂着（按钮一直转圈），而且两次请求的回调会抢同一个 continuation、
        // 同一个 serverURL。单例 + 只有一个槽位，只能一次一个。
        guard continuation == nil else { throw AppleSignInError.alreadyInProgress }
        self.serverURL = serverURL
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            // Request both scopes. fullName + email are only ever delivered
            // on the FIRST authorization for this Apple ID; subsequent
            // sign-ins return nil for both (Apple's privacy model). The
            // server handles that — it stores the name on first sight and
            // keys identity off the verified token's `sub`, not the name.
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    /// Resume the pending continuation exactly once, then clear per-request
    /// state. Guards against double-resume (which would crash) if Apple ever
    /// fires both success + error.
    private func finish(_ result: Result<AppleSignInOutcome, Error>) {
        guard let cont = continuation else { return }
        continuation = nil
        serverURL = nil
        switch result {
        case .success(let resp): cont.resume(returning: resp)
        case .failure(let err): cont.resume(throwing: err)
        }
    }

    /// POST the Apple identityToken to the server and decode the standard
    /// login response. Reuses PasswordLoginResponse (the /auth/apple body is
    /// byte-for-byte identical to /auth/login-password's success shape).
    private func exchange(
        serverURL: URL,
        identityToken: String,
        fullName: String?
    ) async throws -> AppleSignInOutcome {
        var req = URLRequest(url: serverURL.appendingPathComponent("/api/v1/auth/apple"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Body mirrors the documented /auth/apple contract. clientDeviceId is
        // the SAME stable per-install UUID password-login + pair use, so the
        // server dedups this device row instead of growing a duplicate.
        var body: [String: Any] = [
            "identityToken": identityToken,
            "label": PairingService.suggestedLabel(),
            "kind": "ios",
            "appVersion": PairingService.appVersion,
            "clientDeviceId": Keychain.clientDeviceId(),
        ]
        // Only present on first authorization — omit the key entirely when
        // Apple withheld the name (re-auth) so we don't overwrite a name the
        // server already stored with an empty string.
        if let fullName, !fullName.isEmpty {
            body["fullName"] = fullName
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                throw AppleSignInError.network(URLError(.badServerResponse))
            }
            if http.statusCode != 200 {
                // 这条路上建号 / 建设备失败也回 5xx，但服务端那几句是按请求语言翻译过的，
                // 而且说清了下一步（比如「这个邮箱已有账号」），留着。其余 5xx 的 message 丢掉。
                let (code, msg) = APIError.serverError(
                    data, status: http.statusCode,
                    keeping: ["account_create_failed", "device_create_failed"],
                )
                throw AppleSignInError.server(status: http.statusCode, errorCode: code, message: msg)
            }
            // Accept both {accessToken,...} and {data:{accessToken,...}} —
            // matches PairingService.claim's defensive unwrap.
            let outer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let payload = (outer["data"] as? [String: Any]) ?? outer
            // 账号开了两步验证：服务端不发令牌，先要验证码。和密码登录是同一个形状，
            // 交给 SetupView 用同一个验证码输入框接着走 /auth/login-mfa-verify。
            // 以前这里直接按「登录成功」去解码 —— 服务端一旦开始要求两步验证，
            // 用户看到的会是一个解码失败的报错，而不是验证码输入框。
            if let pending = payload["mfaPending"] as? Bool, pending,
               let mfaToken = payload["mfaToken"] as? String {
                return .mfaRequired(mfaToken: mfaToken)
            }
            let payloadData = try JSONSerialization.data(withJSONObject: payload)
            return .signedIn(try JSONDecoder().decode(PasswordLoginResponse.self, from: payloadData))
        } catch let e as AppleSignInError {
            throw e
        } catch {
            throw AppleSignInError.network(error)
        }
    }
}

// MARK: - ASAuthorizationControllerDelegate

extension AppleSignIn: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        // Hop to the main actor — this delegate is nonisolated to satisfy
        // the protocol, but all our state (continuation, serverURL) lives
        // on @MainActor.
        Task { @MainActor in
            guard let serverURL = self.serverURL else {
                self.finish(.failure(AppleSignInError.userCancelled))
                return
            }
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                self.finish(.failure(AppleSignInError.unexpectedCredential))
                return
            }
            // identityToken is the Apple-signed JWT (Data) — the server
            // verifies it against Apple's JWKS. Convert to the base64 JWT
            // string the contract expects.
            guard let tokenData = credential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8),
                  !identityToken.isEmpty
            else {
                self.finish(.failure(AppleSignInError.missingIdentityToken))
                return
            }
            // fullName arrives as PersonNameComponents ONLY on first auth.
            // Flatten to "given family" (trimmed) for the optional fullName
            // field; nil on re-auth where Apple withholds it.
            let fullName = Self.flatten(credential.fullName)

            do {
                let resp = try await self.exchange(
                    serverURL: serverURL,
                    identityToken: identityToken,
                    fullName: fullName,
                )
                self.finish(.success(resp))
            } catch {
                self.finish(.failure(error))
            }
        }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        Task { @MainActor in
            // Map Apple's cancel code to our silent .userCancelled so the
            // caller doesn't show an error banner when the user just tapped
            // "Cancel" on the sheet.
            if let authError = error as? ASAuthorizationError,
               authError.code == .canceled {
                self.finish(.failure(AppleSignInError.userCancelled))
                return
            }
            self.finish(.failure(AppleSignInError.network(error)))
        }
    }

    /// Flatten PersonNameComponents → "given family". Returns nil when both
    /// parts are missing (re-auth, where Apple sends an empty components
    /// object) so we omit the field rather than send a blank name.
    private static func flatten(_ components: PersonNameComponents?) -> String? {
        guard let components else { return nil }
        let parts = [components.givenName, components.familyName]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " ")
    }
}

// MARK: - ASAuthorizationControllerPresentationContextProviding

extension AppleSignIn: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(
        for controller: ASAuthorizationController
    ) -> ASPresentationAnchor {
        // Same active-key-window lookup WebAuthLogin uses. MainActor.assumeIsolated
        // is safe — UIKit only calls this on the main thread.
        MainActor.assumeIsolated {
            if let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }),
               let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first {
                return window
            }
            return ASPresentationAnchor()
        }
    }
}
