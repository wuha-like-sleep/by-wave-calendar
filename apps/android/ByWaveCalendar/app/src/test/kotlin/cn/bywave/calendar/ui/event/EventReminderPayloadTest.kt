package cn.bywave.calendar.ui.event

import cn.bywave.calendar.data.model.EventAlarm
import cn.bywave.calendar.data.model.EventExtraDTO
import cn.bywave.calendar.data.model.EventUpdateInput
import java.time.LocalDateTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/** Pins the extra.alarms save semantics (server shallow merge:
 *  omitted = keep, null = delete the key) and the rrule/exdates
 *  "only send when changed" discipline. */
class EventReminderPayloadTest {
    private val json = Json { explicitNulls = false }
    private val base = EventEditUiState(
        isEdit = true, calendarId = "cal", summary = "Meeting",
        start = LocalDateTime.parse("2026-11-16T09:00:00"),
        end = LocalDateTime.parse("2026-11-16T10:00:00"),
    )

    private fun extraOf(state: EventEditUiState) =
        json.encodeToJsonElement(EventUpdateInput.serializer(), state.buildUpdateInput())
            .jsonObject["extra"]!!.jsonObject

    @Test fun `selected timed reminder becomes the primary alarm with the title as description`() {
        val extra = extraOf(base.copy(reminder = "-PT15M"))
        val alarms = extra["alarms"]!!.jsonArray
        assertEquals(1, alarms.size)
        val first = alarms[0].jsonObject
        assertEquals("-PT15M", first["trigger"]!!.jsonPrimitive.content)
        assertEquals("DISPLAY", first["action"]!!.jsonPrimitive.content)
        assertEquals("Meeting", first["description"]!!.jsonPrimitive.content)
    }

    @Test fun `alarms outside the current enum survive a save verbatim`() {
        val exotic = EventAlarm(trigger = "RELATED=END:-PT10M", action = "DISPLAY", description = "imported")
        val state = base.copy(
            reminder = "-PT5M",
            sourceExtra = EventExtraDTO(
                alarms = listOf(EventAlarm(trigger = "-PT30M"), exotic),
            ),
        )
        val alarms = extraOf(state)["alarms"]!!.jsonArray
        // Selected one first, then the non-enum survivor; the old enum
        // alarm (-PT30M) is replaced by the new selection.
        assertEquals(2, alarms.size)
        assertEquals("-PT5M", alarms[0].jsonObject["trigger"]!!.jsonPrimitive.content)
        assertEquals("RELATED=END:-PT10M", alarms[1].jsonObject["trigger"]!!.jsonPrimitive.content)
    }

    @Test fun `clearing the only alarm sends an explicit null so the server deletes the key`() {
        val state = base.copy(
            reminder = "",
            sourceExtra = EventExtraDTO(alarms = listOf(EventAlarm(trigger = "-PT15M"))),
        )
        assertEquals(JsonNull, extraOf(state)["alarms"])
    }

    @Test fun `no alarms before and none picked omits the field`() {
        assertFalse("alarms" in extraOf(base.copy(reminder = "")))
        assertFalse("alarms" in extraOf(base.copy(sourceExtra = EventExtraDTO(timezone = "UTC"))))
    }

    @Test fun `primary reminder is the first existing alarm inside the current group`() {
        val alarms = listOf(
            EventAlarm(trigger = "PT9H"),       // all-day value, not in the timed group
            EventAlarm(trigger = "-PT30M"),
        )
        assertEquals("-PT30M", primaryReminderTrigger(alarms, allDay = false))
        assertEquals("PT9H", primaryReminderTrigger(alarms, allDay = true))
        assertEquals("", primaryReminderTrigger(null, allDay = false))
        assertEquals("", primaryReminderTrigger(emptyList(), allDay = true))
    }

    @Test fun `all-day group uses its own value set`() {
        val state = base.copy(
            allDay = true, reminder = "-PT15H",
            sourceExtra = EventExtraDTO(alarms = listOf(EventAlarm(trigger = "PT9H"))),
        )
        val alarms = extraOf(state)["alarms"]!!.jsonArray
        assertEquals(1, alarms.size)
        assertEquals("-PT15H", alarms[0].jsonObject["trigger"]!!.jsonPrimitive.content)
    }

    @Test fun `rrule is only sent when the user changed it`() {
        val unchanged = base.copy(
            sourceRrule = "FREQ=WEEKLY;BYDAY=MO",
            rruleState = RruleFormState.parse("FREQ=WEEKLY;BYDAY=MO"),
        )
        val payload = json.encodeToJsonElement(
            EventUpdateInput.serializer(), unchanged.buildUpdateInput(),
        ).jsonObject
        assertFalse("rrule" in payload)

        val changed = unchanged.copy(
            rruleState = RruleFormState.parse("FREQ=DAILY;COUNT=5"),
        )
        val changedPayload = json.encodeToJsonElement(
            EventUpdateInput.serializer(), changed.buildUpdateInput(),
        ).jsonObject
        assertEquals("FREQ=DAILY;COUNT=5", changedPayload["rrule"]!!.jsonPrimitive.content)
    }

    @Test fun `exdates are only sent when a restore changed the list`() {
        val state = base.copy(
            sourceExdates = listOf("2026-11-23T09:00:00Z", "2026-11-30T09:00:00Z"),
            exdates = listOf("2026-11-23T09:00:00Z", "2026-11-30T09:00:00Z"),
        )
        val same = json.encodeToJsonElement(
            EventUpdateInput.serializer(), state.buildUpdateInput(),
        ).jsonObject
        assertFalse("exdates" in same)

        val restored = json.encodeToJsonElement(
            EventUpdateInput.serializer(),
            state.copy(exdates = listOf("2026-11-30T09:00:00Z")).buildUpdateInput(),
        ).jsonObject
        assertEquals(1, restored["exdates"]!!.jsonArray.size)
        assertEquals(
            "2026-11-30T09:00:00Z",
            restored["exdates"]!!.jsonArray[0].jsonPrimitive.content,
        )
    }

    @Test fun `create body carries the recurrence rule so duplicates keep repeating`() {
        val state = EventEditUiState(
            isEdit = false, calendarId = "cal", summary = "Standup",
            start = LocalDateTime.parse("2026-11-17T09:30:00"),
            end = LocalDateTime.parse("2026-11-17T09:45:00"),
            rruleState = RruleFormState.parse("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
        )
        assertEquals(
            "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
            state.buildCreateInput().rrule,
        )
        assertNull(EventEditUiState(calendarId = "cal", summary = "Once").buildCreateInput().rrule)
    }
}
