// Shared helpers for the calendar views. Direct port of the Android
// CalendarHelpers.kt — same time math, same color parsing, same
// formatters. Keep these in sync when Android changes them; the rule of
// thumb is: WeekView/MonthView render the same way on phone + desktop.
//
// All time math goes through ZoneId.systemDefault() so the user's
// local clock matches what they see on web + mobile.

package cn.bywave.calendar.desktop.ui.calendar

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters

internal val FALLBACK_COLOR = Color(0xFF6640E9)

internal fun parseHex(hex: String?): Color {
    if (hex.isNullOrBlank()) return FALLBACK_COLOR
    val cleaned = hex.removePrefix("#")
    return runCatching {
        val v = cleaned.toLong(16)
        Color(
            red = ((v shr 16) and 0xff) / 255f,
            green = ((v shr 8) and 0xff) / 255f,
            blue = (v and 0xff) / 255f,
        )
    }.getOrDefault(FALLBACK_COLOR)
}

internal fun calendarColor(event: EventDTO, calendars: List<CalendarMeta>): Color =
    parseHex(calendars.firstOrNull { it.id == event.calendarId }?.color)

internal fun calendarName(event: EventDTO, calendars: List<CalendarMeta>): String? =
    calendars.firstOrNull { it.id == event.calendarId }?.name

internal fun parseInstant(iso: String?): Instant? =
    iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

internal fun toLocalDate(i: Instant?): LocalDate? =
    i?.atZone(ZoneId.systemDefault())?.toLocalDate()

internal fun toLocalDateTime(i: Instant?): LocalDateTime? =
    i?.atZone(ZoneId.systemDefault())?.toLocalDateTime()

/** True if `event` touches the given day in the device's local TZ. */
internal fun eventOnDay(event: EventDTO, day: LocalDate): Boolean {
    val zone = ZoneId.systemDefault()
    val s = parseInstant(event.startsAt) ?: return false
    val e = parseInstant(event.endsAt) ?: return false
    val dayStart = day.atStartOfDay(zone).toInstant()
    val dayEnd = day.plusDays(1).atStartOfDay(zone).toInstant()
    return s.isBefore(dayEnd) && e.isAfter(dayStart)
}

/** Mon-anchored start of the week containing `date`. */
internal fun startOfWeek(date: LocalDate): LocalDate =
    date.minusDays((date.dayOfWeek.value - DayOfWeek.MONDAY.value).toLong())

// ---- Formatters ----
//
// Date-format PATTERNS are themselves localized (the "M 月 d 日" style is
// Chinese-only; en/ja/ko/es/fr/de get their own pattern via i18n keys
// fmt.*). Resolving the pattern through I18n.t() at call time means these
// helpers re-render in the new language the moment the user switches —
// provided the calling composable observes I18n.current (which the views
// do). The DateTimeFormatter is rebuilt per call (cheap; avoids caching a
// stale-locale pattern). The display zone stays the device default.

private fun t(key: String): String = cn.bywave.calendar.desktop.i18n.I18n.t(key)
private fun t(key: String, vars: Map<String, Any>): String =
    cn.bywave.calendar.desktop.i18n.I18n.t(key, vars)

private fun fmt(patternKey: String): DateTimeFormatter =
    DateTimeFormatter.ofPattern(t(patternKey), localeForFormat()).withZone(ZoneId.systemDefault())

/** java.util.Locale to drive month/weekday names inside DateTimeFormatter
 *  (EEEE / MMM tokens). Mirrors the UI locale. */
private fun localeForFormat(): java.util.Locale =
    java.util.Locale.forLanguageTag(cn.bywave.calendar.desktop.i18n.I18n.current.value.code)

private val TIME_FMT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

internal fun formatTimeRange(event: EventDTO): String {
    if (event.allDay) return t("fmt.timeAllDay")
    val s = parseInstant(event.startsAt) ?: return ""
    val e = parseInstant(event.endsAt) ?: return ""
    val sameDay = toLocalDate(s) == toLocalDate(e)
    return if (sameDay) "${TIME_FMT.format(s)} – ${TIME_FMT.format(e)}"
           else "${TIME_FMT.format(s)} – …"
}

internal fun formatWeekAnchor(weekStart: LocalDate): String {
    val monthDay = fmt("fmt.monthDay")
    val end = weekStart.plusDays(6)
    val year = if (weekStart.year == LocalDate.now().year) ""
               else t("fmt.yearPrefix", mapOf("y" to weekStart.year))
    return "$year${monthDay.format(weekStart)} – ${monthDay.format(end)}"
}

internal fun formatMonthAnchor(date: LocalDate): String =
    fmt("fmt.monthAnchor").format(date)

internal fun formatDayAnchor(date: LocalDate): String =
    fmt("fmt.dayAnchor").format(date)

// ---- Month grid ----

/** Mon-anchored grid start — the Monday on or before the 1st of the month. */
internal fun monthGridStart(month: YearMonth): LocalDate {
    val first = month.atDay(1)
    return first.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
}

/** 42 cells (6 weeks × 7 days) starting at monthGridStart. */
internal fun monthGridDays(month: YearMonth): List<LocalDate> {
    val start = monthGridStart(month)
    return (0L until 42L).map { start.plusDays(it) }
}

// ---- View modes ----

enum class ViewMode {
    Day, Week, Month, Agenda,
}

@Composable
internal fun mutedTextColor() = MaterialTheme.colorScheme.onSurfaceVariant
