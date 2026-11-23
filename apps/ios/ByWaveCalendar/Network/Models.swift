// Models.swift
// Codable DTOs that mirror the server's /api/v1/* JSON shapes.
// Keep field-for-field with the server schema — if you rename a field
// in src/db/schema.ts, also bump this file.

import Foundation

// Codable so the on-disk EventCache can both read and write them.
struct CalendarMeta: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let color: String
    // Added v1.3.7 to support the calendar property editor — server has
    // always returned these but iOS didn't decode them. Optional with
    // default nil so older on-disk caches keep parsing cleanly.
    let timezone: String?
    let description: String?

    // Custom init keeps backwards compat with cached records that
    // predate v1.3.7 and don't carry timezone/description.
    init(id: String, name: String, color: String, timezone: String? = nil, description: String? = nil) {
        self.id = id
        self.name = name
        self.color = color
        self.timezone = timezone
        self.description = description
    }
}

struct EventDTO: Codable, Identifiable, Hashable {
    let id: String
    let calendarId: String
    let summary: String
    let description: String?
    let location: String?
    let startsAt: Date
    let endsAt: Date
    let allDay: Bool
    let rrule: String?
    // Deleted single occurrences of a recurring series (ISO strings),
    // as stored on the master row. The server's row responses carry
    // this column (forClient only strips rawIcs); occurrences share
    // the master's list. Optional so search-lifted DTOs (which build
    // EventDTO by hand) and old caches decode cleanly.
    let exdates: [String]?
    // isOccurrence is set by the server's RRULE expansion. true for the
    // 2nd+ render of a recurring event; false for the master / non-recurring.
    let isOccurrence: Bool?
    // Server's JSONB extra column — timezone, attendees, category. We
    // mirror only the fields the APP currently cares about; the server
    // round-trips the rest unchanged via createSchema's extraSchema.
    let extra: EventExtraDTO?
}

// One VALARM row inside extra.alarms. Mirrors the server's alarm
// shape (src/routes/events.ts extraSchema): trigger is an ISO 8601
// duration string (or a parameter-prefixed iCalendar TRIGGER value
// for imported rows), action is usually "DISPLAY".
struct EventAlarmDTO: Codable, Hashable {
    let trigger: String
    let action: String?
    let description: String?
}

// Read-side mirror of EventExtra. Defined as a separate type so the
// Encodable (request body) and Decodable (response body) shapes can
// drift if needed without breaking each other.
struct EventExtraDTO: Codable, Hashable {
    let timezone: String?
    let attendees: [String]?
    let category: String?
    // v1.3.3 — Meeting/document link, e.g. Zoom URL. Same JSONB field
    // the web event-editor writes to via `name="url"`. Optional so old
    // events (and other clients) decode cleanly.
    let url: String?
    // Optional meeting passcode, e.g. Zoom 入会密码. Stored at
    // extra.meetingPassword. Optional so old events decode cleanly.
    let meetingPassword: String?
    // Event-level reminders (extra.alarms). Optional so old events
    // (and search results, which omit extra entirely) decode cleanly.
    let alarms: [EventAlarmDTO]?
}

// The /api/v1/events endpoint returns { calendars: [...], events: [...] }.
struct EventsResponse: Decodable {
    let calendars: [CalendarMeta]
    let events: [EventDTO]
}

// GET /api/v1/geo/suggest 的一条在线地址建议（服务端已整形成完整
// 地址串，客户端只管展示与回填）。
struct GeoSuggestion: Decodable {
    let label: String
    let name: String?
    let street: String?
    let suburb: String?
    let city: String?
    let state: String?
    let postcode: String?
    let country: String?
    let lat: Double?
    let lon: Double?
    // 自建地址包专用：units 是同一基础地址折叠进来的全部单元号
    // （响应层折叠，Photon 来源不带）；unit 是用户在查询里点名某个
    // 单元时代表行命中的那个，此时 label 已含单元前缀。
    // 注意不能给这两个字段写 `= nil` 默认值：带初始值的 let 属性
    // 合成 Decodable 时根本不会被解码（编译器会警告 "will not be
    // decoded"），服务端的 unit/units 会被静默丢掉、单元注脚永远
    // 显示不出来。可选属性缺键时 decodeIfPresent 本来就给 nil。
    let unit: String?
    let units: [String]?
}

// GET /api/v1/geo/suggest response。上游失败时服务端回空列表，
// 所以永远能解出——在线建议拿不到就当没有。
struct GeoSuggestResponse: Decodable {
    let suggestions: [GeoSuggestion]
}

// Extra metadata bag that piggybacks on POST/PATCH /events. Mirrors
// server extraSchema in src/routes/events.ts:
//   - timezone: IANA tz name (e.g. "Asia/Shanghai") to interpret start/end in
//   - attendees: email list — server fires invitation .ics emails on insert
//   - category: optional grouping label
/// 请求体里一个 extra 字段的三种命运。
///
/// 服务端把 extra 改成了**逐字段合并**：键不出现 = 保持原样，显式写 null = 删掉。
/// 而 Swift 给 Optional 合成的编码是 `encodeIfPresent` —— nil 一律被省掉。
/// 于是「用户把会议链接删空了」这个动作根本传不出去：界面提示保存成功，
/// 退出来链接又回来了，反复几次都一样，也不报错。
///
/// 所以「这个界面不负责这个字段」和「用户清空了它」必须分开表达，
/// 用一个 Optional 是表达不了的。
enum ExtraField<T: Encodable> {
    /// 这个界面不负责它 —— 键不出现，别动服务端上的值。
    case unmanaged
    /// 用户清空了它 —— 写显式 null。
    case cleared
    case value(T)
}

struct EventExtra: Encodable {
    let timezone: ExtraField<String>
    let attendees: ExtraField<[String]>
    let category: ExtraField<String>
    let url: ExtraField<String>
    let meetingPassword: ExtraField<String>
    let alarms: ExtraField<[EventAlarmDTO]>

    enum CodingKeys: String, CodingKey {
        case timezone, attendees, category, url, meetingPassword, alarms
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try put(timezone, .timezone, &c)
        try put(attendees, .attendees, &c)
        try put(category, .category, &c)
        try put(url, .url, &c)
        try put(meetingPassword, .meetingPassword, &c)
        try put(alarms, .alarms, &c)
    }

    private func put<T: Encodable>(
        _ field: ExtraField<T>,
        _ key: CodingKeys,
        _ c: inout KeyedEncodingContainer<CodingKeys>,
    ) throws {
        switch field {
        case .unmanaged: break                      // 整个键不出现
        case .cleared: try c.encodeNil(forKey: key) // 显式 null = 删掉
        case .value(let v): try c.encode(v, forKey: key)
        }
    }
}

// Body for POST /events (create) — matches the server's createSchema in
// src/routes/events.ts. allDay + rrule + extra are optional.
struct EventCreateInput: Encodable {
    let calendarId: String
    let summary: String
    let description: String?
    let location: String?
    let startsAt: String  // ISO8601 with offset
    let endsAt: String
    let allDay: Bool?
    let rrule: String?
    let extra: EventExtra?
    // Deleted-occurrence list for a recurring series. Only the editor
    // sets this, and only when the user actually restored one of the
    // listed occurrences; nil is dropped by the encoder.
    let exdates: [String]?
    // Optional stable idempotency key. When set, the server uses it as the
    // event's uid (UNIQUE per calendar), so a retried create (user taps
    // 创建, request times out, taps again) collapses onto the first row
    // instead of inserting a duplicate. The editor generates one value per
    // new-event session and reuses it across every save attempt. nil here
    // is dropped by the synthesized encoder (encodeIfPresent), so existing
    // callers that don't set it send the same body as before.
    var clientUid: String?
}

// Body for PATCH /events/:id (update). All fields optional — server only
// applies whatever's present. Matches updateSchema in routes/events.ts.
//
// scope + recurrenceId apply to recurring events:
//   scope="instance"  recurrenceId=<ISO start> — detach this occurrence
//   scope="future"    recurrenceId=<ISO start> — split the series here
//   scope="series" or nil — entire series (also the only valid choice
//                  for non-recurring events)
struct EventUpdateInput: Encodable {
    let calendarId: String?
    let summary: String?
    let description: String?
    let location: String?
    let startsAt: String?
    let endsAt: String?
    let allDay: Bool?
    let rrule: String?
    let extra: EventExtra?
    let scope: String?
    let recurrenceId: String?
    // Restored occurrences: PATCH replaces the stored list wholesale
    // (server updateSchema accepts exdates; omitted = untouched). The
    // editor sends the full remaining list only when the user restored
    // at least one deleted occurrence; nil (omitted) leaves it alone.
    let exdates: [String]?
}

// Body for POST /api/v1/calendars (create) — matches server createSchema
// in src/routes/calendars.ts. color must be #rrggbb hex, timezone IANA.
struct CalendarCreateInput: Encodable {
    let name: String
    let description: String?
    let color: String?
    let timezone: String?
}

// Body for PATCH /api/v1/calendars/:id — server's updateSchema is the
// .partial() of createSchema, so every field is optional. nil fields
// are dropped by JSONEncoder.iso() (which sets keyEncodingStrategy
// without explicit nulls), letting us send the smallest patch.
struct CalendarUpdateInput: Encodable {
    let name: String?
    let description: String?
    let color: String?
    let timezone: String?
}

// MFA-pending response shape (server v1.2.0+) — password was right but
// account requires TOTP. Client must POST /auth/login-mfa-verify with
// { mfaToken, code } to complete the login.
struct MfaPendingResponse: Decodable {
    let mfaPending: Bool
    let mfaToken: String
    let mfaExpiresAt: String?
}

struct MfaVerifyInput: Encodable {
    let mfaToken: String
    let code: String
}

// Server returns the saved row on create/update — same shape as EventDTO
// (mostly), but we keep this distinct so future server-side additions
// (e.g. server-computed `extra`) don't break decoding.
typealias EventSaved = EventDTO

// Recurring-event scope on PATCH / DELETE. Server checks for these
// values when the event has an rrule; non-recurring events ignore.
enum RecurringScope: String {
    case instance   // just this occurrence
    case future     // this and all subsequent occurrences
    case series     // the entire recurring series (default)
}

// Body shape for POST /api/v1/auth/login-password — alternative to
// QR pairing for users who'd rather type email+password.
struct PasswordLoginInput: Encodable {
    let email: String
    let password: String
    let label: String
    let kind: String
    let appVersion: String
    // Stable per-install UUID (iCloud Keychain). Server uses it to dedup
    // re-logins from the same physical phone.
    let clientDeviceId: String
}

// Response shape mirrors pair-claim + adds the user's email + display name
// so the app can show "signed in as alice@…" without an extra /me round-trip.
struct PasswordLoginResponse: Decodable {
    let accessToken: String
    let accessTokenExpiresAt: String
    let refreshToken: String
    let deviceId: String
    let userId: String
    let userEmail: String?
    let userName: String?
}

// MARK: - Booking links (预约链接)

// Owner-managed booking link. Mirrors GET /api/v1/booking-links rows.
// weeklyAvailability is deliberately omitted for v1 — it's not edited in
// the iOS UI and Swift's Codable ignores unknown JSON keys by default,
// so leaving it out keeps decoding clean while the server keeps it intact.
struct BookingLink: Codable, Identifiable, Hashable {
    let id: String
    let userId: String
    let slug: String
    let calendarId: String
    let title: String
    let description: String?
    let durationMinutes: Int
    let minNoticeHours: Int
    let maxDaysAhead: Int
    let bufferBeforeMin: Int
    let bufferAfterMin: Int
    let enabled: Bool
    let notifyEmail: Bool
    let createdAt: Date
    let updatedAt: Date
    let publicUrl: String
    /// Scheduling zone derived from the initiating calendar (older servers may omit it).
    let timezone: String?
}

// A single booking made against a link. Only the fields the iOS UI
// currently cares about are mirrored; the server round-trips the rest.
// Listed via GET /api/v1/booking-links/:id/bookings (not yet surfaced in
// the v1 UI, but the DTO is here so a future "查看预约" page decodes cleanly).
struct Booking: Codable, Identifiable, Hashable {
    let id: String
    let linkId: String
    let eventId: String?
    let guestEmail: String
    let guestName: String
    let guestMessage: String?
    let startsAt: Date
    let endsAt: Date
    let cancelToken: String
    let cancelledAt: Date?
    let createdAt: Date
}

// Body for POST /api/v1/booking-links (create) — matches the server's
// createSchema. slug must match ^[a-z0-9][a-z0-9-]{0,30}$. Optional
// fields are dropped by JSONEncoder when nil so the smallest payload
// goes over the wire.
struct BookingLinkCreateInput: Encodable {
    let slug: String
    let title: String
    let description: String?
    let calendarId: String
    let durationMinutes: Int
    let minNoticeHours: Int
    let maxDaysAhead: Int
    let bufferBeforeMin: Int?
    let bufferAfterMin: Int?
    let notifyEmail: Bool?
}

// Body for PATCH /api/v1/booking-links/:id — every field optional, server
// applies whatever's present. nil fields are dropped by JSONEncoder so we
// can send a one-field patch (e.g. just `enabled`) to toggle a link.
struct BookingLinkUpdateInput: Encodable {
    let slug: String?
    let title: String?
    let description: String?
    let calendarId: String?
    let durationMinutes: Int?
    let minNoticeHours: Int?
    let maxDaysAhead: Int?
    let bufferBeforeMin: Int?
    let bufferAfterMin: Int?
    let enabled: Bool?
    let notifyEmail: Bool?
}

/// All-day API timestamps carry a Gregorian date at UTC boundaries. Convert
/// that date into the device's local picker without shifting it a day.
enum EventEditorDates {
    static func timedISO(_ value: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: value)
    }

    static func localAllDay(_ value: Date, calendar: Calendar = .current) -> Date {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        var local = Calendar(identifier: .gregorian)
        local.timeZone = calendar.timeZone
        return local.date(from: utc.dateComponents([.year, .month, .day, .hour, .minute, .second], from: value)) ?? value
    }

    static func duplicate(start: Date, end: Date, allDay: Bool, from nextStart: Date, calendar: Calendar = .current) -> (Date, Date) {
        guard allDay else { return (nextStart, nextStart.addingTimeInterval(max(end.timeIntervalSince(start), 900))) }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let days = max(0, utc.dateComponents([.day], from: utc.startOfDay(for: start), to: utc.startOfDay(for: end)).day ?? 0)
        let first = calendar.startOfDay(for: nextStart)
        let lastDay = calendar.date(byAdding: .day, value: days, to: first) ?? first
        let last = calendar.date(bySettingHour: 23, minute: 59, second: 59, of: lastDay) ?? lastDay
        return (first, last)
    }
}

// MARK: - ICS 导入 (POST /api/v1/calendars/:id/import[/preview])

/// Body for the ICS import endpoints. `text` is the whole .ics file
/// decoded as UTF-8. `filename` only feeds the server's sourceTag
/// (the same `file:<name>` shape the web upload produces) — the tag
/// takes part in the "did anything change" judgement, so sending the
/// real name keeps re-importing the same file a no-op even when it
/// was first imported through another channel.
struct IcsImportRequest: Encodable {
    let text: String
    let filename: String?
}

/// Preview counts for an ICS import — computed server-side by the
/// same judgement the real import uses, but writes nothing.
struct IcsImportPreview: Decodable {
    let total: Int
    let inserted: Int
    let updated: Int
    let duplicates: Int
    let invalid: Int
    let invalidReasons: [String]
}

/// Result of an ICS import. `skipped` = duplicates + invalid.
struct IcsImportResult: Decodable {
    let inserted: Int
    let updated: Int
    let skipped: Int
    let total: Int
}

// MARK: - 重复规则 (RRULE 编辑器状态)

/// Frequency of a recurrence rule. Raw values are the RFC 5545
/// wire strings; `none` is the editor's「不重复」state (no RRULE).
enum RruleFreq: String, CaseIterable, Hashable {
    case none = ""
    case daily = "DAILY"
    case weekly = "WEEKLY"
    case monthly = "MONTHLY"
    case yearly = "YEARLY"

    var labelKey: String {
        switch self {
        case .none: return "app.event.repeatNone"
        case .daily: return "app.event.repeatDaily"
        case .weekly: return "app.event.repeatWeekly"
        case .monthly: return "app.event.repeatMonthly"
        case .yearly: return "app.event.repeatYearly"
        }
    }
}

enum RruleEndKind: String, CaseIterable, Hashable {
    case forever, until, count

    var labelKey: String {
        switch self {
        case .forever: return "rrule.end.forever"
        case .until: return "rrule.end.until"
        case .count: return "rrule.end.count"
        }
    }
}

/// How a MONTHLY rule picks its day: by day-of-month (DTSTART's day,
/// no BYDAY at all) or by ordinal weekday (BYDAY=2MO / BYDAY=-1FR).
enum RruleMonthlyMode: String, CaseIterable, Hashable {
    case byMonthDay, byWeekday

    var labelKey: String {
        switch self {
        case .byMonthDay: return "rrule.monthly.byDate"
        case .byWeekday: return "rrule.monthly.byWeekday"
        }
    }
}

/// Editable recurrence state — the iOS counterpart of the desktop
/// RruleEditor's RruleState, widened with the two BYDAY shapes the
/// server's expander (the `rrule` library, see src/lib/
/// rrule_expand.ts) fully supports: WEEKLY weekday sets and MONTHLY
/// ordinal weekdays.
///
/// Round-trip rule, same as desktop: anything the editor can't model
/// exactly (BYSETPOS, BYMONTHDAY lists, FREQ=HOURLY, ordinal BYDAY
/// on a WEEKLY rule, UNTIL+COUNT together…) is kept verbatim in
/// `passthrough` and sent back untouched — parsing must never
/// silently drop a rule it doesn't understand.
struct RruleState: Equatable {
    var freq: RruleFreq = .none
    var interval: Int = 1
    var end: RruleEndKind = .forever
    /// UNTIL day (date-only in the UI; built as end-of-day UTC, the
    /// desktop editor's convention).
    var until: Date = Date()
    var count: Int = 10
    /// WEEKLY: chosen weekdays as Calendar weekday numbers
    /// (1 = Sunday … 7 = Saturday). Empty = DTSTART's weekday.
    var byday: Set<Int> = []
    var monthlyMode: RruleMonthlyMode = .byMonthDay
    /// MONTHLY byWeekday: 1…4 = first…fourth, -1 = last.
    var monthlyOrdinal: Int = 1
    var monthlyWeekday: Int = 2  // Calendar weekday; Monday default
    /// Verbatim original when it can't be modeled. Non-nil blocks
    /// rebuilding: build() returns it as-is until the user picks a
    /// frequency explicitly (which clears it, like desktop).
    var passthrough: String?
    /// The string this state was parsed from (nil for a fresh event),
    /// so the editor can tell "unchanged" from "edited" and only
    /// then put rrule on the PATCH.
    var original: String?

    private static let weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]  // index = weekday - 1
    /// BYDAY emission order (RFC examples use week order from Monday).
    private static let codeOrder = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

    static func parse(_ raw: String?, seedStart: Date) -> RruleState {
        guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else {
            var s = RruleState()
            s.until = Calendar.current.date(byAdding: .month, value: 1, to: seedStart) ?? seedStart
            return s
        }
        var s = RruleState()
        s.original = raw
        s.until = Calendar.current.date(byAdding: .month, value: 1, to: seedStart) ?? seedStart

        var parts: [String: String] = [:]
        for chunk in raw.split(separator: ";") {
            let kv = chunk.split(separator: "=", maxSplits: 1)
            guard kv.count == 2 else { s.passthrough = raw; return s }
            parts[String(kv[0]).uppercased()] = String(kv[1]).uppercased()
        }
        guard let freqWire = parts["FREQ"], let freq = RruleFreq(rawValue: freqWire), freq != .none else {
            s.passthrough = raw
            return s
        }
        s.freq = freq

        // Every key must be one we model, or the whole rule passes through.
        let known: Set<String> = ["FREQ", "INTERVAL", "UNTIL", "COUNT", "BYDAY", "BYMONTHDAY"]
        if parts.keys.contains(where: { !known.contains($0) }) {
            s.passthrough = raw
            return s
        }
        if let iv = parts["INTERVAL"] {
            guard let n = Int(iv), n >= 1 else { s.passthrough = raw; return s }
            s.interval = n
        }
        if parts["UNTIL"] != nil && parts["COUNT"] != nil {
            s.passthrough = raw  // RFC forbids both; don't pick a winner
            return s
        }
        if let u = parts["UNTIL"] {
            guard let d = parseUntil(u) else { s.passthrough = raw; return s }
            s.end = .until
            s.until = d
        } else if let c = parts["COUNT"] {
            guard let n = Int(c), n >= 1 else { s.passthrough = raw; return s }
            s.end = .count
            s.count = n
        }
        if let md = parts["BYMONTHDAY"] {
            // Only the plain monthly case is modeled: a single day
            // equal to DTSTART's day-of-month. Anything richer
            // (lists, negative offsets) passes through.
            let seedDay = Calendar.current.component(.day, from: seedStart)
            guard freq == .monthly, Int(md) == seedDay else { s.passthrough = raw; return s }
        }
        if let byday = parts["BYDAY"] {
            let tokens = byday.split(separator: ",").map(String.init)
            switch freq {
            case .weekly:
                var days: Set<Int> = []
                for token in tokens {
                    guard let wd = weekdayNumber(token) else { s.passthrough = raw; return s }
                    days.insert(wd)
                }
                s.byday = days
            case .monthly:
                guard tokens.count == 1, let (ordinal, wd) = parseOrdinalToken(tokens[0]) else {
                    s.passthrough = raw
                    return s
                }
                s.monthlyMode = .byWeekday
                s.monthlyOrdinal = ordinal
                s.monthlyWeekday = wd
            default:
                s.passthrough = raw
                return s
            }
        }
        return s
    }

    /// The RRULE to store, or nil for「不重复」. A passthrough rule
    /// comes back verbatim until the user explicitly picks a
    /// frequency (the view clears `passthrough` at that moment).
    func build() -> String? {
        if let passthrough { return passthrough }
        guard freq != .none else { return nil }
        var out = "FREQ=\(freq.rawValue)"
        if interval > 1 { out += ";INTERVAL=\(interval)" }
        switch freq {
        case .weekly:
            if !byday.isEmpty {
                let codes = Self.codeOrder.filter { code in
                    guard let wd = Self.weekdayNumber(code) else { return false }
                    return byday.contains(wd)
                }
                out += ";BYDAY=" + codes.joined(separator: ",")
            }
        case .monthly:
            if monthlyMode == .byWeekday {
                out += ";BYDAY=\(monthlyOrdinal)\(Self.weekdayCodes[monthlyWeekday - 1])"
            }
        default:
            break
        }
        switch end {
        case .forever:
            break
        case .until:
            out += ";UNTIL=" + Self.formatUntil(until)
        case .count:
            out += ";COUNT=\(max(count, 1))"
        }
        return out
    }

    /// True when the user actually changed the rule — the editor
    /// only then sends rrule on PATCH (sending the identical string
    /// would needlessly wake the server's series-edit planner).
    var isEdited: Bool { build() != original }

    // MARK: Parsing helpers

    /// Plain weekday token ("MO") → Calendar weekday (1 = Sun … 7 = Sat).
    private static func weekdayNumber(_ code: String) -> Int? {
        guard let idx = weekdayCodes.firstIndex(of: code) else { return nil }
        return idx + 1
    }

    /// Ordinal weekday token ("2MO", "-1FR") → (ordinal, weekday).
    private static func parseOrdinalToken(_ token: String) -> (Int, Int)? {
        guard token.count >= 3 else { return nil }
        let code = String(token.suffix(2))
        guard let wd = weekdayNumber(code) else { return nil }
        guard let ordinal = Int(token.dropLast(2)), ordinal != 0, (-1...4).contains(ordinal) || ordinal == 5 else { return nil }
        return (ordinal, wd)
    }

    /// UNTIL as stored: "yyyyMMdd'T'HHmmss'Z'" or date-only "yyyyMMdd".
    /// The editor works in whole calendar days (that's all the date
    /// picker offers), so the day is materialized in the DEVICE
    /// calendar — the same day the picker will show — rather than as
    /// a UTC-midnight instant that lands on the previous local day
    /// west of UTC.
    private static func parseUntil(_ u: String) -> Date? {
        let digits = u.replacingOccurrences(of: "Z", with: "")
            .split(separator: "T").first.map(String.init) ?? ""
        guard digits.count == 8, digits.allSatisfy(\.isNumber) else { return nil }
        return Calendar.current.date(from: DateComponents(
            year: Int(digits.prefix(4)),
            month: Int(digits.dropFirst(4).prefix(2)),
            day: Int(digits.dropFirst(6).prefix(2)),
        ))
    }

    /// UI date → UNTIL wire value, end-of-day UTC (desktop convention).
    /// Components are read in the device calendar so the wire day is
    /// the day the user picked, not its UTC projection.
    private static func formatUntil(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d%02d%02dT235959Z", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }
}

// MARK: - 事件分类 (extra.category)

/// Category values, value-for-value with the web editor's select
/// (src/views/app/calendar-app.ejs): "" is「无」, the rest are stored
/// verbatim in extra.category. Labels use the server's
/// app.event.category* keys so all clients name them alike.
struct CategoryOption: Identifiable, Hashable {
    var id: String { value }
    let value: String
    let labelKey: String
}

enum EventCategory {
    static let values: [CategoryOption] = [
        CategoryOption(value: "", labelKey: "app.event.none"),
        CategoryOption(value: "work", labelKey: "app.event.categoryWork"),
        CategoryOption(value: "personal", labelKey: "app.event.categoryPersonal"),
        CategoryOption(value: "family", labelKey: "app.event.categoryFamily"),
        CategoryOption(value: "health", labelKey: "app.event.categoryHealth"),
        CategoryOption(value: "travel", labelKey: "app.event.categoryTravel"),
        CategoryOption(value: "meeting", labelKey: "app.event.categoryMeeting"),
    ]
}

// MARK: - 日历分享链接 (share-tokens)

/// One row of GET /calendars/:id/share-tokens. `url` is composed by
/// the server (PUBLIC_BASE_URL + /ics/<token>.ics) — the client never
/// builds it itself, so a self-hosted origin change can't strand the
/// copied link. `token` doubles as the row id and the revoke key.
struct ShareTokenDTO: Codable, Identifiable, Hashable {
    var id: String { token }
    let token: String
    let calendarId: String
    let label: String?
    let createdAt: Date
    let url: String
}

/// Body for POST /calendars/:id/share-tokens. nil label is dropped by
/// the encoder so an unnamed link sends `{}`.
struct ShareTokenCreateInput: Encodable {
    let label: String?
}

// MARK: - 设备 (devices)

/// One row of GET /devices (the endpoint answers with a raw
/// `{devices:[...]}` body, no v1 envelope). Dates decode through
/// JSONDecoder.iso() like every other DTO.
struct DeviceDTO: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let kind: String
    let prefix: String
    let appVersion: String?
    let lastSeenAt: Date?
    let lastSeenIp: String?
    let firstSeenIp: String?
    let createdAt: Date
}

struct DevicesResponse: Decodable {
    let devices: [DeviceDTO]
}

/// GET /devices/me — which devices row this bearer session belongs
/// to. Only `id` is needed to mark the「本机」row; the rest is decoded
/// so the shape stays honest if the page ever wants it.
struct CurrentDeviceResponse: Decodable {
    let id: String
    let label: String?
    let kind: String?
    let hasPushToken: Bool?
}

/// `{ok:true}` acknowledgement (DELETE /devices/:id and friends).
struct OkResponse: Decodable {
    let ok: Bool
}

// MARK: - API Token (account/api-tokens)

/// One row of GET /account/api-tokens. The full secret is NOT here —
/// the server stores only a hash; `plain` comes back exactly once in
/// the create / rotate response. Dates decode through JSONDecoder.iso().
struct ApiTokenDTO: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let prefix: String
    /// "read" | "write" (the server normalizes anything else to "read").
    let scope: String
    let lastUsedAt: Date?
    let lastUsedIp: String?
    let useCount: Int
    let expiresAt: Date?
    let rotatedAt: Date?
    let createdAt: Date
    let expired: Bool
    /// True while a rotated token's old secret is in its 7-day grace.
    let inGrace: Bool
}

struct ApiTokenUsageDayDTO: Decodable, Hashable {
    let day: String
    let count: Int
}

struct ApiTokenUsagePerTokenDTO: Decodable, Hashable {
    let tokenId: String
    let label: String
    let count: Int
}

struct ApiTokenUsageDTO: Decodable, Hashable {
    let total: Int
    let perDay: [ApiTokenUsageDayDTO]
    let perToken: [ApiTokenUsagePerTokenDTO]
}

/// GET /account/api-tokens — the same view model the Web settings page
/// renders: token list + step-up context + 30-day usage. `passwordSet`
/// is tri-state: true = has own password, false = SSO-only, nil =
/// legacy row where the server couldn't tell.
struct ApiTokensResponse: Decodable {
    let apiEnabled: Bool
    let limit: Int
    let limitReached: Bool
    let passwordSet: Bool?
    let mfaEnabled: Bool
    let tokens: [ApiTokenDTO]
    let usage: ApiTokenUsageDTO
}

/// POST /account/api-tokens body. Custom encoding so absent step-up
/// fields are OMITTED, not sent as null — the server schema treats
/// null and missing differently (null fails validation).
struct CreateApiTokenInput: Encodable {
    let label: String
    let scope: String
    let expiresInDays: Int
    let currentPassword: String?
    let mfaCode: String?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(label, forKey: .label)
        try c.encode(scope, forKey: .scope)
        try c.encode(expiresInDays, forKey: .expiresInDays)
        try c.encodeIfPresent(currentPassword, forKey: .currentPassword)
        try c.encodeIfPresent(mfaCode, forKey: .mfaCode)
    }

    enum CodingKeys: String, CodingKey {
        case label, scope, expiresInDays, currentPassword, mfaCode
    }
}

/// POST /account/api-tokens/:id/rotate body — step-up fields only;
/// the scope comes from the token being rotated.
struct ApiTokenStepUpInput: Encodable {
    let currentPassword: String?
    let mfaCode: String?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(currentPassword, forKey: .currentPassword)
        try c.encodeIfPresent(mfaCode, forKey: .mfaCode)
    }

    enum CodingKeys: String, CodingKey {
        case currentPassword, mfaCode
    }
}

/// Create success (201). `plain` is shown ONCE and never persisted.
struct ApiTokenCreatedResponse: Decodable {
    let token: ApiTokenDTO
    let plain: String
}

/// Rotate success. `oldExpiresAt` = when the old secret stops working.
struct ApiTokenRotatedResponse: Decodable {
    let token: ApiTokenDTO
    let plain: String
    let oldExpiresAt: Date?
}

// MARK: - 冲突检测 (POST /events/conflicts)

struct ConflictCheckInput: Encodable {
    let calendarId: String
    let startsAt: String  // ISO8601 with offset
    let endsAt: String
    let excludeId: String?
}

/// One overlapping event. The endpoint answers with a raw
/// `{conflicts:[...]}` body (no envelope), dates as ISO strings.
struct ConflictDTO: Decodable, Identifiable, Hashable {
    let id: String
    let summary: String
    let startsAt: Date
    let endsAt: Date
}

struct ConflictsResponse: Decodable {
    let conflicts: [ConflictDTO]
}

// MARK: - 日历订阅 (subscriptions)

/// One row of GET /calendars/:id/subscriptions. lastStatus is the
/// server's raw "ok" / "error" / nil (never fetched yet).
struct CalendarSubscriptionDTO: Codable, Identifiable, Hashable {
    let id: String
    let calendarId: String
    let url: String
    let label: String?
    let refreshMinutes: Int
    let lastFetchedAt: Date?
    let lastStatus: String?
    let lastError: String?
    let lastEventCount: Int?
    let createdAt: Date
}

/// Body for POST /calendars/:id/subscriptions. refreshMinutes is
/// left nil from the iOS UI — the server default (360) applies.
struct SubscriptionCreateInput: Encodable {
    let url: String
    let label: String?
    let refreshMinutes: Int?
}

/// The `refresh` half of the create response: the subscription is
/// already stored even when the first fetch failed, so `ok == false`
/// carries the error as data, not as a thrown failure.
struct SubscriptionRefreshOutcome: Decodable, Hashable {
    let ok: Bool
    let inserted: Int?
    let updated: Int?
    let skipped: Int?
    let total: Int?
    let error: String?
}

struct SubscriptionCreateResponse: Decodable {
    let subscription: CalendarSubscriptionDTO
    let refresh: SubscriptionRefreshOutcome
}

/// POST /calendars/:id/subscriptions/:subId/refresh success shape
/// (a failed refresh is an HTTP 502 instead, thrown as APIError).
struct SubscriptionRefreshResponse: Decodable {
    let subscription: CalendarSubscriptionDTO
    let inserted: Int
    let updated: Int
    let skipped: Int
    let total: Int
}

// MARK: - 事件提醒档位与 trigger 解析

/// The reminder picker values. These MUST stay value-for-value with
/// the server's src/lib/reminder_triggers.ts (TIMED_TRIGGERS /
/// ALLDAY_TRIGGERS) — the string is stored verbatim in
/// extra.alarms[].trigger and is part of the reminder idempotency
/// key, so an invented or mistyped value saves fine and then never
/// fires. "" is the「不提醒」sentinel, not a trigger.
struct ReminderOption: Identifiable, Hashable {
    var id: String { value }
    let value: String
    let labelKey: String
}

enum ReminderOptions {
    static let timed: [ReminderOption] = [
        ReminderOption(value: "", labelKey: "app.reminder.none"),
        ReminderOption(value: "-PT0M", labelKey: "app.reminder.timed.atStart"),
        ReminderOption(value: "-PT5M", labelKey: "app.reminder.timed.min5"),
        ReminderOption(value: "-PT15M", labelKey: "app.reminder.timed.min15"),
        ReminderOption(value: "-PT30M", labelKey: "app.reminder.timed.min30"),
        ReminderOption(value: "-PT1H", labelKey: "app.reminder.timed.hour1"),
        ReminderOption(value: "-PT2H", labelKey: "app.reminder.timed.hour2"),
        ReminderOption(value: "-P1D", labelKey: "app.reminder.timed.day1"),
        ReminderOption(value: "-P1W", labelKey: "app.reminder.timed.week1"),
    ]
    static let allDay: [ReminderOption] = [
        ReminderOption(value: "", labelKey: "app.reminder.none"),
        ReminderOption(value: "PT9H", labelKey: "app.reminder.allDay.sameDay9am"),
        ReminderOption(value: "-PT15H", labelKey: "app.reminder.allDay.dayBefore9am"),
        ReminderOption(value: "-P1DT15H", labelKey: "app.reminder.allDay.twoDaysBefore9am"),
        ReminderOption(value: "-P6DT15H", labelKey: "app.reminder.allDay.weekBefore9am"),
    ]

    static func options(allDay: Bool) -> [ReminderOption] {
        allDay ? Self.allDay : Self.timed
    }

    static func values(allDay: Bool) -> [String] {
        options(allDay: allDay).map(\.value)
    }
}

/// A parsed alarm trigger: a signed duration in seconds plus which
/// end of the event it hangs off (iCalendar RELATED=END).
struct ParsedAlarmTrigger: Equatable {
    let seconds: TimeInterval
    let relatedToEnd: Bool
}

/// Minimal ISO 8601 duration parser for alarm triggers — the local
/// counterpart of the server's parseTrigger (reminder_triggers.ts),
/// narrowed to what local notification scheduling needs:
///
///   - Accepts a bare duration (`-PT15M`, `P1DT15H`…) and the
///     parameter-prefixed form imports carry
///     (`RELATED=END:-PT15M`, `VALUE=DURATION:-PT15M`).
///   - Grammar: `[+-]P[nW][nD]T[nH][nM][nS]`, sign applies to the
///     whole value, years/months are NOT accepted (a "month" has no
///     fixed length — guessing would fire on the wrong day).
///   - Anything else (absolute DATE-TIME triggers, garbage) returns
///     nil and the caller skips that one alarm instead of guessing.
enum AlarmTriggerParser {
    private static let durationRegex = try? NSRegularExpression(
        pattern: #"^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$"#, // raw string, no escaping needed
        options: [.caseInsensitive],
    )

    static func parse(_ raw: String) -> ParsedAlarmTrigger? {
        var text = raw.trimmingCharacters(in: .whitespaces)
        // Tolerate a whole property line sneaking in ("TRIGGER:..." /
        // "TRIGGER;..."), same stance as the server parser.
        if text.count > 8 {
            let head = text.prefix(8).uppercased()
            if head == "TRIGGER:" || head == "TRIGGER;" {
                text = String(text.dropFirst(8))
            }
        }
        if text.isEmpty { return nil }

        var value = text
        var relatedToEnd = false
        // Parameter block: only when the segment before the first
        // colon contains "=", otherwise the colon is part of the value.
        if let colon = text.firstIndex(of: ":"), text[..<colon].contains("=") {
            let params = text[..<colon]
            value = String(text[text.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            for part in params.split(separator: ";") {
                let kv = part.split(separator: "=", maxSplits: 1)
                guard kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).uppercased() == "RELATED" else { continue }
                switch kv[1].trimmingCharacters(in: .whitespaces).uppercased() {
                case "END": relatedToEnd = true
                case "START": relatedToEnd = false
                default: return nil  // a RELATED we don't understand — don't guess
                }
            }
        }
        guard let seconds = parseDurationSeconds(value) else { return nil }
        return ParsedAlarmTrigger(seconds: seconds, relatedToEnd: relatedToEnd)
    }

    /// Signed seconds for one duration string, nil when unparseable.
    /// 0 is a legitimate result ("-PT0M" = at start) — callers must
    /// compare against nil, never against 0.
    static func parseDurationSeconds(_ value: String) -> TimeInterval? {
        guard let re = durationRegex else { return nil }
        let ns = value as NSString
        guard let m = re.firstMatch(in: value, range: NSRange(location: 0, length: ns.length)) else { return nil }
        func group(_ i: Int) -> Double? {
            let r = m.range(at: i)
            guard r.location != NSNotFound else { return nil }
            return Double(ns.substring(with: r))
        }
        let w = group(2), d = group(3), h = group(4), min = group(5), s = group(6)
        // A bare "P" / "PT" matches the regex with every group empty.
        guard w != nil || d != nil || h != nil || min != nil || s != nil else { return nil }
        let total = (w ?? 0) * 604_800 + (d ?? 0) * 86_400 + (h ?? 0) * 3_600 + (min ?? 0) * 60 + (s ?? 0)
        let signRange = m.range(at: 1)
        let negative = signRange.location != NSNotFound && ns.substring(with: signRange) == "-"
        return negative ? -total : total
    }
}

// MARK: - 购买清单 (shopping-lists)

/// One row of GET /shopping-lists — the list header plus the counts
/// the server computes from its items. `eventSummary` is the linked
/// event's title, nil when the list is unlinked or the event is gone.
/// Timestamps stay String: the UI never renders them, and keeping the
/// raw value avoids coupling this DTO to the date decoder's formats.
struct ShoppingListDTO: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let eventId: String?
    let eventSummary: String?
    let totalCount: Int
    let doneCount: Int
    let createdAt: String
    let updatedAt: String

    /// 买齐 badge — only for a non-empty list with everything ticked.
    var isAllDone: Bool { totalCount > 0 && doneCount >= totalCount }
}

/// One item row of GET /shopping-lists/:id. `quantity` is a JSON
/// number server-side (the numeric column is converted on the way
/// out) and may be fractional (0.5), hence Double.
struct ShoppingListItemDTO: Codable, Identifiable, Hashable {
    let id: String
    let listId: String
    let name: String
    let quantity: Double?
    let unit: String?
    let note: String?
    let done: Bool
    let position: Int
    let createdAt: String
    let updatedAt: String
}

/// GET /shopping-lists/:id — header (same shape as the list rows,
/// counts included) plus the items in position order.
struct ShoppingListDetailDTO: Decodable {
    let list: ShoppingListDTO
    let items: [ShoppingListItemDTO]
}

/// POST /shopping-lists body. A nil eventId is dropped by the
/// encoder, which is exactly the server's "no link" create.
struct ShoppingListCreateInput: Encodable {
    let title: String
    let eventId: String?
}

/// POST /shopping-lists/:id/items body. nil quantity / unit / note
/// are dropped; an empty-string unit or note is sent as-is and the
/// server normalizes it to null.
struct ShoppingItemCreateInput: Encodable {
    let name: String
    let quantity: Double?
    let unit: String?
    let note: String?
}

/// PATCH /shopping-lists/:id/items/:itemId body — every field
/// optional, nil entries are dropped so a done-toggle PATCH sends
/// `{done: …}` alone. (Clearing quantity back to nil is not
/// expressible this way; the editor never offers it.)
struct ShoppingItemUpdateInput: Encodable {
    let name: String?
    let quantity: Double?
    let unit: String?
    let note: String?
    let done: Bool?
}

/// POST /shopping-lists/:id/items/:itemId/move body.
struct ShoppingItemMoveInput: Encodable {
    let direction: String  // "up" | "down"
}

/// Quantity display / entry helpers. The server stores quantity as
/// numeric(12,3), so at most three decimals ever come back; display
/// trims the meaningless trailing zeros (2 → "2", 0.5 → "0.5").
enum ShoppingQuantity {
    static func format(_ quantity: Double) -> String {
        var s = String(format: "%.3f", quantity)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s
    }

    /// Parse a quantity text field. Accepts a comma decimal
    /// separator (many locales' keypads produce one); empty or
    /// unparseable text means "no quantity".
    static func parse(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: ",", with: ".")
        guard !t.isEmpty else { return nil }
        return Double(t)
    }
}

/// Availability stays in the initiating calendar's zone; legacy calendars used Shanghai.
func bookingTimeZone(_ explicit: String?, calendar: String?) -> String {
    [explicit, calendar, "Asia/Shanghai"].compactMap { value in
        value.flatMap { TimeZone(identifier: $0)?.identifier }
    }.first ?? "Asia/Shanghai"
}
