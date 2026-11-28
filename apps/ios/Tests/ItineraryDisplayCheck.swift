import Foundation

@main struct ItineraryDisplayCheck {
    static func calendar(_ identifier: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: identifier)!
        return calendar
    }

    static func local(_ calendar: Calendar, month: Int, day: Int, hour: Int, minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))!
    }

    static func main() throws {
        let melbourne = calendar("Australia/Melbourne")
        let shanghai = calendar("Asia/Shanghai")
        let start = local(melbourne, month: 11, day: 28, hour: 23)
        let end = local(shanghai, month: 11, day: 29, hour: 5)
        precondition(end.timeIntervalSince(start) == 9 * 3600)
        let winterStart = local(melbourne, month: 7, day: 28, hour: 23)
        let winterEnd = local(shanghai, month: 7, day: 29, hour: 5)
        precondition(winterEnd.timeIntervalSince(winterStart) == 8 * 3600)

        let islandStart = local(calendar("Pacific/Kiritimati"), month: 11, day: 29, hour: 1)
        let hawaiiEnd = local(calendar("Pacific/Honolulu"), month: 11, day: 28, hour: 8)
        precondition(hawaiiEnd.timeIntervalSince(islandStart) == 7 * 3600)

        let metadata = try JSONDecoder().decode(EventExtraDTO.self, from: Data("""
          {"timezone":"Australia/Melbourne","endTimezone":"Asia/Shanghai"}
          """.utf8))
        let flight = EventDTO(id: "trip", calendarId: "test", summary: "MEL–PVG", description: nil,
                              location: nil, startsAt: start, endsAt: end, allDay: false, rrule: nil,
                              exdates: nil, isOccurrence: nil, extra: metadata)
        precondition(AllDayDates.itineraryZones(flight)?.start == melbourne.timeZone)
        precondition(AllDayDates.itineraryZones(flight)?.end == shanghai.timeZone)
        let utc = calendar("UTC")
        for (viewer, departureMinutes, arrivalMinutes) in [(melbourne, 1380.0, 480.0), (shanghai, 1200.0, 300.0)] {
            let first = viewer.dateInterval(of: .day, for: start)!
            let last = viewer.dateInterval(of: .day, for: end)!
            precondition(first.end == last.start)
            precondition(AllDayDates.showsInMonthCell(flight, localDay: first.start, calendar: viewer))
            precondition(AllDayDates.showsInMonthCell(flight, localDay: last.start, calendar: viewer))
            precondition(!AllDayDates.showsInMonthCell(flight, localDay: last.end, calendar: viewer))
            precondition(CalendarDisplayDates.timelineMinutes(start: start, end: end, day: first, calendar: viewer) == departureMinutes..<1440)
            precondition(CalendarDisplayDates.timelineMinutes(start: start, end: end, day: last, calendar: viewer) == 0..<arrivalMinutes)
            precondition(CalendarDisplayDates.timelineMinutes(start: start, end: last.start, day: last, calendar: viewer).isEmpty)
        }
        precondition(utc.isDate(start, inSameDayAs: end))
        precondition(!AllDayDates.showsInMonthCell(flight, localDay: local(utc, month: 11, day: 29, hour: 0), calendar: utc))

        let selection = CalendarDaySelection(start, calendar: melbourne)
        precondition(selection.date(in: shanghai, fallback: end) == local(shanghai, month: 11, day: 28, hour: 0))

        let firstUTC = local(utc, month: 11, day: 28, hour: 0)
        for (endDate, lastDay) in [(firstUTC.addingTimeInterval(86399), 28), (firstUTC.addingTimeInterval(86400), 28),
                                   (firstUTC.addingTimeInterval(172799), 29)] {
            let allDay = EventDTO(id: "all", calendarId: "test", summary: "Day", description: nil,
                                  location: nil, startsAt: firstUTC, endsAt: endDate, allDay: true, rrule: nil,
                                  exdates: nil, isOccurrence: nil, extra: metadata)
            precondition(AllDayDates.itineraryZones(allDay) == nil)
            precondition(utc.component(.day, from: AllDayDates.lastInclusiveUTCDay(of: allDay)) == lastDay)
            precondition(AllDayDates.isSingleDay(allDay) == (lastDay == 28))
        }

        let springStart = local(melbourne, month: 10, day: 4, hour: 1, minute: 30)
        let springEnd = local(melbourne, month: 10, day: 4, hour: 3, minute: 30)
        let springDay = melbourne.dateInterval(of: .day, for: springStart)!
        precondition(springEnd.timeIntervalSince(springStart) == 3600)
        precondition(CalendarDisplayDates.timelineMinutes(start: springStart, end: springEnd, day: springDay, calendar: melbourne) == 90..<210)

        let repeatedStart = local(utc, month: 4, day: 4, hour: 15, minute: 45)
        let repeatedEnd = repeatedStart.addingTimeInterval(30 * 60)
        let repeatedDay = melbourne.dateInterval(of: .day, for: repeatedStart)!
        precondition(CalendarDisplayDates.timelineMinutes(start: repeatedStart, end: repeatedEnd, day: repeatedDay, calendar: melbourne) == 165..<195)

        let now = local(melbourne, month: 11, day: 29, hour: 1)
        for selected in [29, 30] {
            let old = local(melbourne, month: 11, day: selected, hour: 0)
            let new = CalendarDisplayDates.selectedDay(old, now: now, calendar: melbourne, from: melbourne.timeZone, to: shanghai.timeZone)
            precondition(new == local(shanghai, month: 11, day: selected == 29 ? 28 : 30, hour: 0))
        }
        print("ItineraryDisplayCheck passed")
    }
}
