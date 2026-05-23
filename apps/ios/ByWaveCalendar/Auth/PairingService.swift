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
    case server(status: Int, message: String?)
    case network(Error)

    var errorDescription: String? {
        switch self {
        case .malformedQR: return "二维码内容无效，请确认从 ByWave Calendar 网页生成"
        case .invalidServerURL: return "服务器地址无效"
        case .server(let s, let m): return "服务器错误 (HTTP \(s)) \(m ?? "")"
        case .network(let e): return "网络错误：\(e.localizedDescription)"
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
                // Try to parse a JSON error message.
                let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                throw PairingError.server(status: http.statusCode, message: msg)
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
