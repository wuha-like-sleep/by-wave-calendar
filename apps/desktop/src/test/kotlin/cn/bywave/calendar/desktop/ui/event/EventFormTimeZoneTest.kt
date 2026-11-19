package cn.bywave.calendar.desktop.ui.event

import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventExtraDTO
import cn.bywave.calendar.event.EventFormInstant
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.TimeZone
import kotlin.test.*

class EventFormTimeZoneTest {
    private val shanghai = ZoneId.of("Asia/Shanghai")
    private val melbourne = ZoneId.of("Australia/Melbourne")
    private val newYork = ZoneId.of("America/New_York")
    private val calendar = CalendarMeta("cal", "Work", "#334455")
    private val now = Instant.parse("2026-11-16T00:40:00Z")
    private val source = EventDTO(id = "event", calendarId = "cal", summary = "Meeting",
        startsAt = "2026-11-16T01:00:00Z", endsAt = "2026-11-16T01:45:00Z",
        rrule = "FREQ=WEEKLY;BYDAY=MO", extra = EventExtraDTO(timezone = "Australia/Melbourne"))

    private fun range(form: FormState): Pair<Instant, Instant> {
        val (create, update) = buildBodies(form)
        return Instant.parse(create?.startsAt ?: update!!.startsAt) to Instant.parse(create?.endsAt ?: update!!.endsAt)
    }

    @Test fun `zone changes re-render existing edits while retaining their instant and every other draft field`() {
        val before = initialState(EventEditMode.Edit(source), listOf(calendar), shanghai, now).copy(
            summary = "Edited title", description = "Draft notes", location = "New room", url = "https://example.com",
            meetingPassword = "1234", attendees = listOf("a@example.com"), calendarId = "another-calendar")
        val expected = range(before)
        val changed = before.withDisplayZone(melbourne)
        assertEquals(LocalDateTime.parse("2026-11-16T12:00:00"), changed.start)
        assertEquals(expected, range(changed))
        val returned = changed.withDisplayZone(newYork).withDisplayZone(shanghai)
        assertEquals(before.start, returned.start)
        assertEquals(before.end, returned.end)
        assertEquals(before.summary, returned.summary)
        assertEquals(before.description, returned.description)
        assertEquals(before.location, returned.location)
        assertEquals(before.url, returned.url)
        assertEquals(before.meetingPassword, returned.meetingPassword)
        assertEquals(before.attendees, returned.attendees)
        assertEquals(before.calendarId, returned.calendarId)
        assertEquals(before.rrule, returned.rrule)
        assertEquals(before.sourceStartsAt, returned.sourceStartsAt)
        assertEquals(before.sourceExtra, returned.sourceExtra)
        assertEquals(expected, range(returned))
    }

    @Test fun `saving a new draft never interprets its old clock with the new process zone`() {
        val original = TimeZone.getDefault()
        try {
            val draft = initialState(EventEditMode.Create(LocalDateTime.parse("2026-11-16T09:00:00")), listOf(calendar), shanghai, now)
                .copy(summary = "My new draft", rrule = RruleState.fromRrule("FREQ=WEEKLY;BYDAY=MO"))
            val expected = range(draft)
            TimeZone.setDefault(TimeZone.getTimeZone(melbourne))
            // Save can race the UI effect that receives the new zone.
            assertEquals(Instant.parse("2026-11-16T01:00:00Z"), range(draft).first)
            val changed = draft.withDisplayZone(melbourne)
            assertEquals(LocalDateTime.parse("2026-11-16T12:00:00"), changed.start)
            assertEquals(expected, range(changed))
            val body = buildBodies(changed).first!!
            assertEquals("Asia/Shanghai", body.extra?.timezone)
            assertEquals(draft.rrule.toRrule(), body.rrule)
            assertEquals("My new draft", body.summary)
        } finally { TimeZone.setDefault(original) }
    }

    @Test fun `duplicate drafts keep their new scheduled instant duration and copied fields`() {
        val draft = initialState(EventEditMode.Duplicate(source), listOf(calendar), shanghai, now)
            .copy(summary = "Follow-up", description = "Copied draft")
        val expected = range(draft)
        val changed = draft.withDisplayZone(melbourne).withDisplayZone(newYork)
        assertEquals(Instant.parse("2026-11-16T01:00:00Z"), expected.first)
        assertEquals(Duration.ofMinutes(45), Duration.between(expected.first, expected.second))
        assertEquals(expected, range(changed))
        assertEquals("Follow-up", changed.summary)
        assertEquals("Copied draft", changed.description)
        assertFalse(changed.isEdit)
        assertEquals("Australia/Melbourne", buildBodies(changed).first!!.extra?.timezone)
    }

    @Test fun `all-day existing new and duplicate drafts keep their civil dates across zones`() {
        val allDay = source.copy(startsAt = "2026-03-08T00:00:00Z", endsAt = "2026-03-10T23:59:59Z", allDay = true)
        val drafts = listOf(
            initialState(EventEditMode.Edit(allDay), listOf(calendar), shanghai, now),
            initialState(EventEditMode.Duplicate(allDay), listOf(calendar), shanghai, now),
            initialState(EventEditMode.Create(), listOf(calendar), shanghai, now).copy(allDay = true,
                start = LocalDateTime.parse("2026-03-08T00:00:00"), end = LocalDateTime.parse("2026-03-10T23:59:00"),
                originalStart = null, originalEnd = null),
        )
        for (draft in drafts) {
            val changed = draft.withDisplayZone(newYork).withDisplayZone(melbourne)
            assertEquals(draft.start, changed.start)
            assertEquals(draft.end, changed.end)
            assertEquals(range(draft), range(changed))
        }
    }

    @Test fun `the second DST hour and nearby edits keep their selected offset after repeated zone changes`() {
        val event = source.copy(startsAt = "2026-11-01T06:30:00.123Z", endsAt = "2026-11-01T07:00:00.123Z")
        var draft = initialState(EventEditMode.Edit(event), listOf(calendar), newYork, now)
        repeat(3) { draft = draft.withDisplayZone(shanghai).withDisplayZone(melbourne).withDisplayZone(newYork) }
        assertEquals(Instant.parse(event.startsAt), range(draft).first)
        val edited = draft.withStart(draft.start.plusMinutes(15)).withDisplayZone(shanghai)
        assertEquals(Instant.parse("2026-11-01T06:45:00.123Z"), range(edited).first)
        assertEquals(Instant.parse("2026-11-01T07:15:00.123Z"), range(edited).second)
    }

    @Test fun `DST overlap end times can precede start on the clock without shortening the event`() {
        val event = source.copy(startsAt = "2026-11-01T05:45:00Z", endsAt = "2026-11-01T06:15:00Z")
        val draft = initialState(EventEditMode.Edit(event), listOf(calendar), newYork, now)
        assertTrue(draft.end.isBefore(draft.start))
        assertEquals(range(draft), range(draft.withEnd(draft.end)))
        val shifted = draft.withStart(draft.start.plusMinutes(5)).withDisplayZone(melbourne)
        assertEquals(Instant.parse("2026-11-01T05:50:00Z"), range(shifted).first)
        assertEquals(Instant.parse("2026-11-01T06:20:00Z"), range(shifted).second)
    }

    @Test fun `a default draft opened in the second DST hour is scheduled in that hour`() {
        val draft = initialState(EventEditMode.Create(), listOf(calendar), newYork, Instant.parse("2026-11-01T06:10:00Z"))
        assertEquals(Instant.parse("2026-11-01T06:30:00Z"), range(draft).first)
        assertEquals(Duration.ofHours(1), Duration.between(range(draft).first, range(draft).second))
        assertEquals(range(draft), range(draft.withDisplayZone(shanghai)))
    }

    @Test fun `an unconfirmed date choice converts across midnight without changing the form until confirmed`() {
        val form = initialState(EventEditMode.Edit(source), listOf(calendar), shanghai, now)
        val pending = EventPickerDraft(form.start, form.displayZone, false, form.originalStart)
            .withDate(LocalDate.parse("2026-11-17")).withDisplayZone(newYork)
        assertEquals(LocalDateTime.parse("2026-11-16T20:00:00"), pending.value)
        assertEquals(Instant.parse(source.startsAt), range(form).first) // Cancel keeps this value.
        val confirmed = form.withDisplayZone(newYork).withStart(pending.value, pending.original)
        assertEquals(Instant.parse("2026-11-17T01:00:00Z"), range(confirmed).first)
        assertEquals(Duration.ofMinutes(45), Duration.between(range(confirmed).first, range(confirmed).second))
    }

    @Test fun `event zone resolution follows event then calendar then device`() {
        assertEquals(melbourne, resolveEventZoneId("Australia/Melbourne", "Asia/Shanghai", shanghai))
        assertEquals(shanghai, resolveEventZoneId(null, "Asia/Shanghai", melbourne))
        assertEquals(melbourne, resolveEventZoneId(null, null, melbourne))
        // 野值（导入数据里的城市名等）当没给，逐级往下回落。
        assertEquals(shanghai, resolveEventZoneId("上海", "Asia/Shanghai", melbourne))
        assertEquals(melbourne, resolveEventZoneId("Not/AZone", "Also/NotAZone", melbourne))
        assertEquals(melbourne, resolveEventZoneId("", "  ", melbourne))
    }

    @Test fun `edit seeds the event zone from the event and sends it back`() {
        val form = initialState(EventEditMode.Edit(source), listOf(calendar), shanghai, now)
        assertEquals(melbourne, form.eventZone)
        assertTrue(form.zoneTouched)
        val (_, update) = buildBodies(form)
        assertEquals("Australia/Melbourne", update!!.extra!!.timezone)
    }

    @Test fun `create inherits the calendar zone and switching calendars moves an untouched zone`() {
        val zoned = CalendarMeta("cal", "Work", "#334455", timezone = "America/New_York")
        val other = CalendarMeta("cal2", "Other", "#334455", timezone = "Asia/Shanghai")
        val form = initialState(EventEditMode.Create(), listOf(zoned, other), melbourne, now)
            .copy(summary = "T")
        assertEquals(newYork, form.eventZone)
        val (create, _) = buildBodies(form)
        assertEquals("America/New_York", create!!.extra!!.timezone)
        val switched = form.withCalendarSelection("cal2", listOf(zoned, other))
        assertEquals(shanghai, switched.eventZone)
        // 亲手选过之后，切换日历不再动时区。
        val pinned = form.withZoneSelection(melbourne).withCalendarSelection("cal2", listOf(zoned, other))
        assertEquals(melbourne, pinned.eventZone)
    }

    @Test fun `edit with unloaded extra never sends a guessed zone until the user picks one`() {
        val bare = source.copy(extra = null)
        val form = initialState(EventEditMode.Edit(bare), listOf(calendar), shanghai, now)
        assertFalse(form.zoneTouched)
        val (_, update) = buildBodies(form)
        assertEquals(null, update!!.extra?.timezone)
        val picked = form.withZoneSelection(newYork)
        val (_, update2) = buildBodies(picked)
        assertEquals("America/New_York", update2!!.extra!!.timezone)
    }

    @Test fun `pending time confirmation is identical before or after the zone update effect`() {
        val local = LocalDateTime.parse("2026-11-01T01:30:00.123")
        val pending = EventPickerDraft(local, newYork, false, EventFormInstant("2026-11-01T06:30:00.123Z", local)).withTime(1, 45)
        val beforeEffect = pending.withDisplayZone(shanghai)
        val afterEffect = beforeEffect.withTime(beforeEffect.value.hour, beforeEffect.value.minute).withDisplayZone(shanghai)
        assertEquals(LocalDateTime.parse("2026-11-01T14:45:00"), beforeEffect.value)
        assertEquals("2026-11-01T06:45:00Z", beforeEffect.original!!.iso)
        assertEquals(beforeEffect, afterEffect)
        val allDay = EventPickerDraft(local, newYork, true).withDate(LocalDate.parse("2026-11-02"))
        assertEquals(allDay.value, allDay.withDisplayZone(shanghai).value)
    }
}
