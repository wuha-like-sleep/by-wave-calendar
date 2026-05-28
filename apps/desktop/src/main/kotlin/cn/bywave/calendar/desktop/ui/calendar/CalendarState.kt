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
import cn.bywave.calendar.desktop.data.model.EventDTO
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

data class CalendarUiState(
    val mode: ViewMode = ViewMode.Week,
    val anchor: LocalDate = LocalDate.now(),
    val events: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    /** Event the user tapped to inspect. Null = no dialog open. */
    val selectedEvent: EventDTO? = null,
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

    fun openEvent(event: EventDTO) {
        _ui.value = _ui.value.copy(selectedEvent = event)
    }

    fun closeEvent() {
        _ui.value = _ui.value.copy(selectedEvent = null)
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
