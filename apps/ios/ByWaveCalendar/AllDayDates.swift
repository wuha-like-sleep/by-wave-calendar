// AllDayDates.swift
// 全天事件的「属于哪一天」。
//
// 服务端把全天事件的 startsAt / endsAt 存成「那一天的 UTC 午夜」，半开区间
// [start, end)。它们表示的是**日历日期**，不是时刻 —— 一个 9 月 21 日的全天
// 事件，在东京和在纽约都应该出现在 9 月 21 日那一格。
//
// 拿设备本地时区去解读这两个时刻，会在两个方向上出错，而且两边都不报错：
//
//   · UTC 以东（东八区）：9/21T00:00Z 落在本地 9 月 21 日 08:00，
//     于是区间 [9/21 08:00, 9/22 08:00) 同时压住本地的 21 日和 22 日两格。
//     实测表现：周视图的「全天」行里，一个「团建」并排画了两遍；
//     日视图翻到 22 号也能看到它。
//
//   · UTC 以西（纽约 -04）：9/21T00:00Z 落在本地 9 月 20 日 20:00，
//     月视图和年视图的圆点整体错到前一天。
//
// 所以「这个事件占不占某一天」一律走这里，不要再各处自己写 startOfDay 比较。
// 定时事件不受影响，它的 startsAt 本来就是真实时刻。

import Foundation

enum AllDayDates {
    private static let utcCalendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        // TimeZone(identifier:) 可空；UTC 一定存在，但不用 ! 免得哪天
        // 在一个裁剪过的运行时上直接崩掉 —— 退回 GMT 是同一个零偏移。
        c.timeZone = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0)!
        return c
    }()

    /// 本地日历上的某一天 → 全天事件所用的 UTC 半开区间 [start, end)。
    /// 做法是把那一格的「年月日」原样搬到 UTC 上，而不是做时区换算。
    static func utcRange(forLocalDay day: Date, calendar: Calendar) -> (start: Date, end: Date)? {
        let c = calendar.dateComponents([.year, .month, .day], from: day)
        guard let y = c.year, let m = c.month, let d = c.day,
              let start = utcCalendar.date(from: DateComponents(year: y, month: m, day: d)),
              let end = utcCalendar.date(byAdding: .day, value: 1, to: start) else { return nil }
        return (start, end)
    }

    /// 这个事件占不占本地日历上的这一天。
    /// 全天按 UTC 日期比，定时按本地时刻比 —— 两者都用半开区间，
    /// 所以刚好在午夜结束的事件不会渗到第二天。
    static func occupies(_ ev: EventDTO, localDay day: Date, calendar: Calendar = .current) -> Bool {
        if ev.allDay {
            guard let r = utcRange(forLocalDay: day, calendar: calendar) else { return false }
            return ev.startsAt < r.end && ev.endsAt > r.start
        }
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return false }
        return ev.startsAt < end && ev.endsAt > start
    }

    /// 事件的第一天，用本地日历的 Date 表示（按天分桶时当键用）。
    static func firstLocalDay(of ev: EventDTO, calendar: Calendar = .current) -> Date {
        guard ev.allDay else { return calendar.startOfDay(for: ev.startsAt) }
        let c = utcCalendar.dateComponents([.year, .month, .day], from: ev.startsAt)
        var local = DateComponents()
        local.year = c.year
        local.month = c.month
        local.day = c.day
        return calendar.date(from: local) ?? calendar.startOfDay(for: ev.startsAt)
    }

    /// 全天事件的最后一天（含）。iCalendar 的 DTEND 是开区间，
    /// 一个「9 月 21 日一天」的事件 endsAt 是 9 月 22 日 —— 直接拿去显示
    /// 就会告诉用户这是两天的事。
    static func lastInclusiveUTCDay(of ev: EventDTO) -> Date {
        utcCalendar.date(byAdding: .day, value: -1, to: ev.endsAt) ?? ev.startsAt
    }

    /// 是不是只占一天（全天事件专用）。
    static func isSingleDay(_ ev: EventDTO) -> Bool {
        utcCalendar.isDate(ev.startsAt, inSameDayAs: lastInclusiveUTCDay(of: ev))
    }
}
