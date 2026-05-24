// v0.2: adds view mode (Day/Week/Month) + 15-month wide-window fetch.
//
// We learn from iOS v1.2.1 here: a "fetch the events for the visible
// week" approach causes inconsistencies when switching modes (week
// fetch missed events that day fetch had). Always pull a wide window
// (-2 / +13 months around anchor) and filter locally per view.
//
// `events` is the wide cache. `eventsForAnchor(mode)` slices it for the
// current view: Day → single day filter, Week → 7 days, Month → 42-day
// grid window.

package cn.bywave.calendar.ui.calendar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters

enum class ViewMode { Day, Week, Month }

data class CalendarUiState(
    val mode: ViewMode = ViewMode.Day,
    val anchor: LocalDate = LocalDate.now(),
    val loading: Boolean = false,
    val events: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
    val errorMessage: String? = null,
    val lastSyncedAt: Instant? = null,
    /** Window currently covered by `events`. Used to decide whether
     *  an anchor change needs a refetch. */
    val fetchedFrom: LocalDate? = null,
    val fetchedTo: LocalDate? = null,
)

class CalendarViewModel : ViewModel() {
    private val tokens = BywaveApp.instance.tokenStore
    private val _state = MutableStateFlow(CalendarUiState())
    val state: StateFlow<CalendarUiState> = _state.asStateFlow()

    init { load() }

    fun setMode(mode: ViewMode) {
        _state.update { it.copy(mode = mode) }
        // No fetch — mode change is pure local filtering since v0.2
        // (same trade-off iOS v1.2.1 made).
    }

    fun setAnchor(date: LocalDate) {
        _state.update { it.copy(anchor = date) }
        if (anchorOutsideCachedWindow(date)) load()
    }

    fun shiftAnchor(units: Long) {
        val s = _state.value
        val next = when (s.mode) {
            ViewMode.Day -> s.anchor.plusDays(units)
            ViewMode.Week -> s.anchor.plusWeeks(units)
            ViewMode.Month -> s.anchor.plusMonths(units)
        }
        setAnchor(next)
    }

    fun goToday() = setAnchor(LocalDate.now())

    /** Force a fetch even if anchor is inside the cached window
     *  (pull-to-refresh + post-edit reload). */
    fun reload() = load()

    /** Sign-out hook — called from CalendarScreen's settings menu. */
    fun signOut() {
        tokens.signOut()
        ApiClient.reset()
    }

    // ---- Filtering for each view ----

    fun eventsForDay(day: LocalDate): List<EventDTO> =
        _state.value.events
            .filter { eventOnDay(it, day) }
            .sortedBy { it.startsAt }

    fun eventsForWeek(weekStart: LocalDate): Map<LocalDate, List<EventDTO>> {
        val byDay = mutableMapOf<LocalDate, MutableList<EventDTO>>()
        val days = (0L..6L).map { weekStart.plusDays(it) }
        for (day in days) byDay[day] = mutableListOf()
        for (e in _state.value.events) {
            for (day in days) if (eventOnDay(e, day)) byDay[day]!!.add(e)
        }
        for ((_, list) in byDay) list.sortBy { it.startsAt }
        return byDay
    }

    // ---- Fetch ----

    private fun load() {
        val server = tokens.serverUrl ?: run {
            _state.update { it.copy(errorMessage = "未登录") }
            return
        }
        _state.update { it.copy(loading = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val zone = ZoneId.systemDefault()
                val anchor = _state.value.anchor
                val from = anchor.minusMonths(WINDOW_MONTHS_BACK)
                val to = anchor.plusMonths(WINDOW_MONTHS_FORWARD)
                val fromInstant = from.atStartOfDay(zone).toInstant()
                val toInstant = to.plusDays(1).atStartOfDay(zone).toInstant().minusNanos(1)

                val client = ApiClient.forServer(server, tokens)
                val resp = client.api.events(
                    from = ISO.format(fromInstant.atZone(zone)),
                    to = ISO.format(toInstant.atZone(zone)),
                )

                _state.update {
                    it.copy(
                        loading = false,
                        events = resp.events,
                        calendars = resp.calendars,
                        lastSyncedAt = Instant.now(),
                        fetchedFrom = from,
                        fetchedTo = to,
                    )
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        loading = false,
                        errorMessage = e.localizedMessage ?: "加载事件失败",
                    )
                }
            }
        }
    }

    private fun anchorOutsideCachedWindow(date: LocalDate): Boolean {
        val from = _state.value.fetchedFrom ?: return true
        val to = _state.value.fetchedTo ?: return true
        // 2-week safety margin — refetch BEFORE the visible edge hits
        // the cached boundary (so swiping is instant when in range).
        val marginDays = 14L
        return date.isBefore(from.plusDays(marginDays)) || date.isAfter(to.minusDays(marginDays))
    }

    private companion object {
        const val WINDOW_MONTHS_BACK = 2L
        const val WINDOW_MONTHS_FORWARD = 13L
        val ISO: DateTimeFormatter = DateTimeFormatter.ISO_OFFSET_DATE_TIME
    }
}

// ---- Helpers used outside the VM too ----

/** First-cell day of the 6×7 month grid (Mon-first), which may dip into
 *  the previous month if the 1st isn't a Monday. */
internal fun monthGridStart(month: YearMonth): LocalDate {
    val first = month.atDay(1)
    return first.with(TemporalAdjusters.previousOrSame(java.time.DayOfWeek.MONDAY))
}

internal fun monthGridDays(month: YearMonth): List<LocalDate> {
    val start = monthGridStart(month)
    return (0L until 42L).map { start.plusDays(it) }
}
