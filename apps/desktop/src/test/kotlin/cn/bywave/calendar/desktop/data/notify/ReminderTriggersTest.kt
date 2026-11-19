package cn.bywave.calendar.desktop.data.notify

import cn.bywave.calendar.desktop.data.model.AlarmDTO
import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Pure-function coverage for the event-level reminder rules
 *  (ReminderTriggers.kt is the reference implementation the other
 *  clients copy): duration parsing, trigger parsing, timed vs
 *  all-day (wall-clock) resolution, and the event-level-over-global
 *  precedence signalled by eventTriggerInstants returning null. */
class ReminderTriggersTest {

    @Test fun `duration parsing covers the whole server enum and rejects the rest`() {
        assertEquals(0L, parseDurationMs("-PT0M"))
        assertEquals(-5 * 60_000L, parseDurationMs("-PT5M"))
        assertEquals(-15 * 60_000L, parseDurationMs("-PT15M"))
        assertEquals(-30 * 60_000L, parseDurationMs("-PT30M"))
        assertEquals(-3_600_000L, parseDurationMs("-PT1H"))
        assertEquals(-2 * 3_600_000L, parseDurationMs("-PT2H"))
        assertEquals(-86_400_000L, parseDurationMs("-P1D"))
        assertEquals(-7 * 86_400_000L, parseDurationMs("-P1W"))
        assertEquals(9 * 3_600_000L, parseDurationMs("PT9H"))
        assertEquals(-15 * 3_600_000L, parseDurationMs("-PT15H"))
        assertEquals(-(86_400_000L + 15 * 3_600_000L), parseDurationMs("-P1DT15H"))
        assertEquals(-(6 * 86_400_000L + 15 * 3_600_000L), parseDurationMs("-P6DT15H"))
        // Years / months have no fixed length — deliberately unparseable.
        assertNull(parseDurationMs("P1Y"))
        assertNull(parseDurationMs("P1M"))
        assertNull(parseDurationMs("PT"))
        assertNull(parseDurationMs("P"))
        assertNull(parseDurationMs(""))
        assertNull(parseDurationMs("tomorrow"))
    }

    @Test fun `trigger parsing handles params full lines and absolute times`() {
        assertEquals(
            ParsedTrigger.Relative(-15 * 60_000L, relatedToEnd = false),
            parseTrigger("-PT15M"),
        )
        assertEquals(
            ParsedTrigger.Relative(-30 * 60_000L, relatedToEnd = true),
            parseTrigger("RELATED=END:-PT30M"),
        )
        assertEquals(
            ParsedTrigger.Relative(-15 * 60_000L, relatedToEnd = true),
            parseTrigger("TRIGGER;RELATED=END:-PT15M"),
        )
        // An unknown RELATED value is a meaning we don't understand —
        // guessing START would fire at the wrong end of the event.
        assertNull(parseTrigger("RELATED=BOGUS:PT5M"))
        assertEquals(
            ParsedTrigger.Absolute(Instant.parse("2027-01-01T09:00:00Z")),
            parseTrigger("VALUE=DATE-TIME:20270101T090000Z"),
        )
        assertNull(parseTrigger(""))
        assertNull(parseTrigger("P1M"))
    }

    @Test fun `timed triggers are absolute durations from the right end`() {
        val start = Instant.parse("2026-11-16T10:00:00Z")
        val end = Instant.parse("2026-11-16T11:00:00Z")
        assertEquals(
            Instant.parse("2026-11-16T09:45:00Z"),
            resolveTriggerAt(start, end, allDay = false, timezone = null, parseTrigger("-PT15M")!!),
        )
        assertEquals(
            Instant.parse("2026-11-16T10:30:00Z"),
            resolveTriggerAt(start, end, allDay = false, timezone = null, parseTrigger("RELATED=END:-PT30M")!!),
        )
        // RELATED=END without an end: no honest answer, don't guess.
        assertNull(
            resolveTriggerAt(start, null, allDay = false, timezone = null, parseTrigger("RELATED=END:-PT30M")!!),
        )
    }

    @Test fun `all-day triggers follow wall clock across the DST jump`() {
        // 2026-03-08 is the US spring-forward day. The all-day event's
        // startsAt is that date at UTC midnight; "PT9H" must land at
        // 09:00 local (EDT, UTC-4 → 13:00Z), not 09:00Z.
        val start = Instant.parse("2026-03-08T00:00:00Z")
        val zone = "America/New_York"
        val sameDay = resolveTriggerAt(start, null, allDay = true, timezone = zone, parseTrigger("PT9H")!!)
        assertEquals(Instant.parse("2026-03-08T13:00:00Z"), sameDay)
        assertEquals(
            9,
            sameDay!!.atZone(ZoneId.of(zone)).hour,
        )
        // "-PT15H" = the day before at 09:00 local; Mar 7 is still EST
        // (UTC-5 → 14:00Z). Absolute-duration math off UTC midnight
        // would give 09:00Z here too — the wall-clock answer differs.
        val dayBefore = resolveTriggerAt(start, null, allDay = true, timezone = zone, parseTrigger("-PT15H")!!)
        assertEquals(Instant.parse("2026-03-07T14:00:00Z"), dayBefore)
        // No timezone anywhere → unresolvable rather than silently
        // falling back to the device zone.
        assertNull(resolveTriggerAt(start, null, allDay = true, timezone = null, parseTrigger("PT9H")!!))
        assertNull(resolveTriggerAt(start, null, allDay = true, timezone = "Not/AZone", parseTrigger("PT9H")!!))
    }

    @Test fun `event-level precedence is signalled by null versus list`() {
        val start = Instant.parse("2026-11-16T10:00:00Z")
        // No alarms → null: the scheduler falls back to the global lead.
        assertNull(eventTriggerInstants(start, null, allDay = false, timezone = null, alarms = emptyList()))
        // Alarms present → the event's own triggers, global lead ignored.
        assertEquals(
            listOf(Instant.parse("2026-11-16T09:45:00Z")),
            eventTriggerInstants(
                start, null, allDay = false, timezone = null,
                alarms = listOf(AlarmDTO("-PT15M", action = "DISPLAY", description = "Meeting")),
            ),
        )
        // Alarms present but unparseable → empty list, NOT null: the
        // event opted into event-level reminders, so a bad trigger
        // must not resurrect the global one.
        val garbage = eventTriggerInstants(
            start, null, allDay = false, timezone = null,
            alarms = listOf(AlarmDTO("P1M")),
        )
        assertTrue(garbage != null && garbage.isEmpty())
    }

    @Test fun `editor side keeps custom alarms and rebuilds the main one`() {
        val existing = listOf(
            AlarmDTO("-PT30M"),
            AlarmDTO("-P2D", action = "DISPLAY", description = "imported"),
        )
        assertEquals("-PT30M", mainReminder(existing, allDay = false))
        assertEquals(listOf("-P2D"), keptAlarms(existing, allDay = false).map { it.trigger })
        // Picking "none" keeps only the custom alarm.
        assertEquals(
            listOf("-P2D"),
            buildAlarms("", "Standup", existing, allDay = false).map { it.trigger },
        )
        // Picking a value puts the rebuilt DISPLAY alarm first.
        val built = buildAlarms("-PT5M", "Standup", existing, allDay = false)
        assertEquals(
            listOf(
                AlarmDTO("-PT5M", action = "DISPLAY", description = "Standup"),
                AlarmDTO("-P2D", action = "DISPLAY", description = "imported"),
            ),
            built,
        )
        // Group switch keeps values that exist in both groups (""),
        // otherwise falls back to the group's default (web parity).
        assertEquals("", nextReminderValue("", allDay = true))
        assertEquals("PT9H", nextReminderValue("-PT15M", allDay = true))
        assertEquals("-PT15M", nextReminderValue("PT9H", allDay = false))
        assertEquals("PT9H", nextReminderValue("PT9H", allDay = true))
    }
}
