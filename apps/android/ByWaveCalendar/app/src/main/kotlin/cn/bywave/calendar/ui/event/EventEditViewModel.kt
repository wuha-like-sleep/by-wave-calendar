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
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventCreateInput
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.EventExtra
import cn.bywave.calendar.data.model.EventUpdateInput
import cn.bywave.calendar.data.model.ParseEventInput
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
    // seedEnd/seedSummary let the natural-language quick-add prefill a full
    // event (parsed summary + start + end), not just a start.
    data class Create(
        val seedStart: LocalDateTime? = null,
        val seedEnd: LocalDateTime? = null,
        val seedSummary: String? = null,
    ) : EventEditMode()
    data class Edit(val source: EventDTO) : EventEditMode()
    /** "Copy as new event" — same fields as source but a brand new id
     *  + next-half-hour start. Lands at the server as a fresh POST. */
    data class Duplicate(val source: EventDTO) : EventEditMode()
}

data class EventEditUiState(
    val isEdit: Boolean = false,
    val sourceId: String? = null,
    /** Idempotency key for the create (POST) path. Generated ONCE in
     *  bootstrap when the editor opens for a new event (Create or
     *  Duplicate) and reused on every save attempt, so a retried save
     *  (timeout → user taps again) collapses onto the first server row
     *  instead of duplicating. Null in edit (PATCH) mode — updates are
     *  already idempotent by id. */
    val clientUid: String? = null,
    /** Source event's RRULE — non-null when editing a recurring event.
     *  Used by EventEditScreen to decide whether to pop the
     *  RecurringScopePicker before save. */
    val sourceRrule: String? = null,
    /** Source event's startsAt — passed to the server as recurrenceId
     *  when scope is "instance" or "future" so it knows WHICH occurrence
     *  the user is editing. */
    val sourceStartsAt: String? = null,
    val calendars: List<CalendarMeta> = emptyList(),
    val calendarId: String = "",
    val summary: String = "",
    val location: String = "",
    val description: String = "",
    val url: String = "",
    val meetingPassword: String = "",
    val start: LocalDateTime = nextHalfHour(),
    val end: LocalDateTime = nextHalfHour().plusHours(1),
    val allDay: Boolean = false,
    val saving: Boolean = false,
    val parsing: Boolean = false,
    val deleting: Boolean = false,
    val errorMessage: String? = null,
    val finished: Boolean = false,
    /** 打开编辑器那一刻所有可编辑字段的指纹。bootstrap 里写入一次，
     *  之后不再变，用来判断「用户到底改过东西没有」。 */
    val pristine: String = "",
) {
    val canSubmit: Boolean
        get() = summary.isNotBlank() && calendarId.isNotBlank() && !saving

    /** 当前字段的指纹。字段增删时记得同步这里，否则新字段的改动会被
     *  当成「没改过」——那就又变成静默丢弃。 */
    val fingerprint: String
        get() = listOf(
            calendarId, summary, location, description, url, meetingPassword,
            start.toString(), end.toString(), allDay.toString(),
        ).joinToString("\u0000")

    /** 有未保存的改动。退出前要拦一下：新建/编辑事件里填了一半的内容
     *  被返回键静默清掉，用户不会知道是自己按错了还是 APP 丢了数据。 */
    val hasUnsavedChanges: Boolean
        get() = !saving && !deleting && !finished && fingerprint != pristine
}

/**
 * 日历列表后到时的状态迁移。抽成纯函数是为了能在纯 JVM 单元测试里跑 ——
 * EventEditViewModel 构造时就取 BywaveApp.instance，单测里根本 new 不出来。
 */
internal fun EventEditUiState.withCalendars(calendars: List<CalendarMeta>): EventEditUiState {
    if (this.calendars == calendars) return this
    val nextId = if (calendarId.isBlank()) calendars.firstOrNull()?.id.orEmpty() else calendarId
    val updated = copy(calendars = calendars, calendarId = nextId)
    // 用户还没动过表单的话，基准指纹要跟着挪，否则「日历后到」会被当成
    // 用户的改动，一按返回就凭空弹出「放弃修改？」。
    return if (fingerprint == pristine) updated.copy(pristine = updated.fingerprint) else updated
}

class EventEditViewModel : ViewModel() {
    // Application singleton doubles as a Context for resolving localized
    // user-facing error strings (this VM extends plain ViewModel, so it
    // has no built-in getApplication()).
    private val app = BywaveApp.instance
    private val profiles = app.profiles
    private val _state = MutableStateFlow(EventEditUiState())
    val state: StateFlow<EventEditUiState> = _state.asStateFlow()

    fun bootstrap(mode: EventEditMode, calendars: List<CalendarMeta>) {
        bootstrapFields(mode, calendars)
        // 所有分支都已经把初始字段填好了，这里统一记一次基准指纹。
        _state.update { it.copy(pristine = it.fingerprint) }
    }

    private fun bootstrapFields(mode: EventEditMode, calendars: List<CalendarMeta>) {
        when (mode) {
            is EventEditMode.Create -> {
                val start = mode.seedStart ?: nextHalfHour()
                _state.value = EventEditUiState(
                    isEdit = false,
                    // Stable idempotency key — generated here, ONCE per
                    // editor open, so retried saves reuse it (no dupes).
                    clientUid = newClientUid(),
                    calendars = calendars,
                    calendarId = calendars.firstOrNull()?.id.orEmpty(),
                    summary = mode.seedSummary.orEmpty(),
                    start = start,
                    end = mode.seedEnd ?: start.plusHours(1),
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
                    sourceRrule = s.rrule,
                    sourceStartsAt = s.startsAt,
                    calendars = calendars,
                    calendarId = s.calendarId,
                    summary = s.summary,
                    location = s.location.orEmpty(),
                    description = s.description.orEmpty(),
                    url = s.extra?.url.orEmpty(),
                    meetingPassword = s.extra?.meetingPassword.orEmpty(),
                    start = startInstant?.atZone(zone)?.toLocalDateTime() ?: nextHalfHour(),
                    end = endInstant?.atZone(zone)?.toLocalDateTime() ?: nextHalfHour().plusHours(1),
                    allDay = s.allDay,
                )
            }
            is EventEditMode.Duplicate -> {
                val s = mode.source
                val zone = ZoneId.systemDefault()
                // Keep the original duration but shift the start to
                // next half-hour so we don't post in the past.
                val origStart = runCatching { Instant.parse(s.startsAt) }.getOrNull()
                val origEnd = runCatching { Instant.parse(s.endsAt) }.getOrNull()
                val durationMin = if (origStart != null && origEnd != null) {
                    java.time.Duration.between(origStart, origEnd).toMinutes().coerceAtLeast(15L)
                } else 60L
                val newStart = nextHalfHour()
                _state.value = EventEditUiState(
                    isEdit = false,                     // POST, not PATCH
                    // Fresh idempotency key — "copy as new" is a create,
                    // so it gets its own once-per-open clientUid too.
                    clientUid = newClientUid(),
                    sourceId = null,
                    calendars = calendars,
                    calendarId = s.calendarId,
                    summary = s.summary,
                    location = s.location.orEmpty(),
                    description = s.description.orEmpty(),
                    url = s.extra?.url.orEmpty(),
                    meetingPassword = s.extra?.meetingPassword.orEmpty(),
                    start = newStart,
                    end = newStart.plusMinutes(durationMin),
                    allDay = s.allDay,
                )
            }
        }
    }

    /**
     * 日历列表后到时补进来。
     *
     * 冷启动头两秒点「+」，calendars 还是空的：bootstrap 里
     * `calendars.firstOrNull()?.id` 取到空串，而 canSubmit 要求它非空 ——
     * 保存按钮从此永远是灰的。而 EventEditScreen 的 bootstrap 那个
     * LaunchedEffect 的 key 里不含 calendars，日历后到也不会重新 bootstrap。
     * 离线首启（缓存空 + 同步失败）时这是**永久**状态。
     *
     * 这里不走重新 bootstrap：那会把用户已经填了一半的内容冲掉。只补两样
     * 东西 —— 列表本身，以及还没选中时的默认日历。
     */
    fun onCalendarsChanged(calendars: List<CalendarMeta>) {
        _state.update { it.withCalendars(calendars) }
    }

    fun onSummary(v: String) = _state.update { it.copy(summary = v, errorMessage = null) }
    fun onLocation(v: String) = _state.update { it.copy(location = v) }
    fun onDescription(v: String) = _state.update { it.copy(description = v) }
    fun onUrl(v: String) = _state.update { it.copy(url = v) }
    fun onMeetingPassword(v: String) = _state.update { it.copy(meetingPassword = v) }

    /** Natural-language quick-add: send the phrase to the shared server parser
     *  and fill summary + start + end in place. Needs server ≥ 1.6.4; on any
     *  failure (incl. 404 on older servers) we just clear the spinner + show a
     *  hint and leave the form so the user can still fill it by hand. */
    fun quickParse(text: String) {
        val phrase = text.trim()
        if (phrase.isEmpty()) return
        _state.update { it.copy(parsing = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val profile = profiles.active() ?: error(app.getString(R.string.eventedit_err_not_logged_in))
                val client = ApiClient.forProfile(profile, profiles)
                val now = LocalDateTime.now().withNano(0).toString() // naive local wall-clock
                val r = client.api.parseEvent(ParseEventInput(phrase, now))
                val start = LocalDateTime.parse(r.startsAt)
                val end = LocalDateTime.parse(r.endsAt)
                _state.update {
                    it.copy(
                        summary = if (r.summary.isNotBlank()) r.summary else it.summary,
                        start = start,
                        end = end,
                        parsing = false,
                        errorMessage = null,
                    )
                }
            } catch (_: Exception) {
                _state.update { it.copy(parsing = false, errorMessage = app.getString(R.string.quickadd_failed)) }
            }
        }
    }
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

    /** Save the in-progress edit. For recurring events (state.sourceRrule
     *  is non-null) the caller MUST first pop the RecurringScopePicker
     *  and pass scope + recurrenceId, otherwise the server defaults to
     *  "series" and the user's "edit just this one occurrence" silently
     *  rewrites the whole repeating set. */
    fun save(scope: String? = null, recurrenceId: String? = null) {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(saving = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val profile = profiles.active() ?: error(app.getString(R.string.eventedit_err_not_logged_in))
                val client = ApiClient.forProfile(profile, profiles)

                val zone = ZoneId.systemDefault()
                val startIso = ISO.format(s.start.atZone(zone))
                val endIso = ISO.format(s.end.atZone(zone))

                val urlTrim = s.url.trim()
                val pwTrim = s.meetingPassword.trim()
                val extra = if (urlTrim.isNotEmpty() || pwTrim.isNotEmpty()) {
                    EventExtra(timezone = zone.id, url = urlTrim.ifEmpty { null }, meetingPassword = pwTrim.ifEmpty { null })
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
                        scope = scope,
                        recurrenceId = recurrenceId,
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
                        // Reuse the once-per-open key so a retried save
                        // (timeout → tap again) hits the same server uid
                        // and collapses onto the first row.
                        clientUid = s.clientUid,
                    )
                    client.api.createEvent(body)
                }
                _state.update { it.copy(saving = false, finished = true) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(saving = false, errorMessage = e.localizedMessage ?: app.getString(R.string.eventedit_err_save_failed))
                }
            }
        }
    }

    fun delete(scope: String? = null, recurrenceId: String? = null) {
        val s = _state.value
        val id = s.sourceId ?: return
        _state.update { it.copy(deleting = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val profile = profiles.active() ?: error(app.getString(R.string.eventedit_err_not_logged_in))
                val client = ApiClient.forProfile(profile, profiles)
                client.api.deleteEvent(id, scope, recurrenceId)
                _state.update { it.copy(deleting = false, finished = true) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(deleting = false, errorMessage = e.localizedMessage ?: app.getString(R.string.eventedit_err_delete_failed))
                }
            }
        }
    }

    /** Mint a fresh stable idempotency key for a new-event editing
     *  session. Called ONCE per editor open (in bootstrap), never inside
     *  save — a retried save must reuse the stored value so the server
     *  dedups on the same uid. */
    private fun newClientUid(): String =
        java.util.UUID.randomUUID().toString() + "@bywave"

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
