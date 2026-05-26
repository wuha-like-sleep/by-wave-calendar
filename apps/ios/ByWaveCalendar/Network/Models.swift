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
    // isOccurrence is set by the server's RRULE expansion. true for the
    // 2nd+ render of a recurring event; false for the master / non-recurring.
    let isOccurrence: Bool?
    // Server's JSONB extra column — timezone, attendees, category. We
    // mirror only the fields the APP currently cares about; the server
    // round-trips the rest unchanged via createSchema's extraSchema.
    let extra: EventExtraDTO?
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
}

// The /api/v1/events endpoint returns { calendars: [...], events: [...] }.
struct EventsResponse: Decodable {
    let calendars: [CalendarMeta]
    let events: [EventDTO]
}

// Extra metadata bag that piggybacks on POST/PATCH /events. Mirrors
// server extraSchema in src/routes/events.ts:
//   - timezone: IANA tz name (e.g. "Asia/Shanghai") to interpret start/end in
//   - attendees: email list — server fires invitation .ics emails on insert
//   - category: optional grouping label
struct EventExtra: Encodable {
    let timezone: String?
    let attendees: [String]?
    let category: String?
    let url: String?

    var isEmpty: Bool {
        (timezone?.isEmpty ?? true)
            && (attendees?.isEmpty ?? true)
            && (category?.isEmpty ?? true)
            && (url?.isEmpty ?? true)
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
