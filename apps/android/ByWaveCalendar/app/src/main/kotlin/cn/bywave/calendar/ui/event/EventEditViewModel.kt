// EventEditViewModel — backs the create/edit form. Two construction
// modes:
//   • EventEditMode.Create(prefilledStart) — new event, optional
//     date/time seed from the calendar grid tap.
//   • EventEditMode.Edit(eventId) — load existing fields by id from
//     CalendarViewModel's already-fetched events. We don't refetch
//     the single event because the parent already has the wide-window
//     snapshot.
//
// Save semantics mirror iOS EventEditView:
//   - All optional fields that are blank go as null so the server's
//     PATCH semantics ("leave unchanged") work cleanly.
//   - extra.url + extra.timezone are emitted together if either is set.
//   - Recurring-event scope picker is deferred to v0.4; PATCH currently
//     edits whole series.

package cn.bywave.calendar.ui.event

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventCreateInput
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.EventExtra
import cn.bywave.calendar.data.model.EventUpdateInput
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

sealed class EventEditMode {
    data class Create(val seedStart: LocalDateTime? = null) : EventEditMode()
    data class Edit(val source: EventDTO) : EventEditMode()
}

data class EventEditUiState(
    val isEdit: Boolean = false,
    val sourceId: String? = null,
    val calendars: List<CalendarMeta> = emptyList(),
    val calendarId: String = "",
    val summary: String = "",
    val location: String = "",
    val description: String = "",
    val url: String = "",
    val start: LocalDateTime = nextHalfHour(),
    val end: LocalDateTime = nextHalfHour().plusHours(1),
    val allDay: Boolean = false,
    val saving: Boolean = false,
    val deleting: Boolean = false,
    val errorMessage: String? = null,
    val finished: Boolean = false,
) {
    val canSubmit: Boolean
        get() = summary.isNotBlank() && calendarId.isNotBlank() && !saving
}

class EventEditViewModel : ViewModel() {
    private val tokens = BywaveApp.instance.tokenStore
    private val _state = MutableStateFlow(EventEditUiState())
    val state: StateFlow<EventEditUiState> = _state.asStateFlow()

    fun bootstrap(mode: EventEditMode, calendars: List<CalendarMeta>) {
        when (mode) {
            is EventEditMode.Create -> {
                val start = mode.seedStart ?: nextHalfHour()
                _state.value = EventEditUiState(
                    isEdit = false,
                    calendars = calendars,
                    calendarId = calendars.firstOrNull()?.id.orEmpty(),
                    start = start,
                    end = start.plusHours(1),
                )
            }
            is EventEditMode.Edit -> {
                val s = mode.source
                val startInstant = runCatching { Instant.parse(s.startsAt) }.getOrNull()
                val endInstant = runCatching { Instant.parse(s.endsAt) }.getOrNull()
                val zone = ZoneId.systemDefault()
                _state.value = EventEditUiState(
                    isEdit = true,
                    sourceId = s.id,
                    calendars = calendars,
                    calendarId = s.calendarId,
                    summary = s.summary,
                    location = s.location.orEmpty(),
                    description = s.description.orEmpty(),
                    url = s.extra?.url.orEmpty(),
                    start = startInstant?.atZone(zone)?.toLocalDateTime() ?: nextHalfHour(),
                    end = endInstant?.atZone(zone)?.toLocalDateTime() ?: nextHalfHour().plusHours(1),
                    allDay = s.allDay,
                )
            }
        }
    }

    fun onSummary(v: String) = _state.update { it.copy(summary = v, errorMessage = null) }
    fun onLocation(v: String) = _state.update { it.copy(location = v) }
    fun onDescription(v: String) = _state.update { it.copy(description = v) }
    fun onUrl(v: String) = _state.update { it.copy(url = v) }
    fun onCalendar(id: String) = _state.update { it.copy(calendarId = id) }
    fun onAllDay(v: Boolean) = _state.update {
        // When toggling to all-day, snap to date boundaries; when
        // toggling back to timed, restore a reasonable timed window.
        if (v) it.copy(
            allDay = true,
            start = it.start.toLocalDate().atStartOfDay(),
            end = it.start.toLocalDate().atTime(23, 59),
        ) else it.copy(
            allDay = false,
            start = it.start,
            end = it.start.plusHours(1),
        )
    }
    fun onStart(date: LocalDate, time: LocalTime) = _state.update {
        val newStart = LocalDateTime.of(date, time)
        // Keep duration: shift end by the same delta as start.
        val durationMinutes = java.time.Duration.between(it.start, it.end).toMinutes()
        it.copy(start = newStart, end = newStart.plusMinutes(durationMinutes.coerceAtLeast(15L)))
    }
    fun onEnd(date: LocalDate, time: LocalTime) = _state.update {
        var newEnd = LocalDateTime.of(date, time)
        // End must be >= start; clamp.
        if (newEnd.isBefore(it.start)) newEnd = it.start.plusMinutes(15)
        it.copy(end = newEnd)
    }

    fun save() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(saving = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val server = tokens.serverUrl ?: error("未登录")
                val client = ApiClient.forServer(server, tokens)

                val zone = ZoneId.systemDefault()
                val startIso = ISO.format(s.start.atZone(zone))
                val endIso = ISO.format(s.end.atZone(zone))

                val urlTrim = s.url.trim()
                val extra = if (urlTrim.isNotEmpty()) {
                    EventExtra(timezone = zone.id, url = urlTrim)
                } else if (!s.allDay) {
                    EventExtra(timezone = zone.id)
                } else null

                if (s.isEdit) {
                    val body = EventUpdateInput(
                        calendarId = s.calendarId,
                        summary = s.summary,
                        description = s.description.ifBlank { null },
                        location = s.location.ifBlank { null },
                        startsAt = startIso,
                        endsAt = endIso,
                        allDay = s.allDay,
                        extra = extra,
                    )
                    client.api.updateEvent(s.sourceId!!, body)
                } else {
                    val body = EventCreateInput(
                        calendarId = s.calendarId,
                        summary = s.summary,
                        description = s.description.ifBlank { null },
                        location = s.location.ifBlank { null },
                        startsAt = startIso,
                        endsAt = endIso,
                        allDay = if (s.allDay) true else null,
                        extra = extra,
                    )
                    client.api.createEvent(body)
                }
                _state.update { it.copy(saving = false, finished = true) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(saving = false, errorMessage = e.localizedMessage ?: "保存失败")
                }
            }
        }
    }

    fun delete() {
        val s = _state.value
        val id = s.sourceId ?: return
        _state.update { it.copy(deleting = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val server = tokens.serverUrl ?: error("未登录")
                val client = ApiClient.forServer(server, tokens)
                client.api.deleteEvent(id)
                _state.update { it.copy(deleting = false, finished = true) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(deleting = false, errorMessage = e.localizedMessage ?: "删除失败")
                }
            }
        }
    }

    private companion object {
        val ISO: DateTimeFormatter = DateTimeFormatter.ISO_OFFSET_DATE_TIME
    }
}

/** Round current time up to the next :00 or :30. Used as the default
 *  "new event" start so users don't have to click time picker first. */
internal fun nextHalfHour(): LocalDateTime {
    val now = LocalDateTime.now()
    val minutes = now.minute
    return when {
        minutes < 30 -> now.withMinute(30).withSecond(0).withNano(0)
        else -> now.plusHours(1).withMinute(0).withSecond(0).withNano(0)
    }
}
