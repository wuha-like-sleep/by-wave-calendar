package cn.bywave.calendar.desktop.ui.event

import cn.bywave.calendar.event.EventFormInstant
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** Resolve this draft's clock, not the process default. Keep the selected side
 * of a repeated DST hour for both unchanged and nearby edited times. */
internal fun draftInstant(value: LocalDateTime, zone: ZoneId, original: EventFormInstant?): Instant {
    val previous = original?.iso?.let { runCatching { Instant.parse(it) }.getOrNull() }
    if (previous != null && original.displayed == value) return previous
    return ZonedDateTime.ofLocal(value, zone, previous?.atZone(zone)?.offset).toInstant()
}

private fun snapshot(instant: Instant, zone: ZoneId) =
    EventFormInstant(instant.toString(), instant.atZone(zone).toLocalDateTime())

internal fun FormState.withDisplayZone(zone: ZoneId): FormState {
    if (displayZone == zone) return this
    // All-day values are calendar dates, never instants to offset.
    if (allDay) return copy(displayZone = zone)
    val first = snapshot(draftInstant(start, displayZone, originalStart), zone)
    val last = snapshot(draftInstant(end, displayZone, originalEnd), zone)
    return copy(displayZone = zone, start = first.displayed, end = last.displayed,
        originalStart = first, originalEnd = last)
}

internal fun FormState.withStart(value: LocalDateTime, selected: EventFormInstant? = null): FormState {
    if (allDay) {
        val duration = Duration.between(start, end).toMinutes().coerceAtLeast(15)
        return copy(start = value, end = value.plusMinutes(duration))
    }
    val duration = Duration.between(draftInstant(start, displayZone, originalStart), draftInstant(end, displayZone, originalEnd))
        .coerceAtLeast(Duration.ofMinutes(15))
    val first = snapshot(draftInstant(value, displayZone, selected ?: originalStart), displayZone)
    val last = snapshot(Instant.parse(first.iso).plus(duration), displayZone)
    return copy(start = first.displayed, end = last.displayed, originalStart = first, originalEnd = last)
}

internal fun FormState.withEnd(value: LocalDateTime, selected: EventFormInstant? = null): FormState {
    if (allDay) return copy(end = if (value.isBefore(start)) start else value)
    val first = draftInstant(start, displayZone, originalStart)
    val picked = draftInstant(value, displayZone, selected ?: originalEnd)
    val last = snapshot(if (picked.isAfter(first)) picked else first.plusSeconds(900), displayZone)
    return copy(end = last.displayed, originalEnd = last)
}

/** Unconfirmed picker input has its own zone. A system change converts that
 * pending choice without applying it to the form; Cancel still discards it. */
internal data class EventPickerDraft(
    val value: LocalDateTime,
    val zone: ZoneId,
    val allDay: Boolean,
    val original: EventFormInstant? = null,
) {
    fun withDate(date: LocalDate) = copy(value = LocalDateTime.of(date, value.toLocalTime()))

    fun withTime(hour: Int, minute: Int): EventPickerDraft =
        if (value.hour == hour && value.minute == minute) this
        else copy(value = value.withHour(hour).withMinute(minute).withSecond(0).withNano(0))

    fun withDisplayZone(target: ZoneId): EventPickerDraft {
        if (allDay) return copy(zone = target)
        val selected = snapshot(draftInstant(value, zone, original), target)
        return copy(value = selected.displayed, zone = target, original = selected)
    }
}
