package cn.bywave.calendar.desktop.ui.calendar

import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.ui.event.formatTimeBlock
import cn.bywave.calendar.event.bookingTimeZone
import cn.bywave.calendar.event.eventSourceTimes
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

    @Test fun `details retain original dates for a Melbourne meeting and a two-city trip`() {
        val shanghai = ZoneId.of("Asia/Shanghai")
        val melbourne = "Australia/Melbourne"
        val start = "2026-11-28T13:30:00Z"
        val end = "2026-11-28T14:30:00Z"
        val locale = java.util.Locale.UK
        val source = assertNotNull(eventSourceTimes(start, end, "Bad/Zone", null, melbourne, shanghai, locale))
        assertContains(source, "29 Nov 2026")
        assertContains(source, "00:30")
        assertContains(source, "01:30")
        assertNull(eventSourceTimes(start, end, melbourne, null, null, ZoneId.of(melbourne), locale))
        assertNull(eventSourceTimes(start, end, null, null, null, shanghai, locale))
        val trip = assertNotNull(eventSourceTimes("2026-11-28T12:00:00Z", "2026-11-28T21:00:00Z",
            melbourne, shanghai.id, null, shanghai, locale))
        assertContains(trip, "28 Nov 2026")
        assertContains(trip, "23:00")
        assertContains(trip, "29 Nov 2026")
        assertContains(trip, "05:00")
    }

    @Test fun `availability zone comes from owner metadata and never viewer device`() {
        assertEquals("America/New_York", bookingTimeZone("America/New_York", "Asia/Shanghai"))
        assertEquals("Australia/Melbourne", bookingTimeZone(null, "Australia/Melbourne"))
        assertEquals("Australia/Melbourne", bookingTimeZone("invalid", "Australia/Melbourne"))
        assertEquals("Asia/Shanghai", bookingTimeZone(null, "invalid"))
    }
}
