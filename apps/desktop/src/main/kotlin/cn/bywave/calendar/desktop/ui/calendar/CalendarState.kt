// Lightweight state holder for the main calendar screen. Compose
// Desktop doesn't have AndroidX ViewModel, so we use a plain class
// scoped via `remember` to the screen. State is a single MutableStateFlow
// so the UI can collectAsState() it.
//
// v0.4 extends the v0.3 holder with view-mode switching (Day / Week /
// Month). The fetched window is "the smallest range that covers the
// current view": for Day → that day; for Week → the Mon-Sun window;
// for Month → the 6-week visible grid. We refetch when the anchor or
// view mode changes.

package cn.bywave.calendar.desktop.ui.calendar

import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Which secondary modal/dialog is currently open. At most one. */
sealed class ActiveSheet {
    /** Read-only details for an event. */
    data class Detail(val event: EventDTO) : ActiveSheet()
    /** Create new event (optionally seeded with a start time). */
    data class Create(val seedStart: java.time.LocalDateTime? = null) : ActiveSheet()
    /** Edit an existing event. */
    data class Edit(val event: EventDTO) : ActiveSheet()
    /** "Copy as new" — same shape as Create but pre-filled from source. */
    data class Duplicate(val source: EventDTO) : ActiveSheet()
}

/** When the user pressed "Save" on the edit form of a recurring event,
 *  we park the pending update here while the scope picker is up. Once
 *  they pick, we issue the actual PATCH with the chosen scope. */
data class PendingEdit(
    val sourceId: String,
    val sourceStartsAt: String,
    val body: EventUpdateInput,
)

/** Same shape for delete — we park the source while the scope picker
 *  asks for the scope. */
data class PendingDelete(
    val sourceId: String,
    val sourceStartsAt: String,
)

data class CalendarUiState(
    val mode: ViewMode = ViewMode.Week,
    val anchor: LocalDate = LocalDate.now(),
    val events: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val activeSheet: ActiveSheet? = null,
    val saving: Boolean = false,
    val formError: String? = null,
    val pendingScopeEdit: PendingEdit? = null,
    val pendingScopeDelete: PendingDelete? = null,
)

class CalendarState(
    private val client: ApiClient,
    private val scope: CoroutineScope,
) {
    private val _ui = MutableStateFlow(CalendarUiState())
    val ui: StateFlow<CalendarUiState> = _ui.asStateFlow()

    private var loadJob: Job? = null

    /** Refetch the active window. Cancels any in-flight fetch first. */
    fun load() {
        loadJob?.cancel()
        loadJob = scope.launch {
            val s = _ui.value
            _ui.value = s.copy(loading = true, error = null)
            val (from, to) = windowFor(s.mode, s.anchor)
            try {
                val resp = client.events(
                    from = ISO_INSTANT.format(from),
                    to = ISO_INSTANT.format(to),
                )
                _ui.value = _ui.value.copy(
                    events = resp.events,
                    calendars = resp.calendars,
                    loading = false,
                )
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(
                    loading = false,
                    error = e.localizedMessage ?: "加载失败",
                )
            }
        }
    }

    fun setMode(mode: ViewMode) {
        if (_ui.value.mode == mode) return
        _ui.value = _ui.value.copy(mode = mode)
        load()
    }

    fun previous() {
        val s = _ui.value
        _ui.value = s.copy(anchor = step(s.mode, s.anchor, forward = false))
        load()
    }

    fun next() {
        val s = _ui.value
        _ui.value = s.copy(anchor = step(s.mode, s.anchor, forward = true))
        load()
    }

    fun today() {
        val today = LocalDate.now()
        if (_ui.value.anchor != today) {
            _ui.value = _ui.value.copy(anchor = today)
            load()
        }
    }

    /** Jump to a specific day. Used from MonthView when the user
     *  clicks a date cell — we switch to Day mode + set anchor. */
    fun jumpToDay(day: LocalDate) {
        _ui.value = _ui.value.copy(mode = ViewMode.Day, anchor = day)
        load()
    }

    // ---- Sheet routing ----

    fun openDetail(event: EventDTO) {
        _ui.value = _ui.value.copy(activeSheet = ActiveSheet.Detail(event), formError = null)
    }

    fun openCreate(seedStart: java.time.LocalDateTime? = null) {
        _ui.value = _ui.value.copy(activeSheet = ActiveSheet.Create(seedStart), formError = null)
    }

    fun openEdit(event: EventDTO) {
        _ui.value = _ui.value.copy(activeSheet = ActiveSheet.Edit(event), formError = null)
    }

    fun openDuplicate(event: EventDTO) {
        _ui.value = _ui.value.copy(activeSheet = ActiveSheet.Duplicate(event), formError = null)
    }

    fun closeSheet() {
        _ui.value = _ui.value.copy(activeSheet = null, formError = null)
    }

    // ---- Create / update / delete ----

    /** Create a new event. Closes the sheet + reloads on success. */
    fun create(body: EventCreateInput) {
        scope.launch {
            _ui.value = _ui.value.copy(saving = true, formError = null)
            try {
                client.createEvent(body)
                _ui.value = _ui.value.copy(saving = false, activeSheet = null)
                load()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(saving = false, formError = e.localizedMessage ?: "保存失败")
            }
        }
    }

    /** Update an event. If `sourceRrule` is non-null we park the update
     *  and open the scope picker; the caller resumes via [resolveScopeEdit]. */
    fun update(
        sourceId: String,
        sourceRrule: String?,
        sourceStartsAt: String,
        body: EventUpdateInput,
    ) {
        if (sourceRrule != null) {
            _ui.value = _ui.value.copy(
                pendingScopeEdit = PendingEdit(sourceId, sourceStartsAt, body),
            )
            return
        }
        sendUpdate(sourceId, body)
    }

    /** Scope picker callback for edits. scope=null means "user cancelled". */
    fun resolveScopeEdit(scope: String?) {
        val pending = _ui.value.pendingScopeEdit ?: return
        _ui.value = _ui.value.copy(pendingScopeEdit = null)
        if (scope == null) return
        val body = pending.body.copy(
            scope = scope,
            recurrenceId = if (scope == "series") null else pending.sourceStartsAt,
        )
        sendUpdate(pending.sourceId, body)
    }

    private fun sendUpdate(sourceId: String, body: EventUpdateInput) {
        scope.launch {
            _ui.value = _ui.value.copy(saving = true, formError = null)
            try {
                client.updateEvent(sourceId, body)
                _ui.value = _ui.value.copy(saving = false, activeSheet = null)
                load()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(saving = false, formError = e.localizedMessage ?: "保存失败")
            }
        }
    }

    /** Initiate delete. For recurring events we open the scope picker;
     *  for non-recurring we delete immediately. */
    fun delete(event: EventDTO) {
        if (event.rrule != null) {
            _ui.value = _ui.value.copy(
                pendingScopeDelete = PendingDelete(event.id, event.startsAt),
            )
            return
        }
        sendDelete(event.id, scope = null, recurrenceId = null)
    }

    fun resolveScopeDelete(scope: String?) {
        val pending = _ui.value.pendingScopeDelete ?: return
        _ui.value = _ui.value.copy(pendingScopeDelete = null)
        if (scope == null) return
        sendDelete(
            id = pending.sourceId,
            scope = scope,
            recurrenceId = if (scope == "series") null else pending.sourceStartsAt,
        )
    }

    private fun sendDelete(id: String, scope: String?, recurrenceId: String?) {
        this.scope.launch {
            _ui.value = _ui.value.copy(saving = true, formError = null)
            try {
                client.deleteEvent(id, scope, recurrenceId)
                _ui.value = _ui.value.copy(saving = false, activeSheet = null)
                load()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(saving = false, formError = e.localizedMessage ?: "删除失败")
            }
        }
    }

    private fun step(mode: ViewMode, from: LocalDate, forward: Boolean): LocalDate {
        val dir = if (forward) 1L else -1L
        return when (mode) {
            ViewMode.Day -> from.plusDays(dir)
            ViewMode.Week -> from.plusWeeks(dir)
            ViewMode.Month -> from.plusMonths(dir)
        }
    }

    /** Inclusive start, exclusive end — same convention the server uses. */
    private fun windowFor(mode: ViewMode, anchor: LocalDate): Pair<java.time.Instant, java.time.Instant> {
        val zone = ZoneId.systemDefault()
        return when (mode) {
            ViewMode.Day -> {
                val s = anchor.atStartOfDay(zone).toInstant()
                val e = anchor.plusDays(1).atStartOfDay(zone).toInstant()
                s to e
            }
            ViewMode.Week -> {
                val ws = startOfWeek(anchor)
                ws.atStartOfDay(zone).toInstant() to
                    ws.plusDays(7).atStartOfDay(zone).toInstant()
            }
            ViewMode.Month -> {
                val cells = monthGridDays(YearMonth.from(anchor))
                cells.first().atStartOfDay(zone).toInstant() to
                    cells.last().plusDays(1).atStartOfDay(zone).toInstant()
            }
        }
    }

    companion object {
        private val ISO_INSTANT: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT
    }
}
