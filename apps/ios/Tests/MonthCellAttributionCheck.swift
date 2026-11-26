import Foundation

// 月视图格子归属校验（AllDayDates.showsInMonthCell）：
// 全天事件挂它占的每一格，定时事件只挂开始日一格 —— 跨午夜的
// 定时事件在次日格子里再挂一条，看起来像重复事件。同时钉住
// occupies 的口径不变：日 / 周视图按实际时段画，跨午夜事件在
// 次日凌晨那段仍然占格。本机无 Xcode 工具链，这份脚本随代码
// 提交、在有工具链的环境按其余 *Check.swift 的方式编译运行
// （依赖 Models.swift 的 EventDTO 与 AllDayDates.swift）。
@main struct MonthCellAttributionCheck {
    static func dto(startsAt: String, endsAt: String, allDay: Bool) throws -> EventDTO {
        try JSONDecoder.iso().decode(EventDTO.self, from: Data("""
        {"id":"e1","calendarId":"c1","summary":"s","startsAt":"\(startsAt)","endsAt":"\(endsAt)","allDay":\(allDay)}
        """.utf8))
    }

    static func calendar(_ tz: String) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: tz) ?? TimeZone(secondsFromGMT: 0)!
        return c
    }

    /// 某时区日历上的某一天（当地正午，避开日界抖动）。
    static func day(_ cal: Calendar, _ y: Int, _ m: Int, _ d: Int) -> Date {
        cal.date(from: DateComponents(year: y, month: m, day: d, hour: 12))!
    }

    static func main() throws {
        let sydney = calendar("Australia/Sydney")  // 12 月为 UTC+11

        // ---- 跨午夜定时事件（用户截图里的「酒局」）：25 号 22:00 →
        //      26 号 04:00（+11）。月格只挂 25 号；occupies 两天都占，
        //      日视图里 26 号凌晨那段照常画。 ----
        let lateNight = try dto(startsAt: "2026-12-25T11:00:00.000Z",
                                endsAt: "2026-12-25T17:00:00.000Z", allDay: false)
        precondition(AllDayDates.showsInMonthCell(lateNight, localDay: day(sydney, 2026, 12, 25), calendar: sydney))
        precondition(!AllDayDates.showsInMonthCell(lateNight, localDay: day(sydney, 2026, 12, 26), calendar: sydney))
        precondition(!AllDayDates.showsInMonthCell(lateNight, localDay: day(sydney, 2026, 12, 24), calendar: sydney))
        precondition(AllDayDates.occupies(lateNight, localDay: day(sydney, 2026, 12, 25), calendar: sydney))
        precondition(AllDayDates.occupies(lateNight, localDay: day(sydney, 2026, 12, 26), calendar: sydney))

        // ---- 恰好午夜结束的定时事件：只挂开始日（半开区间）。 ----
        let endsAtMidnight = try dto(startsAt: "2026-12-25T09:00:00.000Z",
                                     endsAt: "2026-12-25T13:00:00.000Z", allDay: false)
        precondition(AllDayDates.showsInMonthCell(endsAtMidnight, localDay: day(sydney, 2026, 12, 25), calendar: sydney))
        precondition(!AllDayDates.showsInMonthCell(endsAtMidnight, localDay: day(sydney, 2026, 12, 26), calendar: sydney))

        // ---- 多天定时事件（25 号 09:00 → 27 号 17:00，+11）：
        //      月格只挂开始日；occupies 三天都占。 ----
        let multiDay = try dto(startsAt: "2026-12-24T22:00:00.000Z",
                               endsAt: "2026-12-27T06:00:00.000Z", allDay: false)
        precondition(AllDayDates.showsInMonthCell(multiDay, localDay: day(sydney, 2026, 12, 25), calendar: sydney))
        precondition(!AllDayDates.showsInMonthCell(multiDay, localDay: day(sydney, 2026, 12, 26), calendar: sydney))
        precondition(!AllDayDates.showsInMonthCell(multiDay, localDay: day(sydney, 2026, 12, 27), calendar: sydney))
        precondition(AllDayDates.occupies(multiDay, localDay: day(sydney, 2026, 12, 26), calendar: sydney))
        precondition(AllDayDates.occupies(multiDay, localDay: day(sydney, 2026, 12, 27), calendar: sydney))

        // ---- 普通单日定时事件：只挂当天。 ----
        let sameDay = try dto(startsAt: "2026-12-25T01:00:00.000Z",
                              endsAt: "2026-12-25T02:00:00.000Z", allDay: false)
        precondition(AllDayDates.showsInMonthCell(sameDay, localDay: day(sydney, 2026, 12, 25), calendar: sydney))
        precondition(!AllDayDates.showsInMonthCell(sameDay, localDay: day(sydney, 2026, 12, 26), calendar: sydney))

        // ---- 开始日按「看的那台设备的日历」算：同一条酒局在 UTC
        //      日历上开始于 25 号 11:00，挂 25 号不挂 26 号。 ----
        let utc = calendar("UTC")
        precondition(AllDayDates.showsInMonthCell(lateNight, localDay: day(utc, 2026, 12, 25), calendar: utc))
        precondition(!AllDayDates.showsInMonthCell(lateNight, localDay: day(utc, 2026, 12, 26), calendar: utc))

        // ---- 全天单日事件：挂它的 UTC 日期那一格，在 UTC 以西的
        //      日历上也不错位到前一天。 ----
        let allDaySingle = try dto(startsAt: "2026-12-25T00:00:00.000Z",
                                   endsAt: "2026-12-26T00:00:00.000Z", allDay: true)
        precondition(AllDayDates.showsInMonthCell(allDaySingle, localDay: day(sydney, 2026, 12, 25), calendar: sydney))
        precondition(!AllDayDates.showsInMonthCell(allDaySingle, localDay: day(sydney, 2026, 12, 24), calendar: sydney))
        let newYork = calendar("America/New_York")
        precondition(AllDayDates.showsInMonthCell(allDaySingle, localDay: day(newYork, 2026, 12, 25), calendar: newYork))
        precondition(!AllDayDates.showsInMonthCell(allDaySingle, localDay: day(newYork, 2026, 12, 24), calendar: newYork))

        // ---- 全天多日事件（25 → 28 日 UTC，三天）：三格都挂，
        //      结束日（开区间）不挂。 ----
        let allDayMulti = try dto(startsAt: "2026-12-25T00:00:00.000Z",
                                  endsAt: "2026-12-28T00:00:00.000Z", allDay: true)
        for d in [25, 26, 27] {
            precondition(AllDayDates.showsInMonthCell(allDayMulti, localDay: day(sydney, 2026, 12, d), calendar: sydney))
        }
        precondition(!AllDayDates.showsInMonthCell(allDayMulti, localDay: day(sydney, 2026, 12, 28), calendar: sydney))

        print("MonthCellAttributionCheck: all preconditions passed")
    }
}
