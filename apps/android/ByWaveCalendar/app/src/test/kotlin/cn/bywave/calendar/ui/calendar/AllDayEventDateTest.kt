package cn.bywave.calendar.ui.calendar

import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.event.eventAllDayDates
import java.time.LocalDate
import java.util.TimeZone
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

class AllDayEventDateTest {
    @Test fun `all-day events occupy their calendar dates in every device zone`() {
        val original = TimeZone.getDefault()
        try {
            for (zone in listOf("America/Los_Angeles", "Australia/Melbourne", "Pacific/Auckland")) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone))
                val event = EventDTO(id = "e", calendarId = "c", summary = "Holiday", startsAt = "2026-11-16T00:00:00Z", endsAt = "2026-11-16T23:59:59.999Z", allDay = true)
                assertFalse(eventOnDay(event, LocalDate.parse("2026-11-15")))
                assertTrue(eventOnDay(event, LocalDate.parse("2026-11-16")))
                assertFalse(eventOnDay(event, LocalDate.parse("2026-11-17")))
                val multi = event.copy(endsAt = "2026-11-18T23:59:59Z")
                assertTrue(eventOnDay(multi, LocalDate.parse("2026-11-17")))
                assertTrue(eventOnDay(multi, LocalDate.parse("2026-11-18")))
                assertFalse(eventOnDay(multi, LocalDate.parse("2026-11-19")))
            }
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `both inclusive and legacy exclusive all-day end dates produce the same visible range`() {
        val start = "2026-11-16T00:00:00Z"
        val expected = LocalDate.parse("2026-11-16") to LocalDate.parse("2026-11-16")
        assertEquals(expected, eventAllDayDates(start, "2026-11-16T23:59:59Z"))
        assertEquals(expected, eventAllDayDates(start, "2026-11-17T00:00:00Z"))
    }
}
