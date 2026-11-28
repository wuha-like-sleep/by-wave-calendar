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
// once per locale/zone and never mutated after publication, so safe.

import Foundation

enum DateFormatters {
    // Locale-aware. Previously every formatter hardcoded
    // `Locale(identifier: "zh_CN")` + Chinese patterns ("yyyy年M月d日",
    // "周一"…), so after the 8-language localization dates STILL rendered
    // Chinese-style in en/ja/ko/fr/de/es. Now they follow the app locale:
    // fixed patterns (HH:mm, EEE) just take the current locale; date
    // patterns use CLDR templates so field order + separators localize
    // ("5月25日" / "May 25" / "25 may"). Only the formatters actually in
    // use are kept — the dead ones (full date/time, year anchors, synced-at)
    // were replaced by inline locale-aware formatters elsewhere.

    /// Same-day event time. 24-hour + colon reads the same everywhere, so a
    /// fixed pattern is fine (only the locale's numerals differ).
    static var timeShort: DateFormatter { localFormatter("HH:mm", template: false) }
    /// Month/day + time for multi-day events; CLDR orders the fields per
    /// locale, "H" keeps 24-hour time.
    static var dateTimeShort: DateFormatter { localFormatter("MdHm", template: true) }
    /// Month + day ("5月25日" / "May 25"). Month-view day sheet + all-day pill.
    static var monthDay: DateFormatter { localFormatter("MMMd", template: true) }
    /// Abbreviated weekday for week-view headers ("周一" / "Mon" / "Lun").
    static var weekdayShort: DateFormatter { localFormatter("EEE", template: false) }

    /// 全天事件专用：模板一样，但按 UTC 渲染。
    /// 全天事件的 startsAt 存的是「那一天的 UTC 午夜」，用本地时区去渲染，
    /// UTC 以西的时区会把 9 月 21 日的全天事件写成 9 月 20 日。见 AllDayDates。
    static let monthDayUTC: DateFormatter = makeTemplate("MMMd", utc: true)
    /// 同上，带年份（事件详情页用）。
    static let fullDateUTC: DateFormatter = makeTemplate("yMMMd", utc: true)

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

    /// Foundation caches the system zone. Clear it on OS notifications and
    /// foregrounding; this does not alter the user's timezone or app override.
    static func refreshDeviceTimeZone() -> TimeZone {
        NSTimeZone.resetSystemTimeZone()
        return NSTimeZone.default
    }

    private static let localCache = NSCache<NSString, DateFormatter>()

    static func localFormatter(_ pattern: String, template: Bool, zone: TimeZone = NSTimeZone.default) -> DateFormatter {
        let locale = Locale.current
        let key = "\(zone.identifier)|\(locale.identifier)|\(template)|\(pattern)" as NSString
        if let cached = localCache.object(forKey: key) { return cached }
        let formatter = template ? makeTemplate(pattern) : makeFixed(pattern)
        formatter.timeZone = zone
        localCache.setObject(formatter, forKey: key)
        return formatter
    }

    static func zoneLabel(_ zone: TimeZone, at date: Date) -> String {
        let city = localFormatter("VVV", template: false, zone: zone).string(from: date)
        // CLDR returns a localized “unknown city” for fixed-offset zones.
        let unknownCity = localFormatter("VVV", template: false, zone: TimeZone(secondsFromGMT: 0)!).string(from: date)
        return city == unknownCity ? localFormatter("OOOO", template: false, zone: zone).string(from: date) : city
    }

    /// A date shared by both endpoints is printed once. On a clock change,
    /// give each endpoint its offset so a repeated hour is unambiguous.
    static func timedRange(start: Date, end: Date, zone: TimeZone, includeDate: Bool, includeYear: Bool) -> String {
        var calendar = Calendar.current
        calendar.timeZone = zone
        let sameDay = calendar.isDate(start, inSameDayAs: end)
        let yearNeeded = includeYear || !calendar.isDate(start, equalTo: end, toGranularity: .year)
        let date = localFormatter(yearNeeded ? "yMMMd" : "MMMd", template: true, zone: zone)
        let clocksChange = zone.secondsFromGMT(for: start) != zone.secondsFromGMT(for: end)
        let time = localFormatter(clocksChange ? "HH:mm OOOO" : "HH:mm", template: false, zone: zone)
        let startClock = time.string(from: start)
        let endClock = time.string(from: end)
        let startLabel = includeDate || !sameDay ? date.string(from: start) + " " + startClock : startClock
        let endLabel = sameDay ? endClock : date.string(from: end) + " " + endClock
        return startLabel + " – " + endLabel
    }

    /// Fixed pattern under the app's current locale (honors the in-app
    /// AppleLanguages override, which a language change relaunch applies).
    private static func makeFixed(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateFormat = format
        return f
    }

    /// Build from a CLDR field template (no literals) so the locale picks
    /// its own field order + separators. Locale must be set before the call.
    private static func makeTemplate(_ template: String, utc: Bool = false) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale.current
        f.setLocalizedDateFormatFromTemplate(template)
        if utc { f.timeZone = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0) }
        return f
    }
}
