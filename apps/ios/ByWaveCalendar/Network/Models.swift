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
}

// The /api/v1/events endpoint returns { calendars: [...], events: [...] }.
struct EventsResponse: Decodable {
    let calendars: [CalendarMeta]
    let events: [EventDTO]
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
    let scope: String?
    let recurrenceId: String?
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
