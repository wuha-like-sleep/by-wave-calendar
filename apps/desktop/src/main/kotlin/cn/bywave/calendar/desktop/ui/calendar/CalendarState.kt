// Lightweight state holder for the main calendar screen. Compose
// Desktop doesn't have AndroidX ViewModel, so we use a plain class
// scoped via `remember` to the screen. State is a single MutableStateFlow
// so the UI can collectAsState() it.
//
// v0.3 fetches one Mon-Sun window at a time. v0.4 will pre-fetch
// adjacent weeks for smooth left/right navigation.

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
import java.time.ZoneId
import java.time.format.DateTimeFormatter

data class CalendarUiState(
    val weekStart: LocalDate,
    val events: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

class CalendarState(
    private val client: ApiClient,
    private val scope: CoroutineScope,
) {
    private val _ui = MutableStateFlow(
        CalendarUiState(weekStart = startOfWeek(LocalDate.now()))
    )
    val ui: StateFlow<CalendarUiState> = _ui.asStateFlow()

    private var loadJob: Job? = null

    /** Refetch the current week. Cancels any in-flight fetch first so
     *  rapid prev/next clicks don't race. */
    fun load() {
        loadJob?.cancel()
        loadJob = scope.launch {
            val ws = _ui.value.weekStart
            _ui.value = _ui.value.copy(loading = true, error = null)
            try {
                val zone = ZoneId.systemDefault()
                val from = ws.atStartOfDay(zone).toInstant()
                val to = ws.plusDays(7).atStartOfDay(zone).toInstant()
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

    fun previousWeek() {
        _ui.value = _ui.value.copy(weekStart = _ui.value.weekStart.minusWeeks(1))
        load()
    }

    fun nextWeek() {
        _ui.value = _ui.value.copy(weekStart = _ui.value.weekStart.plusWeeks(1))
        load()
    }

    fun today() {
        val today = startOfWeek(LocalDate.now())
        if (_ui.value.weekStart != today) {
            _ui.value = _ui.value.copy(weekStart = today)
            load()
        }
    }

    companion object {
        private val ISO_INSTANT: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT
    }
}
