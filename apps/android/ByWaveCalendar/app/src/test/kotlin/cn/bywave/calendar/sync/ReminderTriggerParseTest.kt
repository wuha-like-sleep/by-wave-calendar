package cn.bywave.calendar.sync

import java.time.Duration
import org.junit.Assert.*
import org.junit.Test

/** The signed-duration parser behind event-level reminder scheduling.
 *  Sign and zero are the two cases that silently broke reminders
 *  before (on the server side): -PT0M is a real reminder at the
 *  anchor, not a parse failure, and a positive all-day trigger must
 *  not be flipped into "before". */
class ReminderTriggerParseTest {

    @Test fun `timed enum values parse with their signs`() {
        assertEquals(Duration.ofMinutes(-15), parseReminderTriggerDuration("-PT15M"))
        assertEquals(Duration.ofMinutes(-5), parseReminderTriggerDuration("-PT5M"))
        assertEquals(Duration.ofHours(-1), parseReminderTriggerDuration("-PT1H"))
        assertEquals(Duration.ofDays(-1), parseReminderTriggerDuration("-P1D"))
        assertEquals(Duration.ofDays(-7), parseReminderTriggerDuration("-P1W"))
    }

    @Test fun `zero is a valid duration, not a failure`() {
        assertEquals(Duration.ZERO, parseReminderTriggerDuration("-PT0M"))
        assertEquals(Duration.ZERO, parseReminderTriggerDuration("PT0S"))
    }

    @Test fun `all-day enum values parse as wall-clock offsets`() {
        assertEquals(Duration.ofHours(9), parseReminderTriggerDuration("PT9H"))
        assertEquals(Duration.ofHours(-15), parseReminderTriggerDuration("-PT15H"))
        assertEquals(
            Duration.ofDays(-1).minusHours(15),
            parseReminderTriggerDuration("-P1DT15H"),
        )
        assertEquals(
            Duration.ofDays(-6).minusHours(15),
            parseReminderTriggerDuration("-P6DT15H"),
        )
    }

    @Test fun `positive and plus-signed durations stay positive`() {
        assertEquals(Duration.ofMinutes(5), parseReminderTriggerDuration("+PT5M"))
        assertEquals(Duration.ofMinutes(5), parseReminderTriggerDuration("PT5M"))
    }

    @Test fun `weeks and days can combine`() {
        assertEquals(Duration.ofDays(9), parseReminderTriggerDuration("P1W2D"))
    }

    @Test fun `unparseable triggers return null`() {
        for (bad in listOf(
            "", "P", "PT", "banana", "-PT15X", "15M",
            "RELATED=END:-PT15M",       // parameter form is out of scope by design
            "P1Y", "P1M",               // year/month intentionally not recognised
            "P99999999999999999999D",   // absurd component must fail alone
        )) {
            assertNull("expected null for '$bad'", parseReminderTriggerDuration(bad))
        }
    }

    @Test fun `case and surrounding spaces are tolerated`() {
        assertEquals(Duration.ofMinutes(-15), parseReminderTriggerDuration(" -pt15m "))
    }
}
