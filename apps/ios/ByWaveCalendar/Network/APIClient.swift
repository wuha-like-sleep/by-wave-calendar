// APIClient.swift
// URLSession wrapper that:
//   - Prepends the server URL from AppState
//   - Adds Authorization: Bearer <jwt> on every request
//   - On 401, transparently refreshes the access token and retries once
//   - Returns parsed JSON or throws APIError
//
// All async (Swift Concurrency). Each call site provides the response
// type so we can let JSONDecoder handle the response.

import Foundation

enum APIError: Error, LocalizedError {
    case notSignedIn
    case server(status: Int, body: String?)
    case decode(Error)
    case network(Error)
    case refreshFailed(status: Int)

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "请先登录"
        case .server(let s, let b): return "服务器错误 \(s) — \(b ?? "")"
        case .decode(let e): return "解析错误：\(e.localizedDescription)"
        case .network(let e): return "网络错误：\(e.localizedDescription)"
        case .refreshFailed(let s): return "令牌刷新失败 (HTTP \(s)) — 请重新登录"
        }
    }
}

@MainActor
final class APIClient {
    let state: AppState

    init(state: AppState) {
        self.state = state
    }

    // GET helper. Path is relative to /api/v1, e.g. "/events?from=...".
    func get<T: Decodable>(_ path: String) async throws -> T {
        try await request(method: "GET", path: path, body: nil)
    }

    func post<T: Decodable>(_ path: String, body: Encodable) async throws -> T {
        let data = try JSONEncoder.iso().encode(AnyEncodable(body))
        return try await request(method: "POST", path: path, body: data)
    }

    func patch<T: Decodable>(_ path: String, body: Encodable) async throws -> T {
        let data = try JSONEncoder.iso().encode(AnyEncodable(body))
        return try await request(method: "PATCH", path: path, body: data)
    }

    // DELETE with no response body — server returns 204. We swallow the
    // empty response. Use this for `/events/:id`.
    func delete(_ path: String) async throws {
        try await requestVoid(method: "DELETE", path: path, body: nil)
    }

    // Same plumbing as request<T> but doesn't expect a JSON body back.
    // Splits out the void path so callers don't need to spell `_ : Void = …`.
    private func requestVoid(method: String, path: String, body: Data?, isRetry: Bool = false) async throws {
        guard let serverURL = state.serverURL else { throw APIError.notSignedIn }
        let token = try await state.currentAccessToken()
        let url = serverURL.appendingPathComponent("/api/v1" + path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        req.timeoutInterval = 15
        let (_, resp): (Data, URLResponse)
        do { (_, resp) = try await URLSession.shared.data(for: req) }
        catch { throw APIError.network(error) }
        guard let http = resp as? HTTPURLResponse else {
            throw APIError.network(NSError(domain: "no-http-response", code: 0))
        }
        if http.statusCode == 401 && !isRetry {
            state.invalidateAccessToken()
            try await requestVoid(method: method, path: path, body: body, isRetry: true)
            return
        }
        if http.statusCode >= 400 {
            throw APIError.server(status: http.statusCode, body: nil)
        }
        // 204 or 200 with empty body — done.
    }

    private func request<T: Decodable>(method: String, path: String, body: Data?, isRetry: Bool = false) async throws -> T {
        guard let serverURL = state.serverURL else { throw APIError.notSignedIn }
        let token = try await state.currentAccessToken()
        let url = serverURL.appendingPathComponent("/api/v1" + path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        // Slightly aggressive timeout — CalDAV-style sync can take longer,
        // but pure JSON endpoints should be sub-second on a healthy server.
        req.timeoutInterval = 15

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.network(error)
        }
        guard let http = resp as? HTTPURLResponse else {
            throw APIError.network(NSError(domain: "no-http-response", code: 0))
        }

        // 401 → invalidate cached token and retry once. If the second try
        // still 401s, the refresh token has been revoked server-side
        // and we let the user fall into the sign-in flow.
        if http.statusCode == 401 && !isRetry {
            state.invalidateAccessToken()
            return try await request(method: method, path: path, body: body, isRetry: true)
        }
        if http.statusCode >= 400 {
            let bodyText = String(data: data, encoding: .utf8)
            throw APIError.server(status: http.statusCode, body: bodyText)
        }

        // Unwrap the {data: ...} envelope when present (the v1 API uses it
        // for most routes; some legacy endpoints still return raw).
        do {
            // Try envelope first.
            if let outer = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let inner = outer["data"] {
                let innerData = try JSONSerialization.data(withJSONObject: inner)
                return try JSONDecoder.iso().decode(T.self, from: innerData)
            }
            return try JSONDecoder.iso().decode(T.self, from: data)
        } catch {
            throw APIError.decode(error)
        }
    }
}

// Type-erased wrapper for Encodable payloads so we can pass any
// concrete type into post(...) without making request() generic over input.
private struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

extension JSONDecoder {
    // ISO8601 with fractional seconds — matches what the server emits
    // for timestamps (e.g. "2026-06-01T10:00:00.000Z").
    static func iso() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            // Try fractional seconds first, fall back to plain.
            let withFrac = ISO8601DateFormatter()
            withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = withFrac.date(from: s) { return d }
            let plain = ISO8601DateFormatter()
            if let d = plain.date(from: s) { return d }
            throw DecodingError.dataCorruptedError(in: try decoder.singleValueContainer(), debugDescription: "Bad date: \(s)")
        }
        return d
    }
}

extension JSONEncoder {
    static func iso() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }
}
