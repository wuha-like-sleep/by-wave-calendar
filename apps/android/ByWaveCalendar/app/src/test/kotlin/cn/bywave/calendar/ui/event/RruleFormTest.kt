package cn.bywave.calendar.ui.event

import java.time.DayOfWeek
import java.time.LocalDate
import org.junit.Assert.*
import org.junit.Test

/** RRULE parse/build round-trips. The invariant that matters most:
 *  a rule the form cannot model comes back byte-for-byte (passthrough),
 *  never dropped and never half-rewritten. */
class RruleFormTest {

    @Test fun `no rule parses to none and builds to null`() {
        assertEquals(RruleFreq.None, RruleFormState.parse(null).freq)
        assertEquals(RruleFreq.None, RruleFormState.parse("").freq)
        assertNull(RruleFormState().effectiveRrule())
    }

    @Test fun `simple frequencies round trip`() {
        assertEquals("FREQ=DAILY", RruleFormState.parse("FREQ=DAILY").effectiveRrule())
        assertEquals(
            "FREQ=DAILY;INTERVAL=3",
            RruleFormState.parse("FREQ=DAILY;INTERVAL=3").effectiveRrule(),
        )
        assertEquals(
            "FREQ=YEARLY;COUNT=5",
            RruleFormState.parse("FREQ=YEARLY;COUNT=5").effectiveRrule(),
        )
    }

    @Test fun `weekly byday parses and rebuilds in weekday order`() {
        val state = RruleFormState.parse("FREQ=WEEKLY;BYDAY=FR,MO")
        assertEquals(RruleFreq.Weekly, state.freq)
        assertEquals(setOf(DayOfWeek.MONDAY, DayOfWeek.FRIDAY), state.byDay)
        assertEquals("FREQ=WEEKLY;BYDAY=MO,FR", state.effectiveRrule())
    }

    @Test fun `monthly ordinal weekday round trips`() {
        val second = RruleFormState.parse("FREQ=MONTHLY;BYDAY=2MO")
        assertEquals(2, second.monthlyOrdinal)
        assertEquals(DayOfWeek.MONDAY, second.monthlyWeekday)
        assertEquals("FREQ=MONTHLY;BYDAY=2MO", second.effectiveRrule())

        val last = RruleFormState.parse("FREQ=MONTHLY;BYDAY=-1FR")
        assertEquals(-1, last.monthlyOrdinal)
        assertEquals(DayOfWeek.FRIDAY, last.monthlyWeekday)
        assertEquals("FREQ=MONTHLY;BYDAY=-1FR", last.effectiveRrule())
    }

    @Test fun `until parses to a date and rebuilds as end of day utc`() {
        val state = RruleFormState.parse("FREQ=WEEKLY;UNTIL=20261231T235959Z")
        assertEquals(RruleEnd.Until, state.end)
        assertEquals(LocalDate.of(2026, 12, 31), state.until)
        assertEquals("FREQ=WEEKLY;UNTIL=20261231T235959Z", state.effectiveRrule())
        // Date-only UNTIL is accepted too.
        assertEquals(
            LocalDate.of(2027, 1, 15),
            RruleFormState.parse("FREQ=DAILY;UNTIL=20270115").until,
        )
    }

    @Test fun `unmodelable rules pass through byte for byte`() {
        for (rule in listOf(
            "FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO,TU,WE,TH,FR",
            "FREQ=MONTHLY;BYMONTHDAY=15",
            "FREQ=HOURLY;INTERVAL=6",
            "FREQ=WEEKLY;BYDAY=1MO",          // ordinal BYDAY is not a weekly form we model
            "FREQ=MONTHLY;BYDAY=MO,TU",       // several monthly BYDAY entries
            "FREQ=DAILY;UNTIL=20270101T000000Z;COUNT=5", // UNTIL+COUNT together
            "FREQ=DAILY;BYHOUR=9",
            "garbage",
        )) {
            val state = RruleFormState.parse(rule)
            assertEquals("expected passthrough for $rule", rule, state.passthrough)
            assertEquals(rule, state.effectiveRrule())
        }
    }

    @Test fun `picking a new frequency drops the passthrough and rebuilds`() {
        val state = RruleFormState.parse("FREQ=MONTHLY;BYMONTHDAY=15")
        val edited = state.copy(freq = RruleFreq.Weekly, passthrough = null)
        assertEquals("FREQ=WEEKLY", edited.effectiveRrule())
    }
}
