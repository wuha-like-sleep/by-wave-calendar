import Foundation

@main struct BookingTimeZoneCheck {
    static func main() throws {
        let original = NSTimeZone.default
        defer { NSTimeZone.default = original }
        let iso = ISO8601DateFormatter()
        let booking = iso.date(from: "2026-11-16T00:30:00Z")!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let exactBooking = try decoder.decode(EventDTO.self, from: Data("""
        {"id":"booking","calendarId":"c","summary":"Meeting","startsAt":"2026-11-16T01:00:00Z","endsAt":"2026-11-16T01:30:00Z","allDay":false,"extra":{"timezone":"Australia/Melbourne"}}
        """.utf8))
        precondition(exactBooking.extra?.timezone == "Australia/Melbourne")
        for (zone, clock) in [("Australia/Melbourne", "12:00"), ("Asia/Shanghai", "09:00")] {
            NSTimeZone.default = TimeZone(identifier: zone)!
            precondition(DateFormatters.timeShort.string(from: exactBooking.startsAt) == clock)
            precondition(fractional.date(from: EventEditorDates.timedISO(exactBooking.startsAt)) == exactBooking.startsAt)
        }
        let precise = fractional.date(from: "2026-11-01T06:30:00.123Z")!
        precondition(fractional.date(from: EventEditorDates.timedISO(precise)) == precise)
        let allDay = iso.date(from: "2026-11-16T00:00:00Z")!
        let originalAllDay = DateFormatters.fullDateUTC.string(from: allDay)
        for (zone, clock, day) in [
            ("Asia/Shanghai", "08:30", 16),
            ("America/New_York", "19:30", 15),
            ("Australia/Melbourne", "11:30", 16),
        ] {
            NSTimeZone.default = TimeZone(identifier: zone)!
            precondition(DateFormatters.refreshDeviceTimeZone().identifier == zone)
            precondition(DateFormatters.timeShort.string(from: booking) == clock)
            precondition(Calendar.current.component(.day, from: booking) == day)
            precondition(DateFormatters.fullDateUTC.string(from: allDay) == originalAllDay)
        }
        NSTimeZone.default = TimeZone(identifier: "America/New_York")!
        precondition(DateFormatters.timeShort.string(from: iso.date(from: "2026-03-08T06:30:00Z")!) == "01:30")
        precondition(DateFormatters.timeShort.string(from: iso.date(from: "2026-03-08T07:30:00Z")!) == "03:30")
        precondition(bookingTimeZone("America/New_York", calendar: "Asia/Shanghai") == "America/New_York")
        precondition(bookingTimeZone(nil, calendar: "Australia/Melbourne") == "Australia/Melbourne")
        precondition(bookingTimeZone(nil, calendar: "invalid") == "Asia/Shanghai")
        print("Booking timezone: cached formatters refresh across 3 zones, midnight/DST and all-day invariants passed")
    }
}
