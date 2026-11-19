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
    /// 服务端明确吊销了这台设备（改密码 / 重置密码 / 后台移除设备）。
    /// 和「网络不好」必须分开：前者要登出并说清原因，后者应当保持登录、
    /// 继续显示离线缓存。
    case deviceRevoked

    /// 从服务端的错误响应里取出错误码。认两种形状，见 `serverError(_:)`。
    static func serverErrorCode(_ body: String?) -> String? {
        guard let data = body?.data(using: .utf8) else { return nil }
        return serverError(data).code
    }

    /// 从服务端的错误响应里取出错误码和人话。认两种形状：
    /// `{"ok":false,"error":{"code":"…","message":"…"}}`（/api/v1 的信封，App 走的都是这个）
    /// 和 `{"error":"…","message":"…"}`（老的 /api）。
    ///
    /// 以前登录、配对、Apple 登录几处都只认第二种，而 App 请求的全是 /api/v1，
    /// 于是错误码一个也读不到：输错密码显示「登录失败 (HTTP 401)」，账号被锁、
    /// 管理员关了 App 同步、配对码过期，全都退成一个状态码。
    /// 信封在服务端没写 message 时会拿错误码顶上，那种 message 不是人话，这里丢掉。
    static func serverError(_ data: Data) -> (code: String?, message: String?) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return (nil, nil) }
        let code: String?
        var message: String?
        if let e = obj["error"] as? [String: Any] {
            code = e["code"] as? String
            message = e["message"] as? String
        } else {
            code = obj["error"] as? String
            message = obj["message"] as? String
        }
        if let m = message, m.isEmpty || m == code { message = nil }
        return (code, message)
    }

    /// 同上，但只留下**能直接给用户看**的那句话：5xx 的 message 丢掉。
    ///
    /// 服务端出了未预料的错（5xx）时，全局错误处理器回的是一句写死的中文
    /// 「服务器内部错误」，不看请求是什么语言。以前登录、两步验证、扫码配对、
    /// Apple 登录几处都把它原样摊出来，英文、日文用户看到的是一句中文。
    /// 5xx 时调用方改用本地文案，见 `unavailableMessage(status:)`。
    ///
    /// `keeping`：服务端专门按请求语言翻译过、而且话里写着下一步该怎么做的 5xx 码，
    /// 这些码的 message 照旧留着（Apple 登录建号失败：「这个邮箱已有账号」和
    /// 「建号失败」要做的事完全不同，换成「稍后重试」就把人引错了路）。
    static func serverError(_ data: Data, status: Int, keeping localizedCodes: Set<String> = []) -> (code: String?, message: String?) {
        let (code, message) = serverError(data)
        if status >= 500, !localizedCodes.contains(code ?? "") { return (code, nil) }
        return (code, message)
    }

    /// 5xx 时给用户看的那句本地文案；不是 5xx 返回 nil，调用方接着用自己的兜底。
    static func unavailableMessage(status: Int) -> String? {
        status >= 500 ? "服务器暂时无法响应（HTTP %lld），稍后重试。".locFormat(status) : nil
    }

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "请先登录".loc
        // 不要把服务端返回的 body 原样摊给用户——那会显示成
        // 「服务器错误 403 — {"ok":false,"error":{...}}」。
        case .server(let s, let body):
            // 用户刚输的东西不对时，要说清楚是什么不对 —— 以前一律显示
            // 「操作失败，请稍后再试（401）」，输错当前密码的人被告知「稍后再试」。
            // 只认码、按本地语言出文案；不把服务端 body 原样摊给用户。
            switch Self.serverErrorCode(body) {
            case "invalid_credentials": return "密码错误".loc
            case "invalid_code": return "验证码错误".loc
            default: return "操作失败，请稍后再试（%lld）".locFormat(s)
            }
        case .decode: return "数据读取失败，请稍后再试".loc
        case .network: return "网络连接失败，请检查网络后重试".loc
        case .refreshFailed: return "登录已失效，请重新登录".loc
        case .deviceRevoked: return "密码已更改或此设备已被移除，请重新登录".loc
        }
    }
}

@MainActor
final class APIClient {
    let state: AppState
    private let profileID: String?

    init(state: AppState) {
        self.state = state
        self.profileID = state.activeProfileId
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
        guard state.activeProfileId == profileID else { throw CancellationError() }
        guard let serverURL = state.serverURL else { throw APIError.notSignedIn }
        let token = try await state.currentAccessToken()
        guard state.activeProfileId == profileID, !Task.isCancelled else { throw CancellationError() }
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
        guard state.activeProfileId == profileID, !Task.isCancelled else { throw CancellationError() }
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
        guard state.activeProfileId == profileID else { throw CancellationError() }
        guard let serverURL = state.serverURL else { throw APIError.notSignedIn }
        let token = try await state.currentAccessToken()
        guard state.activeProfileId == profileID, !Task.isCancelled else { throw CancellationError() }
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
        guard state.activeProfileId == profileID, !Task.isCancelled else { throw CancellationError() }
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

    /// /events 专用条件请求。带上 If-None-Match 后，窗口内容没变时
    /// 服务端只回 304 空正文，整个窗口的下载与解码都省掉；变了才回
    /// 200 + 新的 ETag。返回 (nil, _) 表示 304——本地缓存即最新。
    /// 鉴权 / 401 重试 / 信封拆包与 request() 同一套口径；单独写一份，
    /// 是因为 request() 不暴露状态码与响应头。cachePolicy 明确绕开
    /// URLCache：条件请求由我们自己发，系统缓存层不要插手（应用自己
    /// 有 EventCache 做离线快照）。
    func getEventsConditional(path: String, ifNoneMatch: String?, isRetry: Bool = false) async throws -> (response: EventsResponse?, etag: String?) {
        guard state.activeProfileId == profileID else { throw CancellationError() }
        guard let serverURL = state.serverURL else { throw APIError.notSignedIn }
        let token = try await state.currentAccessToken()
        guard state.activeProfileId == profileID, !Task.isCancelled else { throw CancellationError() }
        guard let url = Self.makeURL(server: serverURL, path: path) else {
            throw APIError.network(NSError(domain: "bad-url", code: 0))
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let ifNoneMatch { req.setValue(ifNoneMatch, forHTTPHeaderField: "If-None-Match") }
        req.timeoutInterval = 15
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.network(error)
        }
        guard state.activeProfileId == profileID, !Task.isCancelled else { throw CancellationError() }
        guard let http = resp as? HTTPURLResponse else {
            throw APIError.network(NSError(domain: "no-http-response", code: 0))
        }
        if http.statusCode == 401 && !isRetry {
            state.invalidateAccessToken()
            return try await getEventsConditional(path: path, ifNoneMatch: ifNoneMatch, isRetry: true)
        }
        if http.statusCode == 304 {
            return (nil, http.value(forHTTPHeaderField: "ETag") ?? ifNoneMatch)
        }
        if http.statusCode >= 400 {
            throw APIError.server(status: http.statusCode, body: String(data: data, encoding: .utf8))
        }
        let etag = http.value(forHTTPHeaderField: "ETag")
        do {
            if let outer = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let inner = outer["data"] {
                let innerData = try JSONSerialization.data(withJSONObject: inner)
                return (try JSONDecoder.iso().decode(EventsResponse.self, from: innerData), etag)
            }
            return (try JSONDecoder.iso().decode(EventsResponse.self, from: data), etag)
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

// MARK: - 撤销删除 + 自然语言快速新建 (v1.6.2, 对齐 web/Android/桌面)
extension APIClient {
    /// POST /events/:id/restore — un-soft-deletes a just-deleted event.
    /// Server-side this is idempotent, so double-tapping 撤销 is harmless.
    /// Returns the restored row (bare JSON, no envelope).
    @discardableResult
    func restoreEvent(id: String) async throws -> EventDTO {
        try await post("/events/\(id)/restore", body: EmptyJSONBody())
    }

    /// POST /parse-event — the server-shared natural-language parser, so
    /// iOS parses "明天下午3点开会" exactly like web/Android/desktop do.
    /// `now` is the caller's LOCAL wall-clock ("YYYY-MM-DDTHH:mm:ss", no
    /// zone) — the server anchors relative dates ("明天") to it, keeping
    /// results correct regardless of the server's own timezone.
    func parseQuickEvent(text: String, now: String) async throws -> QuickParsedEvent {
        try await post("/parse-event", body: ["text": text, "now": now])
    }
}

// MARK: - ICS 导入 (对齐 web/Android 的两步导入)
extension APIClient {
    /// POST /calendars/:id/import/preview — counts only, the server
    /// writes nothing. Same judgement (and sourceTag) as the real
    /// import, mirroring the web import dialog's first step.
    func previewIcsImport(calendarId: String, text: String, filename: String?) async throws -> IcsImportPreview {
        try await post("/calendars/\(calendarId)/import/preview", body: IcsImportRequest(text: text, filename: filename))
    }

    /// POST /calendars/:id/import — same dedupe semantics as the web
    /// import: uid-keyed upsert, soft-deleted rows stay deleted,
    /// unchanged rows are skipped without touching them.
    func importIcs(calendarId: String, text: String, filename: String?) async throws -> IcsImportResult {
        try await post("/calendars/\(calendarId)/import", body: IcsImportRequest(text: text, filename: filename))
    }
}

struct EmptyJSONBody: Encodable {}

/// Response of POST /parse-event. startsAt/endsAt are NAIVE local
/// wall-clock strings ("YYYY-MM-DDTHH:mm:ss") — deliberately not ISO
/// with offset, so decode them with a local-zone DateFormatter, never
/// JSONDecoder.iso().
/// location / rrule / allDay mirror the web parser's optional fields
/// (src/lib/nl_parse.ts ParsedEvent): the server only sends them when
/// the phrase carries them, so all three stay optional here. Older
/// servers omit them entirely, which decodes as nil.
struct QuickParsedEvent: Decodable {
    let summary: String
    let startsAt: String
    let endsAt: String
    let location: String?
    let rrule: String?
    let allDay: Bool?

    /// Map a naive wall-clock string into a Date in the given zone
    /// (defaults to the device zone — same interpretation the web
    /// client uses when it fills its form).
    static func localDate(_ s: String, in zone: TimeZone = .current) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.date(from: s)
    }

    /// Strictly validate an RRULE string produced by the on-device
    /// model before it may reach the create form. Only the subset the
    /// shared parser itself emits is accepted — FREQ=DAILY/WEEKLY/
    /// MONTHLY/YEARLY with an optional INTERVAL and an optional BYDAY
    /// list (ordinal BYDAY like 1MO only for MONTHLY) — normalized to
    /// the canonical FREQ;INTERVAL;BYDAY order in upper case. Anything
    /// else (extra keys like COUNT/UNTIL, malformed values) returns
    /// nil: an unvalidated model guess must never become a stored
    /// recurrence.
    static func validatedRrule(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !cleaned.isEmpty else { return nil }
        let freqs: Set<String> = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
        let dayCodes: Set<String> = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
        // Collect the parts first (rejecting unknown or duplicated
        // keys) so validation below doesn't depend on part order —
        // BYDAY may legitimately precede FREQ in the model's output.
        var parts: [String: String] = [:]
        for part in cleaned.split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1)
            guard kv.count == 2 else { return nil }
            let key = String(kv[0]), value = String(kv[1])
            guard key == "FREQ" || key == "INTERVAL" || key == "BYDAY",
                  parts[key] == nil
            else { return nil }
            parts[key] = value
        }
        guard let freq = parts["FREQ"], freqs.contains(freq) else { return nil }
        var interval: String?
        if let value = parts["INTERVAL"] {
            guard value.range(of: #"^[1-9][0-9]{0,2}$"#, options: .regularExpression) != nil
            else { return nil }
            interval = value
        }
        var byday: String?
        if let value = parts["BYDAY"] {
            for token in value.split(separator: ",") {
                let t = String(token)
                let code = String(t.suffix(2))
                let ordinal = String(t.dropLast(2))
                guard dayCodes.contains(code) else { return nil }
                if !ordinal.isEmpty {
                    // Ordinal BYDAY (1MO, -1FR) is only meaningful
                    // — and only accepted — for monthly rules.
                    guard freq == "MONTHLY",
                          ordinal.range(of: #"^-?[1-5]$"#, options: .regularExpression) != nil
                    else { return nil }
                }
            }
            byday = value
        }
        var out = "FREQ=\(freq)"
        if let interval { out += ";INTERVAL=\(interval)" }
        if let byday { out += ";BYDAY=\(byday)" }
        return out
    }

    /// Short human-readable rendering of an RRULE from the shared
    /// parser's closed subset, for the create form's read-only row.
    /// Anything outside the subset falls back to the raw string — the
    /// same thing EventDetailView shows — rather than a wrong paraphrase.
    static func humanRrule(_ rrule: String) -> String {
        var freq: String?
        var interval: Int?
        var byday: [String] = []
        for part in rrule.uppercased().split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1)
            guard kv.count == 2 else { return rrule }
            switch String(kv[0]) {
            case "FREQ": freq = String(kv[1])
            case "INTERVAL": interval = Int(kv[1])
            case "BYDAY": byday = kv[1].split(separator: ",").map(String.init)
            default: return rrule
        }
        }
        switch (freq, interval, byday) {
        case ("DAILY", nil, []):
            return "quickadd.rrule.daily".loc
        case ("WEEKLY", 2, []):
            return "quickadd.rrule.biweekly".loc
        case ("WEEKLY", nil, ["MO", "TU", "WE", "TH", "FR"]):
            return "quickadd.rrule.workdays".loc
        case ("WEEKLY", nil, let days) where days.count == 1:
            return "quickadd.rrule.weeklyDay".locFormat(weekdayName(days[0]))
        case ("WEEKLY", nil, []):
            return "quickadd.rrule.weekly".loc
        case ("MONTHLY", nil, []):
            return "quickadd.rrule.monthly".loc
        case ("YEARLY", nil, []):
            return "quickadd.rrule.yearly".loc
        default:
            return rrule
        }
    }

    /// Localized weekday name ("星期五" / "Friday" / …) for a BYDAY
    /// code, via a known reference week (2024-01-07 was a Sunday).
    private static func weekdayName(_ code: String) -> String {
        let offsets = ["SU": 0, "MO": 1, "TU": 2, "WE": 3, "TH": 4, "FR": 5, "SA": 6]
        guard let offset = offsets[code] else { return code }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let base = DateComponents(year: 2024, month: 1, day: 7)
        guard let date = cal.date(from: base)?.addingTimeInterval(TimeInterval(offset * 86_400))
        else { return code }
        let f = DateFormatter()
        f.locale = .current
        f.timeZone = cal.timeZone
        f.dateFormat = "EEEE"
        return f.string(from: date)
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
