package cn.bywave.calendar.sync

import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.event.eventRegionZone
import java.time.Instant
import java.time.ZoneOffset

internal data class SystemCalendarTimes(val startMillis: Long, val endMillis: Long, val startZone: String, val endZone: String)
internal fun validSystemCalendarZone(value: String?): String? = eventRegionZone(value)?.id

/** Provider timestamps are absolute UTC milliseconds. Zones describe the
 * source clocks; the phone's current viewing zone must never replace them. */
internal fun systemCalendarTimes(event: EventDTO, calendarZone: String?): SystemCalendarTimes? {
    val start = runCatching { Instant.parse(event.startsAt) }.getOrNull() ?: return null
    val end = runCatching { Instant.parse(event.endsAt) }.getOrNull() ?: return null
    if (event.allDay) {
        // CalendarProvider requires exclusive UTC midnight bounds, including
        // older ByWave events whose final day ended at 23:59:59 instead.
        val first = start.atZone(ZoneOffset.UTC).toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant()
        val endDay = end.atZone(ZoneOffset.UTC).toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant()
        val last = if (end == endDay && end > first) end else endDay.plusSeconds(86400)
        return SystemCalendarTimes(first.toEpochMilli(), last.toEpochMilli(), "UTC", "UTC")
    }
    val origin = validSystemCalendarZone(event.extra?.timezone) ?: validSystemCalendarZone(calendarZone) ?: "UTC"
    return SystemCalendarTimes(start.toEpochMilli(), end.toEpochMilli(), origin, validSystemCalendarZone(event.extra?.endTimezone) ?: origin)
}
