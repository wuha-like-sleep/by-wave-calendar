// Models.swift
// Codable DTOs that mirror the server's /api/v1/* JSON shapes.
// Keep field-for-field with the server schema — if you rename a field
// in src/db/schema.ts, also bump this file.

import Foundation

struct CalendarMeta: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let color: String
}

struct EventDTO: Decodable, Identifiable, Hashable {
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
