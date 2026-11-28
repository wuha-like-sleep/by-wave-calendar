import Foundation

// Compile with Network/Models.swift and AllDayDates.swift; no simulator or account.
@main struct EventEndpointTimeZoneCheck {
    static let plain = ISO8601DateFormatter()
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    static func date(_ value: String) -> Date { fractional.date(from: value) ?? plain.date(from: value)! }
    static func calendar(_ identifier: String) -> Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: identifier)!
        return value
    }
    static func civil(_ date: Date, _ calendar: Calendar) -> String {
        let value = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(format: "%04d-%02d-%02d %02d:%02d:%02d", value.year!, value.month!, value.day!, value.hour!, value.minute!, value.second!)
    }

    static func main() throws {
        let melbourne = calendar("Australia/Melbourne")
        let shanghai = calendar("Asia/Shanghai")
        let la = calendar("America/Los_Angeles")
        let inherited = EventEditorDates.endpointTimeZones(start: nil, end: nil, calendar: melbourne.timeZone.identifier, device: la.timeZone)
        precondition(inherited.start == melbourne.timeZone && inherited.end == melbourne.timeZone)
        let invalid = EventEditorDates.endpointTimeZones(start: "Not/AZone", end: "Not/AnEnd", calendar: nil, device: shanghai.timeZone)
        precondition(invalid.start == shanghai.timeZone && invalid.end == shanghai.timeZone)
        let explicit = EventEditorDates.endpointTimeZones(start: "Australia/Melbourne", end: "Asia/Shanghai", calendar: "UTC", device: la.timeZone)
        precondition(explicit.start == melbourne.timeZone && explicit.end == shanghai.timeZone)

        let departure = date("2026-11-28T12:00:00.123Z")
        let arrival = date("2026-11-28T21:00:00.123Z")
        precondition(civil(departure, melbourne) == "2026-11-28 23:00:00")
        precondition(civil(arrival, shanghai) == "2026-11-29 05:00:00")
        precondition(arrival.timeIntervalSince(departure) == 9 * 3600)
        precondition(EventEditorDates.isChronological(start: departure, end: arrival))
        precondition(!EventEditorDates.isChronological(start: departure, end: arrival.addingTimeInterval(-86400)))
        precondition(EventEditorDates.timedISO(departure) == "2026-11-28T12:00:00.123Z")
        let copy = EventEditorDates.duplicate(start: departure, end: arrival, allDay: false, from: date("2027-04-03T15:00:00Z"))
        precondition(copy.1.timeIntervalSince(copy.0) == 9 * 3600)
        for duration in [0.0, 600.0] {
            let shortCopy = EventEditorDates.duplicate(start: departure, end: departure.addingTimeInterval(duration), allDay: false, from: arrival)
            precondition(shortCopy.1.timeIntervalSince(shortCopy.0) == duration)
        }
        // DST changes the wall-clock interval, never the actual trip duration.
        precondition(date("2026-10-03T16:30:00Z").timeIntervalSince(date("2026-10-03T15:30:00Z")) == 3600)
        precondition(civil(date("2026-10-03T15:30:00Z"), melbourne) == "2026-10-04 01:30:00")
        precondition(civil(date("2026-10-03T16:30:00Z"), melbourne) == "2026-10-04 03:30:00")
        precondition(date("2026-04-04T17:30:00Z").timeIntervalSince(date("2026-04-04T14:30:00Z")) == 3 * 3600)
        precondition(civil(date("2026-04-04T14:30:00Z"), melbourne) == "2026-04-05 01:30:00")
        precondition(civil(date("2026-04-04T17:30:00Z"), melbourne) == "2026-04-05 03:30:00")

        for (zone, first, second, distance) in [
            ("America/New_York", "2026-11-01T05:30:00.123Z", "2026-11-01T06:30:00.123Z", 3600.0),
            ("Australia/Melbourne", "2026-04-04T15:30:00.456Z", "2026-04-04T16:30:00.456Z", 3600.0),
            ("Australia/Lord_Howe", "2026-04-04T14:45:00.789Z", "2026-04-04T15:15:00.789Z", 1800.0),
        ] {
            let expected = [date(first), date(second)]
            for original in expected {
                let choices = EventEditorDates.repeatedTimeAlternatives(for: original, in: TimeZone(identifier: zone)!)
                precondition(choices == expected, "Fold choices must preserve both exact instants: \(zone) \(choices)")
                precondition(choices[1].timeIntervalSince(choices[0]) == distance)
            }
        }
        precondition(EventEditorDates.repeatedTimeAlternatives(for: departure, in: melbourne.timeZone) == [departure])
        let newYork = calendar("America/New_York")
        let springDay = date("2026-03-08T12:00:00Z")
        precondition(EventEditorDates.civilDate(springDay, calendar: newYork, zone: newYork.timeZone, hour: 2, minute: 30) == nil)
        precondition(EventEditorDates.civilDate(springDay, calendar: newYork, zone: newYork.timeZone, hour: 3, minute: 30) == date("2026-03-08T07:30:00Z"))
        let utc = calendar("UTC")
        precondition(EventEditorDates.civilDate(date("2011-12-30T12:00:00Z"), calendar: utc, zone: TimeZone(identifier: "Pacific/Apia")!, hour: 9) == nil)

        // Both historic all-day wire formats show/copy exactly the same civil dates,
        // including the 23/25-hour picker days on either side of DST changes.
        for picker in [la, shanghai, melbourne] {
            for day in ["2026-03-08", "2026-04-05", "2026-10-04", "2026-11-01"] {
                let sourceStart = date(day + "T00:00:00Z")
                for days in [1, 3] {
                    let exclusiveEnd = sourceStart.addingTimeInterval(Double(days) * 86400)
                    let legacyEnd = exclusiveEnd.addingTimeInterval(-1)
                    let canonical = EventEditorDates.allDayEditorRange(start: sourceStart, end: exclusiveEnd, calendar: picker)
                    let legacy = EventEditorDates.allDayEditorRange(start: sourceStart, end: legacyEnd, calendar: picker)
                    precondition(canonical.start == legacy.start && canonical.end == legacy.end)
                    precondition(civil(canonical.start, picker).hasPrefix(day))
                    precondition(picker.dateComponents([.day], from: picker.startOfDay(for: canonical.start), to: picker.startOfDay(for: canonical.end)).day == days - 1)
                    for end in [exclusiveEnd, legacyEnd] {
                        let copy = EventEditorDates.duplicate(start: sourceStart, end: end, allDay: true, from: canonical.start, calendar: picker)
                        precondition(copy.0 == canonical.start && copy.1 == canonical.end)
                        let timed = EventEditorDates.timedFromAllDay(start: canonical.start, end: canonical.end, pickerCalendar: picker, startZone: melbourne.timeZone, endZone: shanghai.timeZone)!
                        let roundtrip = EventEditorDates.allDayFromTimed(start: timed.start, end: timed.end, startZone: melbourne.timeZone, endZone: shanghai.timeZone, pickerCalendar: picker)!
                        precondition(roundtrip.start == canonical.start && roundtrip.end == canonical.end)
                    }
                }
            }
            let allDay = EventEditorDates.allDayFromTimed(start: departure, end: arrival, startZone: melbourne.timeZone, endZone: shanghai.timeZone, pickerCalendar: picker)!
            precondition(civil(allDay.start, picker) == "2026-11-28 00:00:00")
            precondition(civil(allDay.end, picker) == "2026-11-29 23:59:59")
        }

        let titleOnly = EventUpdateInput(calendarId: nil, summary: "New title", description: nil, location: nil, startsAt: nil, endsAt: nil, allDay: true, rrule: nil, extra: nil, scope: nil, recurrenceId: nil, exdates: nil)
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(titleOnly)) as! [String: Any]
        precondition(payload["startsAt"] == nil && payload["endsAt"] == nil)
        // Search/display names must include the city, not only a shared regional zone.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_Hans_CN")
        formatter.dateFormat = "VVV"
        formatter.timeZone = melbourne.timeZone
        precondition(formatter.string(from: departure) == "墨尔本")
        formatter.timeZone = shanghai.timeZone
        precondition(formatter.string(from: arrival) == "上海")
        print("EventEndpointTimeZoneCheck passed: endpoint inheritance, 9h Melbourne–Shanghai trip, exact instants/copy, DST gaps/folds including fractional and half-hour offsets, both all-day formats across 3 zones, round-trip civil dates and localized city names")
    }
}
