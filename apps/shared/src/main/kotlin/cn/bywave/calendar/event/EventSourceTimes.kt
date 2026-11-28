package cn.bywave.calendar.event

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

private val eventRegionIds: Set<String> = ZoneId.getAvailableZoneIds()

fun eventRegionZone(value: String?): ZoneId? =
    value?.trim()?.takeIf { it in eventRegionIds }?.let(ZoneId::of)

/** Secondary time in the event's original zone(s) for Android and desktop details. */
fun eventSourceTimes(
    startsAt: String, endsAt: String, startTimezone: String?, endTimezone: String?,
    calendarTimezone: String?, displayZone: ZoneId, locale: Locale,
): String? {
    val origin = eventRegionZone(startTimezone) ?: eventRegionZone(calendarTimezone)
    val destination = eventRegionZone(endTimezone) ?: origin ?: return null
    if (origin == destination && origin.normalized() == displayZone.normalized()) return null
    val start = runCatching { Instant.parse(startsAt) }.getOrNull() ?: return null
    val end = runCatching { Instant.parse(endsAt) }.getOrNull() ?: return null
    val dateTime = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale)
    val arrival = end.atZone(destination)
    if (origin == null) return "${destination.id} · ${dateTime.format(arrival)}"
    val departure = start.atZone(origin)
    if (origin != destination) {
        return "${origin.id} · ${dateTime.format(departure)}\n→ ${destination.id} · ${dateTime.format(arrival)}"
    }
    val endFormat = if (departure.toLocalDate() == arrival.toLocalDate())
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale) else dateTime
    val offsetsDiffer = departure.offset != arrival.offset
    val first = dateTime.format(departure) + if (offsetsDiffer) " ${departure.offset}" else ""
    val last = endFormat.format(arrival) + if (offsetsDiffer) " ${arrival.offset}" else ""
    return "${origin.id} · $first – $last"
}
