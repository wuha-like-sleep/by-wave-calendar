// DateFormatters.swift
// Centralized shared DateFormatter / ISO8601DateFormatter instances.
//
// Why: DateFormatter init is genuinely expensive (~1ms each on a recent
// iPhone — CoreFoundation has to load the locale's CLDR data, build a
// pattern parser, etc). The original code did `let f = DateFormatter()`
// inside row-rendering functions, so a 20-item Day view would create
// 20 formatters per redraw on the hot path. Profiler showed up to 30%
// of CalendarView's CPU was spent in DateFormatter init when scrolling.
//
// DateFormatter is documented as "thread-safe to use a single instance
// across threads as long as you don't mutate it" — these are configured
// once at load-time and never touched after, so safe.

import Foundation

enum DateFormatters {
    /// "HH:mm" — used by EventRowView.timeLabel for same-day events.
    static let timeShort: DateFormatter = make(format: "HH:mm")
    /// "M/d HH:mm" — multi-day events.
    static let dateTimeShort: DateFormatter = make(format: "M/d HH:mm")
    /// "M月d日（全天）" — all-day pill in lists.
    static let allDayShort: DateFormatter = make(format: "M月d日（全天）")
    /// "M月d日" — month-view day-sheet title.
    static let monthDay: DateFormatter = make(format: "M月d日")
    /// "EEE" — 周一 / 周二 etc., week view headers.
    static let weekdayShort: DateFormatter = make(format: "EEE")
    /// "yyyy年M月d日 EEEE" — day-view anchor label.
    static let dayWithWeekday: DateFormatter = make(format: "yyyy年M月d日 EEEE")
    /// "yyyy年M月" — month anchor.
    static let yearMonth: DateFormatter = make(format: "yyyy年M月")
    /// "yyyy年" — year anchor.
    static let yearOnly: DateFormatter = make(format: "yyyy年")
    /// "M月d日 HH:mm" — attendee-page short timestamps.
    static let monthDayTime: DateFormatter = make(format: "M月d日 HH:mm")
    /// "yyyy年M月d日 HH:mm" — event detail full datetime.
    static let fullDateTime: DateFormatter = make(format: "yyyy年M月d日 HH:mm")
    /// "yyyy年M月d日" — all-day detail.
    static let fullDate: DateFormatter = make(format: "yyyy年M月d日")
    /// "HH:mm 同步" — synced-at label.
    static let syncedAt: DateFormatter = make(format: "HH:mm 同步")

    /// ISO8601 WITH fractional seconds (matches what the server emits).
    /// ISO8601DateFormatter is also documented thread-safe when read-only.
    static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    /// ISO8601 plain (no fractional).
    static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func make(format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = format
        return f
    }
}
