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
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.cache.EventCache
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.ParseEventResult
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import kotlinx.coroutines.CancellationException
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
    /** Create new event (optionally seeded with a start time). `clientUid`
     *  is generated ONCE when the editor opens (see [CalendarState.openCreate])
     *  and reused on every save attempt so a retried create (e.g. save →
     *  timeout → save again) collapses onto the same server row instead of
     *  duplicating. */
    data class Create(
        val seedStart: java.time.LocalDateTime? = null,
        val clientUid: String = newClientUid(),
    ) : ActiveSheet()
    /** Edit an existing event. Updates are idempotent by event id, so no
     *  clientUid is sent. */
    data class Edit(val event: EventDTO) : ActiveSheet()
    /** "Copy as new" — same shape as Create but pre-filled from source.
     *  Lands as a POST, so it carries its own stable `clientUid` too. */
    data class Duplicate(
        val source: EventDTO,
        val clientUid: String = newClientUid(),
    ) : ActiveSheet()
}

/** Mint a stable client-side uid for an idempotent create. Format mirrors
 *  an iCalendar UID (`<uuid>@bywave`); the server treats it as the event's
 *  uid (UNIQUE per calendar). */
internal fun newClientUid(): String = java.util.UUID.randomUUID().toString() + "@bywave"

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
    val summary: String,
)

/** One just-deleted event offered for undo via the MainScreen snackbar
 *  (parity with web/iOS/Android — the 1.0.14 release note promised this
 *  but only the API half had landed). `token` distinguishes successive
 *  deletes so a stale auto-dismiss can't kill a newer snackbar. */
data class UndoDelete(
    val eventId: String,
    val summary: String,
    val token: Long,
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
    val undoDelete: UndoDelete? = null,
)

class CalendarState(
    private val client: ApiClient,
    private val scope: CoroutineScope,
) {
    private val _ui = MutableStateFlow(CalendarUiState())
    val ui: StateFlow<CalendarUiState> = _ui.asStateFlow()

    private var loadJob: Job? = null

    /** Refetch the active window. Stale-while-revalidate: if a fresh
     *  cache entry exists for the current (deviceId, window), we paint
     *  it immediately so the user sees data the moment they open the
     *  APP / navigate; the network call happens in the background and
     *  replaces the in-memory state when it lands. */
    fun load() {
        loadJob?.cancel()
        loadJob = scope.launch {
            val s = _ui.value
            val (from, to) = windowFor(s.mode, s.anchor)
            val fromIso = ISO_INSTANT.format(from)
            val toIso = ISO_INSTANT.format(to)

            // 1. Paint cache instantly (no spinner) if we have one for
            //    this exact (profile, window) tuple. Cache miss → leave
            //    current state alone but flip `loading=true` so the
            //    user sees the network spinner.
            val deviceId = ProfileStore.profile.value?.deviceId
            val cached = deviceId?.let { EventCache.read(it, fromIso, toIso) }
            if (cached != null) {
                _ui.value = _ui.value.copy(
                    events = cached.events,
                    calendars = cached.calendars,
                    loading = true,   // still revalidating
                    error = null,
                )
            } else {
                _ui.value = _ui.value.copy(loading = true, error = null)
            }

            // 2. Hit the network. On success: replace + persist. On
            //    failure: keep whatever we showed (cache or empty), set
            //    error message. CancellationException is NOT an error
            //    — it just means the user navigated away mid-fetch
            //    (e.g. clicked prev/next twice quickly), so the next
            //    load() call wins and we don't surface the cancellation.
            try {
                val resp = client.events(from = fromIso, to = toIso)
                _ui.value = _ui.value.copy(
                    events = resp.events,
                    calendars = resp.calendars,
                    loading = false,
                )
                if (deviceId != null) EventCache.write(deviceId, fromIso, toIso, resp)
            } catch (e: CancellationException) {
                // Re-throw so the coroutine machinery sees it correctly.
                // DON'T flip to error state — this is a benign cancellation.
                throw e
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(
                    loading = false,
                    error = e.localizedMessage ?: cn.bywave.calendar.desktop.i18n.I18n.t("error.loadFailed"),
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

    /** Create a new event. Closes the sheet + reloads on success.
     *
     *  `clientUid` is read from the open Create/Duplicate sheet (generated
     *  once when that sheet opened), NOT minted here — so a retried save
     *  reuses the same uid and the server collapses the retry onto the
     *  first row instead of duplicating. Falls back to a fresh uid only if
     *  no create sheet is somehow open (defensive; shouldn't happen). */
    fun create(body: EventCreateInput) {
        val clientUid = when (val sheet = _ui.value.activeSheet) {
            is ActiveSheet.Create -> sheet.clientUid
            is ActiveSheet.Duplicate -> sheet.clientUid
            else -> newClientUid()
        }
        scope.launch {
            _ui.value = _ui.value.copy(saving = true, formError = null)
            try {
                client.createEvent(body, clientUid = clientUid)
                _ui.value = _ui.value.copy(saving = false, activeSheet = null)
                load()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(saving = false, formError = e.localizedMessage ?: cn.bywave.calendar.desktop.i18n.I18n.t("error.saveFailed"))
            }
        }
    }

    /** Natural-language quick-add: parse a phrase into event fields via the
     *  shared server endpoint. `now` = local wall-clock so 明天/周五 resolve in
     *  the user's zone. Returns null on any failure (incl. old-server 404) so
     *  the dialog just leaves the form untouched. */
    suspend fun parseEvent(text: String): ParseEventResult? {
        val now = java.time.LocalDateTime.now().withNano(0).toString()
        return runCatching { client.parseEvent(text, now) }.getOrNull()
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
                _ui.value = _ui.value.copy(saving = false, formError = e.localizedMessage ?: cn.bywave.calendar.desktop.i18n.I18n.t("error.saveFailed"))
            }
        }
    }

    /** Initiate delete. For recurring events we open the scope picker;
     *  for non-recurring we delete immediately. */
    fun delete(event: EventDTO) {
        if (event.rrule != null) {
            _ui.value = _ui.value.copy(
                pendingScopeDelete = PendingDelete(event.id, event.startsAt, event.summary),
            )
            return
        }
        sendDelete(event.id, scope = null, recurrenceId = null, summary = event.summary)
    }

    fun resolveScopeDelete(scope: String?) {
        val pending = _ui.value.pendingScopeDelete ?: return
        _ui.value = _ui.value.copy(pendingScopeDelete = null)
        if (scope == null) return
        sendDelete(
            id = pending.sourceId,
            scope = scope,
            recurrenceId = if (scope == "series") null else pending.sourceStartsAt,
            summary = pending.summary,
        )
    }

    /** Drag-released: shift an event by `deltaMinutes` (in time) and
     *  `deltaDays` (across columns) and PATCH startsAt/endsAt. The
     *  delta is what the WeekView already snapped to 15-minute boundaries
     *  + whole-day columns, so we don't need to re-snap here.
     *
     *  Recurring events reuse the existing scope-picker flow via
     *  [update] — pickerless edits would silently rewrite the whole
     *  series, the same data-loss bug we already fix for save+delete. */
    fun applyMove(event: EventDTO, deltaMinutes: Int, deltaDays: Int) {
        if (deltaMinutes == 0 && deltaDays == 0) return
        val origStart = runCatching { java.time.Instant.parse(event.startsAt) }.getOrNull() ?: return
        val origEnd = runCatching { java.time.Instant.parse(event.endsAt) }.getOrNull() ?: return
        val totalMin = deltaMinutes.toLong() + deltaDays.toLong() * 24L * 60L
        val newStart = origStart.plus(totalMin, java.time.temporal.ChronoUnit.MINUTES)
        val newEnd = origEnd.plus(totalMin, java.time.temporal.ChronoUnit.MINUTES)
        val zone = ZoneId.systemDefault()
        val iso = DateTimeFormatter.ISO_OFFSET_DATE_TIME
        val body = cn.bywave.calendar.desktop.data.model.EventUpdateInput(
            startsAt = iso.format(newStart.atZone(zone)),
            endsAt = iso.format(newEnd.atZone(zone)),
        )
        update(event.id, event.rrule, event.startsAt, body)
    }

    /** Drag-released on the bottom-edge resize handle: stretch the
     *  event to end at a new time, keeping start unchanged. */
    fun applyResize(event: EventDTO, deltaMinutes: Int) {
        if (deltaMinutes == 0) return
        val origStart = runCatching { java.time.Instant.parse(event.startsAt) }.getOrNull() ?: return
        val origEnd = runCatching { java.time.Instant.parse(event.endsAt) }.getOrNull() ?: return
        // Clamp: end must stay at least 15 min after start.
        val candidate = origEnd.plus(deltaMinutes.toLong(), java.time.temporal.ChronoUnit.MINUTES)
        val minEnd = origStart.plus(15L, java.time.temporal.ChronoUnit.MINUTES)
        val finalEnd = if (candidate.isBefore(minEnd)) minEnd else candidate
        val zone = ZoneId.systemDefault()
        val iso = DateTimeFormatter.ISO_OFFSET_DATE_TIME
        val body = cn.bywave.calendar.desktop.data.model.EventUpdateInput(
            endsAt = iso.format(finalEnd.atZone(zone)),
        )
        update(event.id, event.rrule, event.startsAt, body)
    }

    private fun sendDelete(id: String, scope: String?, recurrenceId: String?, summary: String? = null) {
        this.scope.launch {
            _ui.value = _ui.value.copy(saving = true, formError = null)
            try {
                client.deleteEvent(id, scope, recurrenceId)
                // Whole-event (series) deletes are plain soft-deletes the
                // /restore endpoint can reverse — offer undo. Instance/
                // future scopes edit the master (exdate/UNTIL) and can't
                // be undone by restore, so no snackbar for those.
                val undo = if ((scope == null || scope == "series") && summary != null)
                    UndoDelete(eventId = id, summary = summary, token = System.nanoTime())
                else null
                _ui.value = _ui.value.copy(saving = false, activeSheet = null, undoDelete = undo ?: _ui.value.undoDelete)
                load()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(saving = false, formError = e.localizedMessage ?: cn.bywave.calendar.desktop.i18n.I18n.t("error.deleteFailed"))
            }
        }
    }

    /** Undo the last delete (snackbar action). Restore is idempotent
     *  server-side, so a double-click is harmless. */
    fun undoLastDelete() {
        val undo = _ui.value.undoDelete ?: return
        this.scope.launch {
            try {
                client.restoreEvent(undo.eventId)
                _ui.value = _ui.value.copy(undoDelete = null)
                load()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(formError = e.localizedMessage ?: cn.bywave.calendar.desktop.i18n.I18n.t("error.deleteFailed"))
            }
        }
    }

    /** Auto-dismiss from the snackbar timer. Token-guarded so a stale
     *  timer can't dismiss a newer snackbar. */
    fun dismissUndoDelete(token: Long) {
        if (_ui.value.undoDelete?.token == token) {
            _ui.value = _ui.value.copy(undoDelete = null)
        }
    }

    private fun step(mode: ViewMode, from: LocalDate, forward: Boolean): LocalDate {
        val dir = if (forward) 1L else -1L
        return when (mode) {
            ViewMode.Day -> from.plusDays(dir)
            ViewMode.Week -> from.plusWeeks(dir)
            ViewMode.Month -> from.plusMonths(dir)
            // Agenda shows a rolling ~30-day window; prev/next pages it.
            ViewMode.Agenda -> from.plusDays(dir * AGENDA_WINDOW_DAYS)
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
            // Agenda: a flat list from the anchor day forward for
            // AGENDA_WINDOW_DAYS. The window starts at the anchor (today by
            // default) so it reads as "what's coming up".
            ViewMode.Agenda -> {
                val s = anchor.atStartOfDay(zone).toInstant()
                val e = anchor.plusDays(AGENDA_WINDOW_DAYS).atStartOfDay(zone).toInstant()
                s to e
            }
        }
    }

    companion object {
        private val ISO_INSTANT: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT
        /** Length of the Agenda view's rolling window, in days. */
        private const val AGENDA_WINDOW_DAYS = 30L
    }
}
