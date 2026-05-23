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
            return "二维码内容无效，请确认从 ByWave Calendar 网页生成"
        case .invalidServerURL:
            return "服务器地址无效"
        case .server(let s, let code, let msg):
            // Map known server error codes to friendly Chinese text.
            // Falls back to raw HTTP status when the server returns an
            // unknown error code (e.g. proxy 502 / 503).
            switch code {
            case "apps_disabled":
                return "管理员未启用 APP 同步功能。\n请进入网页后台 → 管理 → API & APPs → 「打开 APP 登录」开关后重试。"
            case "invalid_or_expired_code":
                return "配对码已过期或被使用。\n请回到网页 /app/settings#devices 点「绑定新设备」重新生成。"
            case "bad_request":
                return "配对码格式不对。请确认是 6 位字符（字母 + 数字）。"
            default:
                if let msg, !msg.isEmpty { return msg }
                if s == 429 { return "请求太频繁，请等一会再试。" }
                if s == 502 || s == 503 || s == 504 { return "服务器暂时无法响应（HTTP \(s)），稍后重试。" }
                return "服务器错误 (HTTP \(s))\(code.map { " - \($0)" } ?? "")"
            }
        case .network(let e):
            return "网络错误：\(e.localizedDescription)"
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
        let body: [String: Any] = [
            "code": code.uppercased(),
            "label": label,
            "kind": "ios",
            "appVersion": appVersion,
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
