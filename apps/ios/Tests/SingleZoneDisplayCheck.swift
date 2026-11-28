import Foundation

@main struct SingleZoneDisplayCheck {
    static let melbourne = TimeZone(identifier: "Australia/Melbourne")!
    static let shanghai = TimeZone(identifier: "Asia/Shanghai")!
    static let iso = ISO8601DateFormatter()
    static func instant(_ value: String) -> Date { iso.date(from: value)! }

    static func event(startZone: String?, endZone: String? = nil, allDay: Bool = false) throws -> EventDTO {
        let extra: [String: String] = ["timezone": startZone, "endTimezone": endZone].compactMapValues { $0 }
        let extraDTO = try JSONDecoder().decode(EventExtraDTO.self, from: JSONEncoder().encode(extra))
        return EventDTO(id: "meeting", calendarId: "calendar", summary: "Meeting", description: nil, location: nil,
                        startsAt: instant("2026-11-28T13:30:00Z"), endsAt: instant("2026-11-28T14:30:00Z"),
                        allDay: allDay, rrule: nil, exdates: nil, isOccurrence: nil, extra: extraDTO)
    }

    static func main() throws {
        let meeting = try event(startZone: melbourne.identifier)
        let inherited = try event(startZone: nil)
        let invalid = try event(startZone: "unknown")
        let allDay = try event(startZone: melbourne.identifier, allDay: true)
        let travel = try event(startZone: melbourne.identifier, endZone: shanghai.identifier)
        for item in [meeting, inherited, invalid] {
            precondition(CalendarDisplayDates.sourceTimeZone(for: item, calendarZone: melbourne.identifier, viewerZone: shanghai) == melbourne)
        }
        precondition(CalendarDisplayDates.sourceTimeZone(for: meeting, calendarZone: shanghai.identifier, viewerZone: shanghai) == melbourne)
        precondition(CalendarDisplayDates.sourceTimeZone(for: meeting, calendarZone: nil, viewerZone: melbourne) == nil)
        precondition(CalendarDisplayDates.sourceTimeZone(for: inherited, calendarZone: nil, viewerZone: shanghai) == nil)
        let alias = try event(startZone: "Australia/Victoria", endZone: "Australia/Melbourne")
        precondition(CalendarDisplayDates.sourceTimeZone(for: alias, calendarZone: nil, viewerZone: melbourne) == nil)
        precondition(AllDayDates.itineraryZones(alias) == nil)
        precondition(EventEditorDates.sameTimeZone(TimeZone(identifier: "Etc/UTC")!, TimeZone(identifier: "UTC")!))
        precondition(DateFormatters.zoneLabel(TimeZone(identifier: "PRC")!, at: meeting.startsAt) == DateFormatters.zoneLabel(shanghai, at: meeting.startsAt))
        for item in [allDay, travel] {
            precondition(CalendarDisplayDates.sourceTimeZone(for: item, calendarZone: nil, viewerZone: shanghai) == nil)
        }
        precondition(CalendarDisplayDates.differentLocalDates(start: meeting.startsAt, end: meeting.endsAt, in: shanghai, and: melbourne))
        for (zone, expectedDay, expectedStart, expectedEnd) in [(shanghai, 28, "21:30", "22:30"), (melbourne, 29, "00:30", "01:30")] {
            let label = DateFormatters.timedRange(start: meeting.startsAt, end: meeting.endsAt, zone: zone, includeDate: true, includeYear: false)
            precondition(label.contains(expectedStart) && label.contains(expectedEnd) && label.contains(String(expectedDay)))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let day = calendar.startOfDay(for: meeting.startsAt)
            precondition(calendar.component(.day, from: day) == expectedDay && AllDayDates.occupies(meeting, localDay: day, calendar: calendar))
            precondition(!AllDayDates.occupies(meeting, localDay: calendar.date(byAdding: .day, value: 1, to: day)!, calendar: calendar))
        }

        for (stamp, viewerHour) in [("2026-11-28T22:00:00Z", "06:00"), ("2026-07-28T23:00:00Z", "07:00")] {
            let start = instant(stamp)
            let end = start.addingTimeInterval(3600)
            precondition(!CalendarDisplayDates.differentLocalDates(start: start, end: end, in: shanghai, and: melbourne))
            let local = DateFormatters.timedRange(start: start, end: end, zone: shanghai, includeDate: false, includeYear: false)
            let original = DateFormatters.timedRange(start: start, end: end, zone: melbourne, includeDate: false, includeYear: false)
            precondition(local.hasPrefix(viewerHour) && original.hasPrefix("09:00"))
        }
        let before = instant("2026-04-04T15:45:00Z")
        let after = instant("2026-04-04T16:15:00Z")
        let repeated = DateFormatters.timedRange(start: before, end: after, zone: melbourne, includeDate: false, includeYear: false)
        let offset = DateFormatters.localFormatter("OOOO", template: false, zone: melbourne)
        precondition(offset.string(from: before) != offset.string(from: after))
        precondition(repeated.contains(offset.string(from: before)) && repeated.contains(offset.string(from: after)))
        print("SingleZoneDisplayCheck passed")
    }
}
