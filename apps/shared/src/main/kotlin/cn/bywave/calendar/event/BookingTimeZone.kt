package cn.bywave.calendar.event

import java.time.ZoneId

/** Availability is wall time in the owner's calendar, never the viewer's device zone. */
fun bookingTimeZone(explicit: String?, calendar: String?): String =
    sequenceOf(explicit, calendar, "Asia/Shanghai").mapNotNull { value ->
        value?.takeIf { it.isNotBlank() }?.let { runCatching { ZoneId.of(it).id }.getOrNull() }
    }.first()
