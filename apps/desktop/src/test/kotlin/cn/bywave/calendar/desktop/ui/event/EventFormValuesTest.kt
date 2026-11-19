package cn.bywave.calendar.desktop.ui.event

import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventExtraDTO
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.event.duplicateEventRange
import cn.bywave.calendar.event.eventFormDateTime
import cn.bywave.calendar.event.eventFormIso
import cn.bywave.calendar.event.eventPickerDate
import cn.bywave.calendar.event.eventPickerMillis
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.TimeZone
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EventFormValuesTest {
    private val json = Json { explicitNulls = false }
    private val calendar = CalendarMeta("cal", "Work", "#334455")
    private fun event(extra: EventExtraDTO? = null, allDay: Boolean = false) = EventDTO(
        id = "event", calendarId = calendar.id, summary = "Meeting", description = "Notes", location = "Office",
        startsAt = "2026-11-16T00:00:00Z", endsAt = "2026-11-17T23:59:59Z", allDay = allDay,
        rrule = "FREQ=WEEKLY;BYDAY=MO", extra = extra,
    )

    @Test fun `cleared editable fields are present on the wire while unmanaged metadata passes through`() {
        val src = EventExtraDTO(timezone = "America/New_York", url = "https://example.com", meetingPassword = "secret",
            attendees = listOf("a@example.com"), category = "Work", alarms = Json.parseToJsonElement("[{\"trigger\":\"-PT15M\"}]"))
        val form = initialState(EventEditMode.Edit(event(src)), listOf(calendar)).copy(
            description = "", location = "", url = "", meetingPassword = "", attendees = emptyList(),
            rrule = RruleState.fromRrule(null),
        )
        val payload = json.encodeToJsonElement(EventUpdateInput.serializer(), buildBodies(form).second!!).jsonObject
        assertEquals(JsonPrimitive(""), payload["description"])
        assertEquals(JsonPrimitive(""), payload["location"])
        assertEquals(JsonPrimitive(""), payload["rrule"])
        val extra = payload["extra"]!!.jsonObject
        assertEquals(JsonNull, extra["url"])
        assertEquals(JsonNull, extra["meetingPassword"])
        assertEquals(Json.parseToJsonElement("[]"), extra["attendees"])
        assertEquals(JsonPrimitive("America/New_York"), extra["timezone"])
        // alarms and category are form-managed now: the loaded reminder is
        // rebuilt as the editor's own DISPLAY alarm, and the (non-enum)
        // stored category rides back verbatim instead of being dropped.
        assertEquals(
            Json.parseToJsonElement("[{\"trigger\":\"-PT15M\",\"action\":\"DISPLAY\",\"description\":\"Meeting\"}]"),
            extra["alarms"],
        )
        assertEquals(JsonPrimitive("Work"), extra["category"])
    }

    @Test fun `category cleared on edit sends explicit null and picking one sends the value`() {
        val src = event(EventExtraDTO(category = "work"))
        val cleared = initialState(EventEditMode.Edit(src), listOf(calendar)).copy(category = "")
        val clearedExtra = json.encodeToJsonElement(
            EventUpdateInput.serializer(), buildBodies(cleared).second!!,
        ).jsonObject["extra"]!!.jsonObject
        assertEquals(JsonNull, clearedExtra["category"])
        val picked = initialState(EventEditMode.Edit(src), listOf(calendar)).copy(category = "travel")
        val pickedExtra = json.encodeToJsonElement(
            EventUpdateInput.serializer(), buildBodies(picked).second!!,
        ).jsonObject["extra"]!!.jsonObject
        assertEquals(JsonPrimitive("travel"), pickedExtra["category"])
    }

    @Test fun `exdates ride the patch only when the list changed`() {
        val src = event().copy(
            exdates = listOf("2026-11-23T00:00:00.000Z", "2026-11-30T00:00:00.000Z"),
        )
        val untouched = buildBodies(initialState(EventEditMode.Edit(src), listOf(calendar))).second!!
        assertNull(untouched.exdates)
        // The wire must omit the field entirely when untouched (null
        // property + explicitNulls=false), or the server would treat
        // the save as a whole-table replacement.
        val untouchedPayload = json.encodeToJsonElement(EventUpdateInput.serializer(), untouched).jsonObject
        assertFalse("exdates" in untouchedPayload)
        val oneRestored = initialState(EventEditMode.Edit(src), listOf(calendar)).copy(
            exdates = listOf("2026-11-30T00:00:00.000Z"),
        )
        assertEquals(
            listOf("2026-11-30T00:00:00.000Z"),
            buildBodies(oneRestored).second!!.exdates,
        )
        val allRestored = initialState(EventEditMode.Edit(src), listOf(calendar)).copy(exdates = emptyList())
        assertEquals(emptyList(), buildBodies(allRestored).second!!.exdates)
    }

    @Test fun `calendar fill only fills a blank selection`() {
        // The discard guard compares submit bodies against a pristine
        // snapshot that the dialog refreshes when the late calendar
        // fill lands — that only works if the fill itself never
        // overrides a selection the user already made.
        val opened = initialState(EventEditMode.Create(), emptyList())
        val filled = opened.withCalendars(listOf(calendar))
        assertEquals(calendar.id, filled.calendarId)
        val chosen = opened.copy(calendarId = "other")
        assertEquals("other", chosen.withCalendars(listOf(calendar)).calendarId)
        assertEquals("", opened.withCalendars(emptyList()).calendarId)
    }

    @Test fun `unchanged timed edits preserve instant in the second DST hour and after a device zone change`() {
        val original = TimeZone.getDefault()
        try {
            for ((openingZone, savingZone, startIso) in listOf(
                Triple("Asia/Shanghai", "Asia/Shanghai", "2026-11-16T01:00:00Z"),
                Triple("Australia/Melbourne", "Australia/Melbourne", "2026-11-16T01:00:00Z"),
                Triple("America/New_York", "America/New_York", "2026-11-01T06:30:00.123Z"),
                Triple("Asia/Shanghai", "Australia/Melbourne", "2026-11-16T01:00:00Z"),
            )) {
                val source = event(EventExtraDTO(timezone = "Australia/Melbourne")).copy(
                    startsAt = startIso,
                    endsAt = java.time.Instant.parse(startIso).plusSeconds(1800).toString(),
                    rrule = null,
                )
                TimeZone.setDefault(TimeZone.getTimeZone(openingZone))
                val form = initialState(EventEditMode.Edit(source), listOf(calendar))
                TimeZone.setDefault(TimeZone.getTimeZone(savingZone))
                val saved = buildBodies(form).second!!
                assertEquals(java.time.Instant.parse(source.startsAt), java.time.Instant.parse(saved.startsAt))
                assertEquals(java.time.Instant.parse(source.endsAt), java.time.Instant.parse(saved.endsAt))
                assertEquals("Australia/Melbourne", saved.extra?.timezone)
            }
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `partial event without extra cannot clear fields it never loaded`() {
        val form = initialState(EventEditMode.Edit(event()), listOf(calendar))
        val payload = json.encodeToJsonElement(EventUpdateInput.serializer(), buildBodies(form).second!!).jsonObject
        assertNull(payload["extra"])
    }

    @Test fun `calendar arriving after typing enables save without resetting the form`() {
        val waiting = initialState(EventEditMode.Create(), emptyList()).copy(summary = "Keep my draft", location = "Here")
        assertFalse(waiting.canSubmit)
        val ready = waiting.withCalendars(listOf(calendar))
        assertTrue(ready.canSubmit)
        assertEquals("Keep my draft", ready.summary)
        assertEquals("Here", ready.location)
        assertEquals(waiting.start, ready.start)
        assertEquals(ready, ready.withCalendars(listOf(CalendarMeta("other", "Other", "#000000"))))
    }

    @Test fun `picker dates round trip in zones on either side of UTC`() {
        val original = TimeZone.getDefault()
        try {
            for (zone in listOf("America/Los_Angeles", "Pacific/Auckland", "Asia/Shanghai")) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone))
                val day = LocalDate.of(2026, 11, 16)
                assertEquals(day, eventPickerDate(eventPickerMillis(day)))
                assertEquals(1794787200000L, eventPickerMillis(day))
            }
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `all-day editing preserves dates across zones including DST`() {
        for (zoneName in listOf("America/Los_Angeles", "Pacific/Auckland", "Australia/Melbourne")) {
            val zone = ZoneId.of(zoneName)
            for (date in listOf("2026-11-16", "2026-03-08", "2026-11-01")) {
                val start = eventFormDateTime("${date}T00:00:00Z", true, zone)!!
                val end = eventFormDateTime("${date}T23:59:59Z", true, zone)!!
                assertEquals(LocalDate.parse(date), start.toLocalDate())
                assertEquals(LocalDate.parse(date), end.toLocalDate())
                assertEquals("${date}T00:00:00Z", eventFormIso(start, true, true, zone))
                assertEquals("${date}T23:59:59Z", eventFormIso(end, true, false, zone))
            }
        }
    }

    @Test fun `timed form keeps the actual instant`() {
        val zone = ZoneId.of("America/Los_Angeles")
        val local = eventFormDateTime("2026-11-16T18:00:00Z", false, zone)!!
        assertEquals(LocalDateTime.parse("2026-11-16T10:00:00"), local)
        assertEquals("2026-11-16T10:00:00-08:00", eventFormIso(local, false, true, zone))
    }

    @Test fun `shared iso conversion keeps the original offset side inside a DST overlap`() {
        // The desktop editor's own draftInstant has always resolved an
        // edited wall time with the original event's offset as the
        // preferred one; the shared eventFormIso (the Android save path)
        // now applies the same rule, so both editors land on the same
        // instant. New York 2026-11-01: 01:00–02:00 happens first at
        // -04:00, then again at -05:00.
        val zone = ZoneId.of("America/New_York")
        val secondPass = cn.bywave.calendar.event.EventFormInstant(
            "2026-11-01T01:30:00-05:00", LocalDateTime.parse("2026-11-01T01:30:00"))
        assertEquals(
            "2026-11-01T01:15:00-05:00",
            eventFormIso(LocalDateTime.parse("2026-11-01T01:15:00"), false, true, zone, secondPass),
        )
        val firstPass = cn.bywave.calendar.event.EventFormInstant(
            "2026-11-01T01:30:00-04:00", LocalDateTime.parse("2026-11-01T01:30:00"))
        assertEquals(
            "2026-11-01T01:45:00-04:00",
            eventFormIso(LocalDateTime.parse("2026-11-01T01:45:00"), false, true, zone, firstPass),
        )
    }

    @Test fun `copying all-day events near midnight preserves the number of days`() {
        val now = LocalDateTime.parse("2026-11-16T23:30:00")
        val (start, end) = duplicateEventRange("2026-11-01T00:00:00Z", "2026-11-01T23:59:59Z", true, now)
        assertEquals(LocalDateTime.parse("2026-11-16T00:00:00"), start)
        assertEquals(LocalDateTime.parse("2026-11-16T23:59:59"), end)
        val (_, multiEnd) = duplicateEventRange("2026-11-01T00:00:00Z", "2026-11-03T23:59:59Z", true, now)
        assertEquals(LocalDateTime.parse("2026-11-18T23:59:59"), multiEnd)
    }
}
