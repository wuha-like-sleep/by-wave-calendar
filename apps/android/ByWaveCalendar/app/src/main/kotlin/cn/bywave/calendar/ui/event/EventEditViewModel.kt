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

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.ConflictsRequest
import cn.bywave.calendar.data.model.EventAlarm
import cn.bywave.calendar.data.model.EventAlarmsField
import cn.bywave.calendar.data.model.EventConflict
import cn.bywave.calendar.data.model.EventCreateInput
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.EventExtra
import cn.bywave.calendar.data.model.EventUpdateInput
import cn.bywave.calendar.data.model.ParseEventInput
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import cn.bywave.calendar.event.duplicateEventRange
import cn.bywave.calendar.event.eventFormDateTime
import cn.bywave.calendar.event.EventFormInstant
import cn.bywave.calendar.event.eventFormIso
import cn.bywave.calendar.event.eventStringField
import cn.bywave.calendar.data.model.EventExtraDTO
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

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
    /** The event's anchor timezone (extra.timezone) as chosen in the
     *  form. Resolved once at bootstrap — the event's own stored zone,
     *  else the selected calendar's zone, else the device zone — and
     *  following the calendar picker until the user picks a zone
     *  themselves (see withCalendarSelection). Like iOS, this field is
     *  metadata for the server's recurrence expansion / export: the
     *  form's wall clock stays in the device zone and changing the zone
     *  never reinterprets the typed times. Blank only in hand-built
     *  states (unit tests); buildExtra then keeps the legacy fallback. */
    val zoneId: String = "",
    /** True once the user picked a zone in the form. Before that, the
     *  zone follows the calendar picker (a not-yet-explicit zone is
     *  inherited, so it should track the calendar it is inherited from). */
    val zoneTouched: Boolean = false,
    val sourceExtra: EventExtraDTO? = null,
    val originalStart: EventFormInstant? = null,
    val originalEnd: EventFormInstant? = null,
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
    /** Selected primary reminder trigger ("" = none). One of
     *  TIMED_REMINDER_TRIGGERS / ALLDAY_REMINDER_TRIGGERS depending on
     *  [allDay] — the exact value sets from the server's
     *  src/lib/reminder_triggers.ts. Existing alarms outside the
     *  current group are not represented here; buildAlarmsField
     *  carries them through untouched. */
    val reminder: String = "",
    /** Selected category ("" = none) — one of the web editor's values
     *  (work / personal / family / health / travel / meeting), stored
     *  in extra.category. Form-managed: buildExtra sends the current
     *  selection, with an explicit null when cleared. */
    val category: String = "",
    /** Recurrence form state (see RruleEditor.kt). Parse/build keep
     *  unmodelable rules as passthrough so they survive a save. */
    val rruleState: RruleFormState = RruleFormState(),
    /** The series' exdates as loaded from the server (edit mode). */
    val sourceExdates: List<String> = emptyList(),
    /** Current exdates — restoring one in the editor removes it here.
     *  Sent on PATCH only when different from [sourceExdates] (and
     *  see the server caveat on EventUpdateInput.exdates). */
    val exdates: List<String> = emptyList(),
    /** Conflicts found by the pre-save server check. Non-empty means
     *  the save is PAUSED on the confirmation dialog — nothing has
     *  been written yet. The check failing never fills this (a failed
     *  check must not block saving). */
    val pendingConflicts: List<EventConflict> = emptyList(),
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
        get() = summary.isNotBlank() && calendarId.isNotBlank() && !saving && !deleting && !parsing && !finished

    /** 当前字段的指纹。字段增删时记得同步这里，否则新字段的改动会被
     *  当成「没改过」——那就又变成静默丢弃。 */
    val fingerprint: String
        get() = listOf(
            calendarId, summary, location, description, url, meetingPassword,
            start.toString(), end.toString(), allDay.toString(), reminder,
            category, rruleState.effectiveRrule().orEmpty(),
            exdates.joinToString(","), zoneId,
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
    var updated = copy(calendars = calendars, calendarId = nextId)
    // 时区若是从日历继承来的（事件自己没有、用户也没挑过），日历后到 /
    // 刷新时要跟着定：bootstrap 时可能还没有日历可继承，只能先用设备
    // 时区占位。事件自带时区或用户挑过的，一律不许动。
    if (!zoneTouched && sourceExtra?.timezone.isNullOrBlank()) {
        updated = updated.copy(
            zoneId = resolveEventZoneId(null, calendars.firstOrNull { it.id == nextId }?.timezone),
        )
    }
    // 用户还没动过表单的话，基准指纹要跟着挪，否则「日历后到」会被当成
    // 用户的改动，一按返回就凭空弹出「放弃修改？」。
    return if (fingerprint == pristine) updated.copy(pristine = updated.fingerprint) else updated
}

/** First usable IANA zone of: the event's own stored zone, the
 *  calendar's zone, the device zone. Stored strings come from other
 *  clients and old versions, so anything ZoneId can't parse is skipped
 *  instead of crashing the editor (or being sent back to the server). */
internal fun resolveEventZoneId(
    explicit: String?,
    calendarTimeZone: String?,
    device: ZoneId = ZoneId.systemDefault(),
): String {
    for (candidate in listOf(explicit, calendarTimeZone)) {
        val id = candidate?.trim().orEmpty()
        if (id.isNotEmpty() && runCatching { ZoneId.of(id) }.isSuccess) return id
    }
    return device.id
}

/** Calendar-picker change. A zone the user never explicitly picked is
 *  inherited from the calendar, so it follows the picker; a zone that
 *  came from the event itself (or was picked by hand) stays put —
 *  moving an event between calendars must not silently re-anchor it. */
internal fun EventEditUiState.withCalendarSelection(id: String): EventEditUiState {
    val followsCalendar = !zoneTouched &&
        sourceExtra?.timezone.isNullOrBlank() &&
        (zoneId.isBlank() || zoneId == calendars.firstOrNull { it.id == calendarId }?.timezone)
    return copy(
        calendarId = id,
        zoneId = if (followsCalendar) {
            resolveEventZoneId(null, calendars.firstOrNull { it.id == id }?.timezone)
        } else zoneId,
    )
}

/** Zone-picker change: from now on the zone is the user's own choice
 *  and stops following the calendar picker. */
internal fun EventEditUiState.withZoneSelection(id: String): EventEditUiState =
    copy(zoneId = id, zoneTouched = true)

internal fun EventEditUiState.buildExtra(zone: ZoneId): EventExtra = EventExtra(
    // The form's zone wins over the stored one — that is the picker's
    // whole point. All-day events keep the stored zone untouched (the
    // form offers no picker for them, same as iOS: the field is "not
    // managed here", and the server's all-day reminders read it).
    // zoneId blank only happens in hand-built states (unit tests);
    // there the legacy rule applies (stored zone, else device on create).
    timezone = when {
        allDay -> sourceExtra?.timezone
        zoneId.isNotBlank() -> zoneId
        else -> sourceExtra?.timezone ?: if (!isEdit) zone.id else null
    },
    attendees = if (isEdit) null else sourceExtra?.attendees,
    // Category used to be create-only passthrough; the form manages it
    // now, so — exactly like url — the CURRENT selection is sent, and
    // clearing it against a loaded extra sends an explicit null (the
    // server's shallow merge deletes the key). When extra was never
    // loaded (sourceExtra == null) we still don't invent a deletion.
    category = eventStringField(category, clearWhenEmpty = sourceExtra != null),
    url = eventStringField(url, clearWhenEmpty = isEdit && sourceExtra != null),
    meetingPassword = eventStringField(meetingPassword, clearWhenEmpty = isEdit && sourceExtra != null),
    alarms = buildAlarmsField(),
)

/** Reminder trigger value sets — copied value-for-value from the
 *  server's src/lib/reminder_triggers.ts (TIMED_TRIGGERS /
 *  ALLDAY_TRIGGERS). "" is the "no reminder" sentinel, not a trigger.
 *  Timed offsets are absolute durations; all-day offsets are wall-time
 *  offsets from 00:00 in the event's timezone (PT9H = 09:00 that day). */
internal val TIMED_REMINDER_TRIGGERS: List<String> =
    listOf("", "-PT0M", "-PT5M", "-PT15M", "-PT30M", "-PT1H", "-PT2H", "-P1D", "-P1W")

internal val ALLDAY_REMINDER_TRIGGERS: List<String> =
    listOf("", "PT9H", "-PT15H", "-P1DT15H", "-P6DT15H")

internal fun reminderTriggersFor(allDay: Boolean): List<String> =
    if (allDay) ALLDAY_REMINDER_TRIGGERS else TIMED_REMINDER_TRIGGERS

/** The reminder the editor displays: the first existing alarm whose
 *  trigger falls inside the current (timed / all-day) value set. */
internal fun primaryReminderTrigger(alarms: List<EventAlarm>?, allDay: Boolean): String {
    val group = reminderTriggersFor(allDay)
    return alarms?.firstOrNull { it.trigger in group && it.trigger.isNotEmpty() }?.trigger ?: ""
}

/**
 * 把提醒选择折回 extra.alarms，规则和服务端的浅合并语义配套：
 *
 *   · 结果 = 选中的一条（action DISPLAY、description 用事件标题）
 *     + 既有 alarms 里**不在本组枚举内**的那些（别的客户端/导入写进来的，
 *     编辑器不认识，但绝不能因为用户改了个标题就把它们抹掉）。
 *   · 选「无」且没有其余 alarms，而事件**原本有** alarms key → 显式 null：
 *     服务端浅合并里省略 = 保留、null = 删键，不发 null 提醒永远删不掉。
 *   · 原本就没有 alarms、现在也没选 → 返回 null（字段省略）。这也保住
 *     「extra 没加载完时不要把『没加载』当成『用户清空了』」的老纪律：
 *     sourceExtra 为 null 时 existing 恒为 null，未选提醒绝不发删除。
 */
internal fun EventEditUiState.buildAlarmsField(): EventAlarmsField? {
    val existing = sourceExtra?.alarms
    val group = reminderTriggersFor(allDay)
    val others = existing?.filter { it.trigger !in group } ?: emptyList()
    val selected = if (reminder.isNotEmpty()) {
        listOf(EventAlarm(trigger = reminder, action = "DISPLAY", description = summary))
    } else {
        emptyList()
    }
    val result = selected + others
    return when {
        result.isNotEmpty() -> EventAlarmsField(result)
        existing != null -> EventAlarmsField(null)
        else -> null
    }
}

internal fun EventEditUiState.buildUpdateInput(
    scope: String? = null,
    recurrenceId: String? = null,
    zone: ZoneId = ZoneId.systemDefault(),
): EventUpdateInput = EventUpdateInput(
    calendarId = calendarId,
    summary = summary,
    description = description,
    location = location,
    startsAt = eventFormIso(start, allDay, isStart = true, zone, originalStart),
    endsAt = eventFormIso(end, allDay, isStart = false, zone, originalEnd),
    allDay = allDay,
    // rrule is sent ONLY when the user actually changed the rule:
    // an unchanged rebuilt string can differ textually from the
    // stored one (UNTIL re-encoding, BYDAY ordering), and the server
    // treats any different rrule as "client changed the rule", which
    // switches its exdate-remap behaviour for what was really just a
    // title edit. A passthrough rule always equals sourceRrule, so it
    // is never re-sent. Clearing the rule (freq → none) yields null
    // here too — the wire model cannot express "delete the rule"
    // (explicitNulls drops it, and the server schema rejects JSON
    // null for rrule); same limitation as the desktop editor.
    rrule = rruleState.effectiveRrule().takeIf { it != sourceRrule },
    // Restored occurrences, only when the list actually changed.
    exdates = exdates.takeIf { it != sourceExdates },
    extra = buildExtra(zone),
    scope = scope,
    recurrenceId = recurrenceId,
)

/** The POST body for create / duplicate. Extracted as a pure function
 *  (like buildUpdateInput) so payload tests can pin it — the create
 *  path used to be inlined in doSave, which is exactly how the
 *  duplicate-loses-rrule bug stayed invisible: nothing carried the
 *  source's rule into this body. */
internal fun EventEditUiState.buildCreateInput(zone: ZoneId = ZoneId.systemDefault()): EventCreateInput =
    EventCreateInput(
        calendarId = calendarId,
        summary = summary,
        description = description.ifBlank { null },
        location = location.ifBlank { null },
        startsAt = eventFormIso(start, allDay, isStart = true, zone),
        endsAt = eventFormIso(end, allDay, isStart = false, zone),
        allDay = if (allDay) true else null,
        rrule = rruleState.effectiveRrule(),
        extra = buildExtra(zone),
        clientUid = clientUid,
    )

class EventEditViewModel : ViewModel() {
    // Application singleton doubles as a Context for resolving localized
    // user-facing error strings (this VM extends plain ViewModel, so it
    // has no built-in getApplication()).
    private val app = BywaveApp.instance
    private val profiles = app.profiles

    // "Last calendar an event was saved into" memory for the create
    // default above. Plain SharedPreferences (same store family as
    // ProfileStore); a single string, read synchronously at bootstrap.
    private val uiPrefs by lazy {
        app.getSharedPreferences("bwc-ui-prefs", Context.MODE_PRIVATE)
    }

    private fun lastUsedCalendarId(): String? =
        uiPrefs.getString("last_calendar_id", null)

    private fun rememberCalendarId(id: String) {
        if (id.isNotBlank()) {
            uiPrefs.edit().putString("last_calendar_id", id).apply()
        }
    }
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
                // Default to the calendar the user last saved an
                // event into (the web editor does the same via its
                // lastCalendarId memory); before this, every create
                // silently reset to the server's first calendar and
                // events kept landing in the wrong one. Falls back
                // to the first calendar when the remembered one is
                // gone (deleted / other account).
                val defaultCalendar = calendars.firstOrNull { it.id == lastUsedCalendarId() }
                    ?: calendars.firstOrNull()
                _state.value = EventEditUiState(
                    isEdit = false,
                    // Stable idempotency key — generated here, ONCE per
                    // editor open, so retried saves reuse it (no dupes).
                    clientUid = newClientUid(),
                    calendars = calendars,
                    calendarId = defaultCalendar?.id.orEmpty(),
                    // New events inherit the calendar's zone (the
                    // server's own fallback order); device zone when
                    // the calendar has none or hasn't loaded yet —
                    // withCalendars re-resolves when it arrives.
                    zoneId = resolveEventZoneId(null, defaultCalendar?.timezone),
                    summary = mode.seedSummary.orEmpty(),
                    start = start,
                    end = mode.seedEnd ?: start.plusHours(1),
                )
            }
            is EventEditMode.Edit -> {
                val s = mode.source
                val zone = ZoneId.systemDefault()
                val sourceStart = eventFormDateTime(s.startsAt, s.allDay, zone)
                val sourceEnd = eventFormDateTime(s.endsAt, s.allDay, zone)
                _state.value = EventEditUiState(
                    isEdit = true,
                    sourceId = s.id,
                    sourceRrule = s.rrule,
                    sourceStartsAt = s.startsAt,
                    sourceExtra = s.extra,
                    originalStart = sourceStart?.takeIf { !s.allDay }?.let { EventFormInstant(s.startsAt, it) },
                    originalEnd = sourceEnd?.takeIf { !s.allDay }?.let { EventFormInstant(s.endsAt, it) },
                    calendars = calendars,
                    calendarId = s.calendarId,
                    zoneId = resolveEventZoneId(
                        s.extra?.timezone,
                        calendars.firstOrNull { it.id == s.calendarId }?.timezone,
                    ),
                    summary = s.summary,
                    location = s.location.orEmpty(),
                    description = s.description.orEmpty(),
                    url = s.extra?.url.orEmpty(),
                    meetingPassword = s.extra?.meetingPassword.orEmpty(),
                    start = sourceStart ?: nextHalfHour(),
                    end = sourceEnd ?: nextHalfHour().plusHours(1),
                    allDay = s.allDay,
                    reminder = primaryReminderTrigger(s.extra?.alarms, s.allDay),
                    category = s.extra?.category.orEmpty(),
                    rruleState = RruleFormState.parse(
                        s.rrule,
                        (sourceStart ?: nextHalfHour()).dayOfWeek,
                    ),
                    sourceExdates = s.exdates ?: emptyList(),
                    exdates = s.exdates ?: emptyList(),
                )
            }
            is EventEditMode.Duplicate -> {
                val s = mode.source
                val (newStart, newEnd) = duplicateEventRange(s.startsAt, s.endsAt, s.allDay, nextHalfHour())
                _state.value = EventEditUiState(
                    isEdit = false,                     // POST, not PATCH
                    // Fresh idempotency key — "copy as new" is a create,
                    // so it gets its own once-per-open clientUid too.
                    clientUid = newClientUid(),
                    sourceId = null,
                    sourceExtra = s.extra,
                    calendars = calendars,
                    calendarId = s.calendarId,
                    zoneId = resolveEventZoneId(
                        s.extra?.timezone,
                        calendars.firstOrNull { it.id == s.calendarId }?.timezone,
                    ),
                    summary = s.summary,
                    location = s.location.orEmpty(),
                    description = s.description.orEmpty(),
                    url = s.extra?.url.orEmpty(),
                    meetingPassword = s.extra?.meetingPassword.orEmpty(),
                    start = newStart,
                    end = newEnd,
                    allDay = s.allDay,
                    reminder = primaryReminderTrigger(s.extra?.alarms, s.allDay),
                    category = s.extra?.category.orEmpty(),
                    // **复制必须带上重复规则。** 以前这个分支根本没读
                    // s.rrule，doSave 的新建路径也没给 rrule 赋值 ——
                    // 复制一个每周例会，得到的是一个只出现一次的普通
                    // 事件，而且界面上看不出来。exdates 不复制：那是
                    // 原系列某些具体时刻的删除记录，搬到新系列的
                    // 新起点上没有意义。
                    rruleState = RruleFormState.parse(s.rrule, newStart.dayOfWeek),
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
        if (phrase.isEmpty() || _state.value.parsing || _state.value.saving || _state.value.deleting) return
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
                        // Same fill rules as web/iOS/desktop: a field
                        // the phrase didn't mention never wipes what
                        // the user already typed (location), while
                        // all-day and recurrence are properties of the
                        // phrase itself — a fresh parse replaces them
                        // wholesale (no 全天 / no 每周 in the new phrase
                        // clears the old parse's flags).
                        location = if (!r.location.isNullOrBlank()) r.location else it.location,
                        allDay = r.allDay ?: false,
                        // The parsed rule lands in the RRULE editor
                        // state (unmodelable rules as passthrough), so
                        // the user sees it in the recurrence section
                        // and can adjust or remove it before saving —
                        // no separate read-only carrier.
                        rruleState = RruleFormState.parse(r.rrule, start.dayOfWeek),
                        start = start,
                        end = end,
                        parsing = false,
                        errorMessage = null,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.update { it.copy(parsing = false, errorMessage = app.getString(R.string.quickadd_failed)) }
            }
        }
    }
    fun onCalendar(id: String) = _state.update { it.withCalendarSelection(id) }
    fun onZoneChange(id: String) = _state.update { it.withZoneSelection(id) }
    fun onReminder(v: String) = _state.update { it.copy(reminder = v) }
    fun onCategory(v: String) = _state.update { it.copy(category = v) }
    fun onRruleChange(v: RruleFormState) = _state.update {
        // First time the user picks WEEKLY with no BYDAY yet, seed the
        // start's weekday — the overwhelmingly common intent, and the
        // same default the server expansion assumes without BYDAY.
        val seeded = if (v.freq == RruleFreq.Weekly && v.byDay.isEmpty() && v.passthrough == null) {
            v.copy(byDay = setOf(it.start.dayOfWeek))
        } else {
            v
        }
        it.copy(rruleState = seeded)
    }
    /** Restore one deleted occurrence: drop it from the exdates list.
     *  The change goes out with the next save (see the server caveat
     *  on EventUpdateInput.exdates). */
    fun onRestoreExdate(iso: String) = _state.update {
        it.copy(exdates = it.exdates.filterNot { e -> e == iso })
    }
    fun onAllDay(v: Boolean) = _state.update {
        // The reminder value sets differ between timed and all-day; a
        // trigger from the other group is meaningless here, so it
        // falls back to "none" instead of being saved verbatim.
        val keptReminder = it.reminder.takeIf { r -> r in reminderTriggersFor(v) } ?: ""
        // When toggling to all-day, snap to date boundaries; when
        // toggling back to timed, restore a reasonable timed window.
        if (v) it.copy(
            allDay = true,
            reminder = keptReminder,
            start = it.start.toLocalDate().atStartOfDay(),
            end = maxOf(it.start.toLocalDate(), it.end.toLocalDate()).atTime(23, 59),
        ) else it.copy(
            allDay = false,
            reminder = keptReminder,
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
        if (!newEnd.isAfter(it.start)) newEnd = it.start.plusMinutes(15)
        it.copy(end = newEnd)
    }

    /** 时长快捷片：结束 = 开始 + 片上时长。直接写 end（不走 onEnd 的
     *  日期/时间拆分），片上时长都 ≥30 分钟，不会触发 15 分钟下限。 */
    fun onDurationMinutes(minutes: Long) = _state.update {
        it.copy(end = it.start.plusMinutes(minutes))
    }

    /** Save the in-progress edit. For recurring events (state.sourceRrule
     *  is non-null) the caller MUST first pop the RecurringScopePicker
     *  and pass scope + recurrenceId, otherwise the server defaults to
     *  "series" and the user's "edit just this one occurrence" silently
     *  rewrites the whole repeating set. */
    /** Scope/recurrenceId of the save paused on the conflict dialog,
     *  so 「仍要保存」 resumes exactly the save the user asked for. */
    private var conflictScope: String? = null
    private var conflictRecurrenceId: String? = null

    fun save(scope: String? = null, recurrenceId: String? = null) {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(saving = true, errorMessage = null) }

        viewModelScope.launch {
            // Conflict check BEFORE anything is written — new and edit,
            // timed and all-day, same server judgement as the web
            // editor. A failed check (offline, old server, anything)
            // returns an empty list here: it must never block the save.
            val conflicts = runCatching { fetchConflicts(s) }
                .getOrDefault(emptyList())
            if (conflicts.isNotEmpty()) {
                conflictScope = scope
                conflictRecurrenceId = recurrenceId
                _state.update {
                    it.copy(saving = false, pendingConflicts = conflicts)
                }
                return@launch
            }
            doSave(s, scope, recurrenceId)
        }
    }

    /** 「仍要保存」 on the conflict dialog — resume the paused save. */
    fun confirmSaveDespiteConflicts() {
        val s = _state.value
        if (s.pendingConflicts.isEmpty() || s.saving || s.finished) return
        val scope = conflictScope
        val recurrenceId = conflictRecurrenceId
        conflictScope = null
        conflictRecurrenceId = null
        _state.update { it.copy(saving = true, errorMessage = null, pendingConflicts = emptyList()) }
        viewModelScope.launch { doSave(s, scope, recurrenceId) }
    }

    /** 「取消」 on the conflict dialog — abort the save, keep editing. */
    fun dismissConflicts() {
        conflictScope = null
        conflictRecurrenceId = null
        _state.update { it.copy(pendingConflicts = emptyList()) }
    }

    /** Server-side overlap check for the form's current range. Throws
     *  on any failure — save() catches and treats it as no conflicts. */
    private suspend fun fetchConflicts(s: EventEditUiState): List<EventConflict> {
        val profile = profiles.active() ?: return emptyList()
        val client = ApiClient.forProfile(profile, profiles)
        val zone = ZoneId.systemDefault()
        val startIso: String
        val endIso: String
        if (s.isEdit) {
            val body = s.buildUpdateInput(zone = zone)
            startIso = body.startsAt ?: return emptyList()
            endIso = body.endsAt ?: return emptyList()
        } else {
            startIso = eventFormIso(s.start, s.allDay, isStart = true, zone)
            endIso = eventFormIso(s.end, s.allDay, isStart = false, zone)
        }
        return client.api.eventConflicts(
            ConflictsRequest(
                calendarId = s.calendarId,
                startsAt = startIso,
                endsAt = endIso,
                excludeId = if (s.isEdit) s.sourceId else null,
            ),
        ).conflicts
    }

    private suspend fun doSave(s: EventEditUiState, scope: String?, recurrenceId: String?) {
        try {
            val profile = profiles.active() ?: error(app.getString(R.string.eventedit_err_not_logged_in))
            val client = ApiClient.forProfile(profile, profiles)

            val zone = ZoneId.systemDefault()

            if (s.isEdit) {
                val body = s.buildUpdateInput(scope, recurrenceId, zone)
                client.api.updateEvent(s.sourceId!!, body)
            } else {
                // buildCreateInput carries the once-per-open clientUid
                // (retried saves collapse onto the first server row)
                // and the recurrence rule — duplicates keep repeating.
                client.api.createEvent(s.buildCreateInput(zone))
            }
            // Feed the create-default memory: the next new event
            // starts on the calendar this save just used (for an
            // edit that moved the event, that's the target one).
            rememberCalendarId(s.calendarId)
            _state.update { it.copy(saving = false, finished = true) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update {
                it.copy(saving = false, errorMessage = e.localizedMessage ?: app.getString(R.string.eventedit_err_save_failed))
            }
        }
    }

    fun delete(scope: String? = null, recurrenceId: String? = null) {
        val s = _state.value
        val id = s.sourceId ?: return
        if (s.saving || s.deleting || s.finished) return
        _state.update { it.copy(deleting = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val profile = profiles.active() ?: error(app.getString(R.string.eventedit_err_not_logged_in))
                val client = ApiClient.forProfile(profile, profiles)
                client.api.deleteEvent(id, scope, recurrenceId)
                _state.update { it.copy(deleting = false, finished = true) }
            } catch (e: CancellationException) {
                throw e
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
