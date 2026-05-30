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
    static let timeShort: DateFormatter = makeFixed("HH:mm")
    /// Month/day + time for multi-day events; CLDR orders the fields per
    /// locale, "H" keeps 24-hour time.
    static let dateTimeShort: DateFormatter = makeTemplate("MdHm")
    /// Month + day ("5月25日" / "May 25"). Month-view day sheet + all-day pill.
    static let monthDay: DateFormatter = makeTemplate("MMMd")
    /// Abbreviated weekday for week-view headers ("周一" / "Mon" / "Lun").
    static let weekdayShort: DateFormatter = makeFixed("EEE")

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
    private static func makeTemplate(_ template: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale.current
        f.setLocalizedDateFormatFromTemplate(template)
        return f
    }
}
