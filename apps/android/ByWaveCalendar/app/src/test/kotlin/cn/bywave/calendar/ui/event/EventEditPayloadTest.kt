package cn.bywave.calendar.ui.event

import cn.bywave.calendar.data.model.EventExtraDTO
import cn.bywave.calendar.data.model.EventUpdateInput
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class EventEditPayloadTest {
    private val json = Json { explicitNulls = false }
    private val base = EventEditUiState(isEdit = true, calendarId = "cal", summary = "Meeting",
        start = LocalDateTime.parse("2026-11-16T00:00:00"), end = LocalDateTime.parse("2026-11-16T23:59:59"))

    @Test fun `unchanged timed payload retains original instant across a DST fold and device zone change`() {
        for ((openingZone, savingZone, startIso) in listOf(
            Triple("Asia/Shanghai", "Asia/Shanghai", "2026-11-16T01:00:00Z"),
            Triple("Australia/Melbourne", "Australia/Melbourne", "2026-11-16T01:00:00Z"),
            Triple("America/New_York", "America/New_York", "2026-11-01T06:30:00.123Z"),
            Triple("Asia/Shanghai", "Australia/Melbourne", "2026-11-16T01:00:00Z"),
        )) {
            val start = java.time.Instant.parse(startIso)
            val end = start.plusSeconds(1800)
            val localStart = start.atZone(ZoneId.of(openingZone)).toLocalDateTime()
            val localEnd = end.atZone(ZoneId.of(openingZone)).toLocalDateTime()
            val state = base.copy(start = localStart, end = localEnd,
                sourceExtra = EventExtraDTO(timezone = "Australia/Melbourne"),
                originalStart = cn.bywave.calendar.event.EventFormInstant(startIso, localStart),
                originalEnd = cn.bywave.calendar.event.EventFormInstant(end.toString(), localEnd))
            val saved = state.buildUpdateInput(zone = ZoneId.of(savingZone))
            assertEquals(start, java.time.Instant.parse(saved.startsAt))
            assertEquals(end, java.time.Instant.parse(saved.endsAt))
            assertEquals("Australia/Melbourne", saved.extra?.timezone)
        }
    }

    @Test fun `an actual time edit uses the selected device clock instead of freezing the old instant`() {
        val start = LocalDateTime.parse("2026-11-16T09:00:00")
        val state = base.copy(start = start.plusMinutes(15), end = start.plusMinutes(45),
            sourceExtra = EventExtraDTO(timezone = "Australia/Melbourne"),
            originalStart = cn.bywave.calendar.event.EventFormInstant("2026-11-16T01:00:00Z", start))
        val saved = state.buildUpdateInput(zone = ZoneId.of("Asia/Shanghai"))
        assertEquals(java.time.Instant.parse("2026-11-16T01:15:00Z"), java.time.Instant.parse(saved.startsAt))
        assertEquals("Australia/Melbourne", saved.extra?.timezone)
    }

    @Test fun `clearing fields sends deletions without dropping other event metadata`() {
        val state = base.copy(sourceExtra = EventExtraDTO(timezone = "America/New_York", url = "https://example.com",
            meetingPassword = "123", attendees = listOf("a@example.com"), category = "Work"))
        val payload = json.encodeToJsonElement(EventUpdateInput.serializer(), state.buildUpdateInput()).jsonObject
        assertEquals(JsonPrimitive(""), payload["description"])
        assertEquals(JsonPrimitive(""), payload["location"])
        val extra = payload["extra"]!!.jsonObject
        assertEquals(JsonNull, extra["url"])
        assertEquals(JsonNull, extra["meetingPassword"])
        assertEquals(JsonPrimitive("America/New_York"), extra["timezone"])
        assertFalse("attendees" in extra)
        assertFalse("category" in extra)
        assertFalse("rrule" in payload)
    }

    @Test fun `unloaded extra fields are not interpreted as user clearing them`() {
        val payload = json.encodeToJsonElement(EventUpdateInput.serializer(), base.buildUpdateInput()).jsonObject
        assertEquals(emptySet<String>(), payload["extra"]!!.jsonObject.keys)
    }

    @Test fun `all-day edit sends the selected date instead of local timezone offset`() {
        val payload = base.copy(allDay = true).buildUpdateInput(zone = ZoneId.of("Australia/Melbourne"))
        assertEquals("2026-11-16T00:00:00Z", payload.startsAt)
        assertEquals("2026-11-16T23:59:59Z", payload.endsAt)
    }

    @Test fun `save cannot overlap deletion parsing or a finished operation`() {
        assertTrue(base.canSubmit)
        assertFalse(base.copy(deleting = true).canSubmit)
        assertFalse(base.copy(parsing = true).canSubmit)
        assertFalse(base.copy(finished = true).canSubmit)
        assertFalse(base.copy(saving = true).canSubmit)
    }
}
