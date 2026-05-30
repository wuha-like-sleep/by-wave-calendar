// PairingService.swift
// Handles the QR-scan / manual-code pairing flow.
//
// Steps:
//   1. Scanner decodes a QR → returns a JSON payload {v:1, url, code}.
//   2. Caller hits PairingService.claim() with that payload.
//   3. We POST /api/v1/devices/pair-claim → server returns refresh +
//      access tokens.
//   4. We hand back to AppState.completePairing which persists tokens.

import Foundation
import UIKit

struct PairingPayload: Decodable {
    let v: Int
    let url: String
    let code: String
}

struct ClaimResponse: Decodable {
    let accessToken: String
    let accessTokenExpiresAt: String
    let refreshToken: String
    let deviceId: String
    let userId: String
    // Server v0.8.1+ includes these; older servers don't, hence optional.
    // SetupView passes them to AppState.completePairing so the SettingsView
    // can show 邮箱 / 昵称 right after scanning (instead of "—").
    let userEmail: String?
    let userName: String?
}

// Server envelope wrapper (some endpoints return data directly, others wrap).
private struct EnvelopeOr<T: Decodable>: Decodable {
    let data: T?
    let direct: T?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        if let d = try? c.decode(T.self, forKey: AnyKey(stringValue: "data")!) {
            data = d; direct = nil
        } else {
            data = nil
            direct = try T(from: decoder)
        }
    }
    var unwrap: T { data ?? direct! }
    private struct AnyKey: CodingKey {
        var stringValue: String
        init?(stringValue: String) { self.stringValue = stringValue }
        var intValue: Int? { nil }
        init?(intValue: Int) { return nil }
    }
}

enum PairingError: Error, LocalizedError {
    case malformedQR
    case invalidServerURL
    case server(status: Int, errorCode: String?, message: String?)
    case network(Error)

    var errorDescription: String? {
        switch self {
        case .malformedQR:
            return "二维码内容无效，请确认从 ByWave Calendar 网页生成".loc
        case .invalidServerURL:
            return "服务器地址无效".loc
        case .server(let s, let code, let msg):
            // Map known server error codes to friendly localized text.
            // Falls back to raw HTTP status when the server returns an
            // unknown error code (e.g. proxy 502 / 503).
            switch code {
            case "apps_disabled":
                return "管理员未启用 APP 同步功能。\n请进入网页后台 → 管理 → API & APPs → 「打开 APP 登录」开关后重试。".loc
            case "invalid_or_expired_code":
                return "配对码已过期或被使用。\n请回到网页 /app/settings#devices 点「绑定新设备」重新生成。".loc
            case "bad_request":
                return "配对码格式不对。请确认是 6 位字符（字母 + 数字）。".loc
            case "csrf_invalid":
                // Shouldn't reach the APP under v0.7.4+ — exempt list now
                // includes pair-claim / login-password / refresh. If this
                // still fires, the server is on an older build that
                // hasn't pulled the fix.
                return "服务器需要升级到 v0.7.4 或更高版本。\n（旧版本的 CSRF 防护误拦了 APP 请求。）".loc
            default:
                if let msg, !msg.isEmpty { return msg }
                if s == 429 { return "请求太频繁，请等一会再试。".loc }
                if s == 502 || s == 503 || s == 504 { return "服务器暂时无法响应（HTTP %lld），稍后重试。".locFormat(s) }
                return "服务器错误 (HTTP %lld)".locFormat(s) + (code.map { " - \($0)" } ?? "")
            }
        case .network(let e):
            return "网络错误：%@".locFormat(e.localizedDescription)
        }
    }
}

enum PairingService {
    // Parse the scanner's raw string. Either JSON (preferred) or a bare
    // 6-char code (manual fallback — caller supplies serverURL separately).
    static func parseScanned(_ raw: String) -> PairingPayload? {
        guard let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(PairingPayload.self, from: data)
    }

    static func claim(serverURL: URL, code: String, label: String, appVersion: String) async throws -> ClaimResponse {
        var req = URLRequest(url: serverURL.appendingPathComponent("/api/v1/devices/pair-claim"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // clientDeviceId is the stable per-Apple-ID UUID (iCloud Keychain).
        // The server uses it to dedup — re-pairing from the same physical
        // device updates the existing row instead of growing a duplicate.
        let body: [String: Any] = [
            "code": code.uppercased(),
            "label": label,
            "kind": "ios",
            "appVersion": appVersion,
            "clientDeviceId": Keychain.clientDeviceId(),
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                throw PairingError.network(NSError(domain: "no-http-response", code: 0))
            }
            if http.statusCode != 200 {
                // Parse the server's standard error envelope:
                //   { error: "code_slug", message: "可选中文文案" }
                // Both fields are optional; we pass them through to
                // PairingError.server which decides on a friendly text.
                let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                let code = body["error"] as? String
                let msg = body["message"] as? String
                throw PairingError.server(status: http.statusCode, errorCode: code, message: msg)
            }
            // Both shapes: {accessToken, ...} or {data: {accessToken, ...}}
            let outer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let payload = (outer["data"] as? [String: Any]) ?? outer
            let payloadData = try JSONSerialization.data(withJSONObject: payload)
            return try JSONDecoder().decode(ClaimResponse.self, from: payloadData)
        } catch let e as PairingError {
            throw e
        } catch {
            throw PairingError.network(error)
        }
    }

    /// Try to resolve a host the user typed (e.g. "calendar.example.com" or
    /// "192.168.1.100:8080") into a working URL by probing both schemes.
    /// Behavior:
    ///   - If the input already starts with `https://` or `http://`, return it as-is.
    ///   - Otherwise ping `/api/v1/health/app` over https first; on
    ///     connection / SSL failure, fall back to http.
    ///   - Cached: once we find a working scheme for a host, remember
    ///     it in UserDefaults so subsequent sign-ins don't pay the
    ///     2× probe latency.
    /// Returns nil only when both schemes fail to respond at all.
    static func probeServerURL(_ input: String) async -> URL? {
        var raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        // Strip trailing slash to keep the cache key stable.
        while raw.hasSuffix("/") { raw.removeLast() }

        // Explicit scheme → trust the user, no probe needed.
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
            return URL(string: raw)
        }

        // Check cache — if we successfully resolved this host before,
        // reuse that scheme. Avoids re-probing on every sign-in.
        let cacheKey = "bwc.schemeCache.\(raw.lowercased())"
        if let cached = UserDefaults.standard.string(forKey: cacheKey),
           let cachedURL = URL(string: cached)
        {
            return cachedURL
        }

        // Probe order: https first (better security default), then http.
        // Both use the cheap public health endpoint with a short timeout.
        for scheme in ["https", "http"] {
            let candidate = "\(scheme)://\(raw)"
            guard let url = URL(string: candidate) else { continue }
            if await reachable(url) {
                UserDefaults.standard.set(candidate, forKey: cacheKey)
                return url
            }
        }
        return nil
    }

    /// Light probe — calls /api/v1/health/app with a 5-second timeout
    /// and accepts any 2xx response. Failures (connection refused,
    /// SSL handshake, timeout) all return false.
    private static func reachable(_ baseURL: URL) async -> Bool {
        var req = URLRequest(url: baseURL.appendingPathComponent("/api/v1/health/app"))
        req.timeoutInterval = 5
        req.httpMethod = "GET"
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
        } catch {
            return false
        }
    }

    // Convenience label like "Henrik 的 iPhone 15 Pro" for the device list.
    static func suggestedLabel() -> String {
        let device = UIDevice.current
        // Note: as of iOS 16, name is the user's generic device name ("iPhone")
        // unless they have entitlements to read the personalized name.
        return "\(device.name) (\(device.model))"
    }

    static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }
}
