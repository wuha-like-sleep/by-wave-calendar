package cn.bywave.calendar.desktop.ui.calendar

import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.ui.event.formatTimeBlock
import cn.bywave.calendar.event.bookingTimeZone
import java.time.LocalDate
import java.time.ZoneId
import java.util.TimeZone
import kotlin.test.*

class BookingTimeZoneTest {
    private val booking = EventDTO(id = "b", calendarId = "c", summary = "Booking", startsAt = "2026-11-16T00:30:00Z", endsAt = "2026-11-16T01:00:00Z", allDay = false)

    @Test fun `Melbourne noon and Shanghai nine are the same booked instant regardless of source zone`() {
        val original = TimeZone.getDefault()
        try {
            val event = booking.copy(startsAt = "2026-11-16T01:00:00Z", endsAt = "2026-11-16T01:30:00Z",
                extra = cn.bywave.calendar.desktop.data.model.EventExtraDTO(timezone = "Australia/Melbourne"))
            TimeZone.setDefault(TimeZone.getTimeZone("Australia/Melbourne"))
            assertEquals("12:00 – 12:30", formatTimeRange(event))
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"))
            assertEquals("09:00 – 09:30", formatTimeRange(event))
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `booked instant follows a changed device zone without restarting formatters`() {
        val original = TimeZone.getDefault()
        try {
            for ((zone, expected, day) in listOf(
                Triple("Asia/Shanghai", "08:30 – 09:00", "2026-11-16"),
                Triple("America/New_York", "19:30 – 20:00", "2026-11-15"),
                Triple("Australia/Melbourne", "11:30 – 12:00", "2026-11-16"),
            )) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone))
                assertEquals(expected, formatTimeRange(booking))
                assertTrue(eventOnDay(booking, LocalDate.parse(day)))
                assertFalse(eventOnDay(booking, LocalDate.parse(day).plusDays(1)))
            }
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `detail reflects date rollover and DST using the display zone`() {
        assertEquals("2026-11-15 19:30 – 20:00", formatTimeBlock(booking, ZoneId.of("America/New_York")))
        val dst = booking.copy(startsAt = "2026-03-08T06:30:00Z", endsAt = "2026-03-08T07:30:00Z")
        assertEquals("2026-03-08 01:30 – 03:30", formatTimeBlock(dst, ZoneId.of("America/New_York")))
        assertEquals("2026-03-08 14:30 – 15:30", formatTimeBlock(dst, ZoneId.of("Asia/Shanghai")))
    }

    @Test fun `availability zone comes from owner metadata and never viewer device`() {
        assertEquals("America/New_York", bookingTimeZone("America/New_York", "Asia/Shanghai"))
        assertEquals("Australia/Melbourne", bookingTimeZone(null, "Australia/Melbourne"))
        assertEquals("Australia/Melbourne", bookingTimeZone("invalid", "Australia/Melbourne"))
        assertEquals("Asia/Shanghai", bookingTimeZone(null, "invalid"))
    }
}
