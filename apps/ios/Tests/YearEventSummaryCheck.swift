import Foundation

// Run the production summary on macOS without launching the app or changing its
// timezone. From the repository root:
// swiftc apps/ios/ByWaveCalendar/Network/Models.swift \
//   apps/ios/ByWaveCalendar/AllDayDates.swift \
//   apps/ios/Tests/YearEventSummaryCheck.swift -o /tmp/bywave-year-summary-check
// /tmp/bywave-year-summary-check
@main struct YearEventSummaryCheck {
    static let iso = ISO8601DateFormatter()

    static func calendar(_ zone: String) -> Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: zone)!
        return value
    }

    static func day(_ calendar: Calendar, _ year: Int, _ month: Int, _ day: Int, hour: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    static func event(_ id: String, _ start: Date, _ end: Date, allDay: Bool = false) -> EventDTO {
        EventDTO(id: id, calendarId: "calendar", summary: id, description: nil, location: nil,
                 startsAt: start, endsAt: end, allDay: allDay, rrule: nil, exdates: nil,
                 isOccurrence: nil, extra: nil)
    }

    static func event(_ id: String, _ start: String, _ end: String, allDay: Bool = false) -> EventDTO {
        event(id, iso.date(from: start)!, iso.date(from: end)!, allDay: allDay)
    }

    static func summary(_ events: [EventDTO], _ calendar: Calendar, year: Int = 2026) -> YearEventSummary {
        YearEventSummary(events: events, yearAnchor: day(calendar, year, 6, 15), calendar: calendar)
    }

    static func main() {
        let zones = ["UTC", "Asia/Shanghai", "Australia/Melbourne", "America/Los_Angeles", "America/New_York"]
        for zone in zones {
            let cal = calendar(zone)
            let cache = [
                event("old", "2025-11-16T12:00:00Z", "2025-11-16T13:00:00Z"),
                event("current", "2026-11-16T12:00:00Z", "2026-11-16T13:00:00Z"),
                event("future", "2027-11-16T12:00:00Z", "2027-11-16T13:00:00Z"),
            ]
            let current = summary(cache, cal)
            precondition(current.eventCountByMonth == [11: 1], "Other years leaked into badge: \(zone)")
            precondition(current.busyDays.count == 1)

            let floating = summary([event("floating", "2026-01-31T00:00:00Z", "2026-02-02T00:00:00Z", allDay: true)], cal)
            precondition(floating.eventCountByMonth == [1: 1, 2: 1], "All-day month attribution: \(zone)")
            precondition(floating.busyDays == Set([day(cal, 2026, 1, 31), day(cal, 2026, 2, 1)]))

            let monthEnd = summary([event("midnight", day(cal, 2026, 1, 31, hour: 23), day(cal, 2026, 2, 1))], cal)
            precondition(monthEnd.eventCountByMonth == [1: 1], "Exclusive local midnight: \(zone)")
            precondition(monthEnd.busyDays == Set([day(cal, 2026, 1, 31)]))

            let yearEnds = summary([
                event("incoming", day(cal, 2025, 12, 31, hour: 23), day(cal, 2026, 1, 1, hour: 1)),
                event("outgoing", day(cal, 2026, 12, 31, hour: 23), day(cal, 2027, 1, 1, hour: 1)),
                event("ends-before-year", day(cal, 2025, 12, 31), day(cal, 2026, 1, 1)),
            ], cal)
            precondition(yearEnds.eventCountByMonth == [1: 1, 12: 1], "Year crossing: \(zone)")
            precondition(yearEnds.busyDays == Set([day(cal, 2026, 1, 1), day(cal, 2026, 12, 31)]))

            // Starts six years before the visible year and lasts beyond it.
            // The prior 92-day loop never reached any of the displayed days.
            let long = summary([event("long", "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z", allDay: true)], cal)
            precondition(long.busyDays.count == 365, "Long event truncated: \(zone)")
            precondition(long.eventCountByMonth == Dictionary(uniqueKeysWithValues: (1...12).map { ($0, 1) }))
            precondition(long.busyDays.allSatisfy { cal.component(.year, from: $0) == 2026 })

            let leap = summary([event("leap", "2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z", allDay: true)], cal, year: 2024)
            precondition(leap.eventCountByMonth == [2: 1] && leap.busyDays.count == 29)

            let occurrences = summary([
                event("series", day(cal, 2026, 3, 7), day(cal, 2026, 3, 10)),
                event("series", day(cal, 2026, 3, 14), day(cal, 2026, 3, 17)),
            ], cal)
            precondition(occurrences.eventCountByMonth == [3: 2], "Distinct recurring instances collapsed: \(zone)")
            precondition(occurrences.busyDays.count == 6, "DST or multi-day coverage: \(zone)")

            // Equal start/end is accepted by the API. Preserve the existing
            // occupies rule for a point inside the day, instead of dropping it.
            let point = summary([event("point", day(cal, 2026, 5, 1, hour: 12), day(cal, 2026, 5, 1, hour: 12))], cal)
            precondition(point.eventCountByMonth == [5: 1] && point.busyDays == Set([day(cal, 2026, 5, 1)]))

            let invalid = summary([
                event("zero", day(cal, 2026, 5, 1), day(cal, 2026, 5, 1)),
                event("negative", day(cal, 2026, 5, 2), day(cal, 2026, 5, 1)),
            ], cal)
            precondition(invalid.eventCountByMonth.isEmpty && invalid.busyDays.isEmpty)
        }

        // The same real instant belongs to a different local month in the west.
        let timed = event("timed", "2026-02-01T00:30:00Z", "2026-02-01T01:30:00Z")
        precondition(summary([timed], calendar("America/Los_Angeles")).eventCountByMonth == [1: 1])
        precondition(summary([timed], calendar("Asia/Shanghai")).eventCountByMonth == [2: 1])
        print("YearEventSummaryCheck passed: 5 zones, cross-year cache, floating all-day months, exclusive midnight, long events, leap year, DST and recurring instances")
    }
}
