import Foundation

@main struct EventEditorDatesCheck {
    static func main() throws {
        let iso = ISO8601DateFormatter()
        for zone in ["America/Los_Angeles", "Pacific/Auckland", "Australia/Melbourne"] {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: zone)!
            for day in ["2026-11-16", "2026-03-08", "2026-11-01"] {
                let sourceStart = iso.date(from: day + "T00:00:00Z")!
                let sourceEnd = iso.date(from: day + "T23:59:59Z")!
                let start = EventEditorDates.localAllDay(sourceStart, calendar: calendar)
                let end = EventEditorDates.localAllDay(sourceEnd, calendar: calendar)
                let formatted = DateFormatter()
                formatted.calendar = calendar
                formatted.timeZone = calendar.timeZone
                formatted.dateFormat = "yyyy-MM-dd"
                precondition(formatted.string(from: start) == day)
                precondition(formatted.string(from: end) == day)
                let late = calendar.date(bySettingHour: 23, minute: 30, second: 0, of: start)!
                let (copyStart, copyEnd) = EventEditorDates.duplicate(start: sourceStart, end: sourceEnd, allDay: true, from: late, calendar: calendar)
                precondition(formatted.string(from: copyStart) == day)
                precondition(formatted.string(from: copyEnd) == day)
                let (_, multiEnd) = EventEditorDates.duplicate(start: sourceStart, end: sourceEnd.addingTimeInterval(2 * 86400), allDay: true, from: late, calendar: calendar)
                precondition(calendar.dateComponents([.day], from: calendar.startOfDay(for: copyStart), to: calendar.startOfDay(for: multiEnd)).day == 2)
            }
        }
        let body = EventUpdateInput(calendarId: nil, summary: "Meeting", description: "", location: "", startsAt: nil, endsAt: nil, allDay: nil, rrule: nil, extra: nil, scope: nil, recurrenceId: nil)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as! [String: Any]
        precondition(json["description"] as? String == "")
        precondition(json["location"] as? String == "")
        print("Event editor: all-day dates and duplication across 3 zones/DST boundaries; cleared text fields passed")
    }
}
