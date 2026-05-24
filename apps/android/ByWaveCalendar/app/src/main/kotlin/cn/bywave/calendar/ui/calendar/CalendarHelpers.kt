// Shared helpers for the three calendar views. Keep formatters + color
// parsing in one place so DayView / WeekView / MonthView don't drift.
//
// All time math is in the device's local TimeZone via ZoneId.systemDefault().
// Matches iOS (Calendar.current uses system TZ); both clients render the
// same UTC instant in the user's local clock.

package cn.bywave.calendar.ui.calendar

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

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

/** Parse the server's ISO8601 string. Returns null on bad data. */
internal fun parseInstant(iso: String?): Instant? =
    iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

internal fun toLocal(i: Instant?): LocalDateTime? =
    i?.atZone(ZoneId.systemDefault())?.toLocalDateTime()

internal fun toLocalDate(i: Instant?): LocalDate? =
    i?.atZone(ZoneId.systemDefault())?.toLocalDate()

/** True if `event` touches the given day in the device's local TZ. */
internal fun eventOnDay(event: EventDTO, day: LocalDate): Boolean {
    val zone = ZoneId.systemDefault()
    val s = parseInstant(event.startsAt) ?: return false
    val e = parseInstant(event.endsAt) ?: return false
    val dayStart = day.atStartOfDay(zone).toInstant()
    val dayEnd = day.plusDays(1).atStartOfDay(zone).toInstant()
    return s.isBefore(dayEnd) && e.isAfter(dayStart)
}

/** Mon-anchored start of the week containing `date`. Mirrors iOS
 *  startOfWeek which sets firstWeekday=2. */
internal fun startOfWeek(date: LocalDate): LocalDate =
    date.minusDays((date.dayOfWeek.value - DayOfWeek.MONDAY.value).toLong())

internal fun dayStartsOfWeek(anchor: LocalDate): List<LocalDate> {
    val start = startOfWeek(anchor)
    return (0L..6L).map { start.plusDays(it) }
}

// ---- Formatters ----

private val TIME_FMT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

internal fun formatTimeRange(event: EventDTO): String {
    if (event.allDay) return "全天"
    val s = parseInstant(event.startsAt) ?: return ""
    val e = parseInstant(event.endsAt) ?: return ""
    val sameDay = toLocalDate(s) == toLocalDate(e)
    return if (sameDay) "${TIME_FMT.format(s)} – ${TIME_FMT.format(e)}"
           else "${TIME_FMT.format(s)} – …" // multi-day; detail screen shows full dates
}

private val ANCHOR_DAY_FMT = DateTimeFormatter.ofPattern("yyyy 年 M 月 d 日 EEEE")
private val ANCHOR_WEEK_FMT = DateTimeFormatter.ofPattern("M 月 d 日")
private val ANCHOR_MONTH_FMT = DateTimeFormatter.ofPattern("yyyy 年 M 月")
private val ANCHOR_YEAR_FMT = DateTimeFormatter.ofPattern("yyyy 年")

internal fun formatAnchor(mode: ViewMode, anchor: LocalDate): String = when (mode) {
    ViewMode.Day -> ANCHOR_DAY_FMT.format(anchor)
    ViewMode.Week -> {
        val s = startOfWeek(anchor); val e = s.plusDays(6)
        "${ANCHOR_WEEK_FMT.format(s)} – ${ANCHOR_WEEK_FMT.format(e)}"
    }
    ViewMode.Month -> ANCHOR_MONTH_FMT.format(anchor)
}

@Composable
internal fun mutedTextColor() = MaterialTheme.colorScheme.onSurfaceVariant
