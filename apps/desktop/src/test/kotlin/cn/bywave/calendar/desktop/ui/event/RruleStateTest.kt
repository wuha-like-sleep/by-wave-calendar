package cn.bywave.calendar.desktop.ui.event

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** BYDAY round-trips through RruleState: the two modeled shapes
 *  (WEEKLY weekday sets, MONTHLY single ordinal weekday) parse and
 *  serialize losslessly; every other BYDAY shape keeps the whole rule
 *  on the verbatim passthrough path so nothing is silently dropped. */
class RruleStateTest {

    @Test fun `weekly byday round trips and canonicalizes order`() {
        val state = RruleState.fromRrule("FREQ=WEEKLY;BYDAY=WE,MO")
        assertNull(state.passthrough)
        assertEquals(listOf("MO", "WE"), state.byday)
        assertEquals("FREQ=WEEKLY;BYDAY=MO,WE", state.toRrule())
    }

    @Test fun `weekly byday survives alongside interval and count`() {
        val state = RruleState.fromRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;COUNT=5")
        assertNull(state.passthrough)
        assertEquals("FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;COUNT=5", state.toRrule())
    }

    @Test fun `monthly ordinal byday round trips`() {
        for (rule in listOf("FREQ=MONTHLY;BYDAY=2TU", "FREQ=MONTHLY;BYDAY=-1FR", "FREQ=MONTHLY;BYDAY=1MO")) {
            val state = RruleState.fromRrule(rule)
            assertNull(state.passthrough, rule)
            assertEquals(rule, state.toRrule(), rule)
        }
    }

    @Test fun `unmodeled byday shapes stay on passthrough`() {
        for (rule in listOf(
            "FREQ=MONTHLY;BYDAY=MO",        // monthly needs an ordinal
            "FREQ=MONTHLY;BYDAY=1MO,2TU",  // only a single ordinal is modeled
            "FREQ=MONTHLY;BYDAY=5TU",       // ordinal outside the offered set
            "FREQ=WEEKLY;BYDAY=2TU",        // weekly takes plain weekdays only
            "FREQ=DAILY;BYDAY=MO",          // BYDAY is not modeled for daily
            "FREQ=YEARLY;BYDAY=20MO",       // nor for yearly
        )) {
            val state = RruleState.fromRrule(rule)
            assertEquals(rule, state.passthrough, rule)
            assertEquals(rule, state.toRrule(), rule)
        }
    }

    @Test fun `other exotic parts still pass through`() {
        val state = RruleState.fromRrule("FREQ=MONTHLY;BYMONTHDAY=15")
        assertEquals("FREQ=MONTHLY;BYMONTHDAY=15", state.passthrough)
        assertEquals("FREQ=MONTHLY;BYMONTHDAY=15", state.toRrule())
    }

    @Test fun `rules without byday are unchanged`() {
        val state = RruleState.fromRrule("FREQ=WEEKLY")
        assertNull(state.passthrough)
        assertEquals(emptyList(), state.byday)
        assertEquals("FREQ=WEEKLY", state.toRrule())
    }
}
