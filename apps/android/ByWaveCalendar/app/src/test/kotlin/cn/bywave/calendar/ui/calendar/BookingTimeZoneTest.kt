package cn.bywave.calendar.ui.calendar

import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.event.bookingTimeZone
import java.time.Instant
import java.time.LocalDate
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.*
import org.junit.Test

class BookingTimeZoneTest {
    private val pattern: BestPatternProvider = { _, skeleton -> if (skeleton == "Hm") "HH:mm" else "yyyy-MM-dd" }
    private val booking = EventDTO(id = "b", calendarId = "c", summary = "Booking", startsAt = "2026-11-16T00:30:00Z", endsAt = "2026-11-16T01:00:00Z", allDay = false)

    @Test fun `Melbourne noon and Shanghai nine are the same booked instant regardless of source zone`() {
        val original = TimeZone.getDefault()
        try {
            val event = booking.copy(startsAt = "2026-11-16T01:00:00Z", endsAt = "2026-11-16T01:30:00Z",
                extra = cn.bywave.calendar.data.model.EventExtraDTO(timezone = "Australia/Melbourne"))
            TimeZone.setDefault(TimeZone.getTimeZone("Australia/Melbourne"))
            assertEquals("12:00 – 12:30", formatTimeRange(event, CalendarFormats(Locale.US, true, pattern), "All day"))
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"))
            assertEquals("09:00 – 09:30", formatTimeRange(event, CalendarFormats(Locale.US, true, pattern), "All day"))
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `device zone determines booked clock time and calendar day`() {
        val original = TimeZone.getDefault()
        try {
            for ((zone, expected, day) in listOf(
                Triple("Asia/Shanghai", "08:30 – 09:00", "2026-11-16"),
                Triple("America/New_York", "19:30 – 20:00", "2026-11-15"),
                Triple("Australia/Melbourne", "11:30 – 12:00", "2026-11-16"),
            )) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone))
                val formats = CalendarFormats(Locale.US, true, pattern)
                assertEquals(expected, formatTimeRange(booking, formats, "All day"))
                assertTrue(eventOnDay(booking, LocalDate.parse(day)))
                assertFalse(eventOnDay(booking, LocalDate.parse(day).plusDays(1)))
            }
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `DST changes displayed clocks while booked duration is preserved`() {
        val original = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
            val formats = CalendarFormats(Locale.US, true, pattern)
            assertEquals("01:30", formats.time.format(Instant.parse("2026-03-08T06:30:00Z")))
            assertEquals("03:30", formats.time.format(Instant.parse("2026-03-08T07:30:00Z")))
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `availability uses explicit or calendar zone and legacy fallback`() {
        assertEquals("America/New_York", bookingTimeZone("America/New_York", "Asia/Shanghai"))
        assertEquals("Australia/Melbourne", bookingTimeZone(null, "Australia/Melbourne"))
        assertEquals("Asia/Shanghai", bookingTimeZone(null, "invalid"))
    }
}
