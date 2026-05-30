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
        case .notSignedIn: return "请先登录".loc
        case .server(let s, let b): return "服务器错误 %lld — %@".locFormat(s, b ?? "")
        case .decode(let e): return "解析错误：%@".locFormat(e.localizedDescription)
        case .network(let e): return "网络错误：%@".locFormat(e.localizedDescription)
        case .refreshFailed(let s): return "令牌刷新失败 (HTTP %lld) — 请重新登录".locFormat(s)
        }
    }
}

@MainActor
final class APIClient {
    let state: AppState

    init(state: AppState) {
        self.state = state
    }

    // Build a final URL from the server origin + caller path. Caller
    // paths look like "/events" or "/events?from=...&to=...".
    //
    // We can't use URL.appendingPathComponent here — Foundation
    // percent-escapes `?` (treats it as a path segment character),
    // which turns "/events?from=X" into "/events%3Ffrom=X" and the
    // server route doesn't match → 404 not_found. That was the cause
    // of the first-screen "服务器错误 404 — not_found" right after
    // sign-in (the calendar view immediately hits /events?from=…&to=…).
    //
    // Instead we build the URL by string concat and re-parse — query
    // string values were already percent-encoded by the caller (see
    // CalendarView's load()), so URL(string:) succeeds cleanly.
    static func makeURL(server: URL, path: String) -> URL? {
        // Strip any trailing slash on the server origin so the joined
        // URL has exactly one slash between "calendar.example.com" and "/api".
        var base = server.absoluteString
        if base.hasSuffix("/") { base.removeLast() }
        let joined = base + "/api/v1" + (path.hasPrefix("/") ? path : "/" + path)
        return URL(string: joined)
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
        guard let url = Self.makeURL(server: serverURL, path: path) else {
            throw APIError.network(NSError(domain: "bad-url", code: 0))
        }
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
        guard let url = Self.makeURL(server: serverURL, path: path) else {
            throw APIError.network(NSError(domain: "bad-url", code: 0))
        }
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

// MARK: - Booking links (预约链接)
//
// Owner management of /api/v1/booking-links. Same envelope-unwrapping
// generic plumbing as the calendar/share calls above — the server wraps
// each row in { ok, data } and APIClient.request peels off `data` for us
// so these decode straight to BookingLink / [BookingLink].
extension APIClient {
    // GET /booking-links → the signed-in user's links.
    func listBookingLinks() async throws -> [BookingLink] {
        try await get("/booking-links")
    }

    // POST /booking-links → the inserted row.
    func createBookingLink(_ input: BookingLinkCreateInput) async throws -> BookingLink {
        try await post("/booking-links", body: input)
    }

    // PATCH /booking-links/:id → the updated row. Pass any subset of
    // fields; nil entries are dropped by JSONEncoder so a one-field
    // patch (e.g. just `enabled`) is the whole body.
    func updateBookingLink(id: String, _ input: BookingLinkUpdateInput) async throws -> BookingLink {
        try await patch("/booking-links/\(id)", body: input)
    }

    // Convenience for the per-row enabled/paused toggle.
    @discardableResult
    func setBookingLinkEnabled(id: String, enabled: Bool) async throws -> BookingLink {
        try await updateBookingLink(id: id, BookingLinkUpdateInput(
            slug: nil, title: nil, description: nil, calendarId: nil,
            durationMinutes: nil, minNoticeHours: nil, maxDaysAhead: nil,
            bufferBeforeMin: nil, bufferAfterMin: nil, enabled: enabled, notifyEmail: nil,
        ))
    }

    // DELETE /booking-links/:id. Server returns { ok: true } (200) rather
    // than 204, but the void DELETE helper swallows any 2xx body.
    func deleteBookingLink(id: String) async throws {
        try await delete("/booking-links/\(id)")
    }

    // GET /booking-links/:id/bookings → bookings made against a link.
    func listBookings(forLinkId id: String) async throws -> [Booking] {
        try await get("/booking-links/\(id)/bookings")
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
