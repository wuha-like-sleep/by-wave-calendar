import Foundation

enum CalendarDisplayDates {
    /// A selected day is a civil date. "Today" continues to follow the clock
    /// when the device crosses midnight by changing its time zone.
    static func selectedDay(_ date: Date, now: Date, calendar: Calendar, from oldZone: TimeZone, to newZone: TimeZone) -> Date {
        var old = calendar
        old.timeZone = oldZone
        var new = calendar
        new.timeZone = newZone
        if old.isDate(date, inSameDayAs: now) { return new.startOfDay(for: now) }
        let parts = old.dateComponents([.era, .year, .month, .day], from: date)
        return new.startOfDay(for: new.date(from: parts) ?? date)
    }

    /// Coordinates on a grid labeled 00:00 ... 24:00 in the viewer's zone.
    /// The elapsed flight duration can differ from this distance on DST days.
    static func timelineMinutes(start: Date, end: Date, day: DateInterval, calendar: Calendar) -> Range<Double> {
        func minute(_ date: Date) -> Double {
            let parts = calendar.dateComponents([.hour, .minute, .second], from: date)
            return Double(parts.hour ?? 0) * 60 + Double(parts.minute ?? 0) + Double(parts.second ?? 0) / 60
        }
        let clippedStart = max(day.start, min(start, day.end))
        let clippedEnd = max(clippedStart, min(end, day.end))
        let top = clippedStart == day.end ? 1440 : minute(clippedStart)
        var bottom = clippedEnd == day.end ? 1440 : minute(clippedEnd)
        // During a repeated hour the wall clock can appear to go backwards.
        if clippedEnd > clippedStart && bottom <= top {
            bottom = min(1440, top + clippedEnd.timeIntervalSince(clippedStart) / 60)
        }
        return top..<max(top, bottom)
    }
}

/// Keep an open day sheet on its displayed date across a system zone change.
struct CalendarDaySelection: Identifiable {
    let id: DateComponents

    init(_ date: Date, calendar: Calendar) {
        id = calendar.dateComponents([.era, .year, .month, .day], from: date)
    }

    func date(in calendar: Calendar, fallback: Date) -> Date {
        calendar.startOfDay(for: calendar.date(from: id) ?? fallback)
    }
}
