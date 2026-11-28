package cn.bywave.calendar.sync

import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.EventExtraDTO
import java.time.Instant
import java.util.TimeZone
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class SystemCalendarTimesTest {
    private val event = EventDTO(id = "e", calendarId = "c", summary = "Meeting", startsAt = "2026-11-28T13:30:00Z", endsAt = "2026-11-28T14:30:00Z", extra = EventExtraDTO(timezone = "Australia/Melbourne"))
    @Test fun `source metadata does not shift absolute timestamps or follow the viewer`() {
        val before = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"))
            val times = systemCalendarTimes(event, "Asia/Tokyo")!!
            assertEquals(Instant.parse(event.startsAt).toEpochMilli(), times.startMillis)
            assertEquals(Instant.parse(event.endsAt).toEpochMilli(), times.endMillis)
            assertEquals("Australia/Melbourne", times.startZone)
            assertEquals(times.startZone, times.endZone)
            TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
            assertEquals(times, systemCalendarTimes(event, "Asia/Tokyo"))
        } finally { TimeZone.setDefault(before) }
    }
    @Test fun `missing or invalid event source falls back to calendar then UTC`() {
        assertEquals("Australia/Melbourne", systemCalendarTimes(event.copy(extra = null), "Australia/Melbourne")!!.startZone)
        assertEquals("UTC", systemCalendarTimes(event.copy(extra = EventExtraDTO(timezone = "Bad/Zone")), "Bad/Calendar")!!.startZone)
        assertEquals("Australia/Melbourne", systemCalendarTimes(event.copy(extra = EventExtraDTO(timezone = "+08:00")), "Australia/Melbourne")!!.startZone)
    }
    @Test fun `arrival metadata survives JSON and has its own provider zone`() {
        val trip = event.copy(extra = EventExtraDTO(timezone = "Australia/Melbourne", endTimezone = "Asia/Shanghai"))
        val decoded = Json.decodeFromString<EventDTO>(Json.encodeToString(EventDTO.serializer(), trip))
        val times = systemCalendarTimes(decoded, null)!!
        assertEquals("Asia/Shanghai", times.endZone)
        assertEquals(3600000L, times.endMillis - times.startMillis)
    }
    @Test fun `both all day storage formats become exclusive UTC midnight bounds`() {
        for (end in listOf("2026-11-29T00:00:00Z", "2026-11-28T23:59:59.999Z")) {
            val times = systemCalendarTimes(event.copy(allDay = true, startsAt = "2026-11-28T00:00:00Z", endsAt = end), "Australia/Melbourne")!!
            assertEquals("UTC", times.startZone); assertEquals("UTC", times.endZone)
            assertEquals(86400000L, times.endMillis - times.startMillis)
        }
    }
}
