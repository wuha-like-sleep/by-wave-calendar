// Owns the events list + selected day. v0.1 keeps it simple: fetch the
// current day's events from the server every time the day changes or
// the user pulls to refresh. v0.2 will add Room cache + 15-month wide
// window (mirror of iOS CalendarView's v1.2.1 fix).

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
import java.time.ZoneId
import java.time.format.DateTimeFormatter

data class CalendarUiState(
    val anchor: LocalDate = LocalDate.now(),
    val loading: Boolean = false,
    val events: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
    val errorMessage: String? = null,
    val lastSyncedAt: Instant? = null,
)

class CalendarViewModel : ViewModel() {
    private val tokens = BywaveApp.instance.tokenStore
    private val _state = MutableStateFlow(CalendarUiState())
    val state: StateFlow<CalendarUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        val server = tokens.serverUrl ?: run {
            _state.update { it.copy(errorMessage = "未登录") }
            return
        }
        _state.update { it.copy(loading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val client = ApiClient.forServer(server, tokens)
                val anchor = _state.value.anchor
                // Fetch a 3-day window centered on anchor to cover
                // multi-day events that bleed into "today" from the
                // edges. v0.2 will widen this to 15 months.
                val zone = ZoneId.systemDefault()
                val from = anchor.minusDays(1).atStartOfDay(zone).toInstant()
                val to = anchor.plusDays(2).atStartOfDay(zone).toInstant().minusNanos(1)
                val fromIso = ISO_WITH_OFFSET.format(from.atZone(zone))
                val toIso = ISO_WITH_OFFSET.format(to.atZone(zone))

                val resp = client.api.events(from = fromIso, to = toIso)
                _state.update {
                    it.copy(
                        loading = false,
                        events = resp.events,
                        calendars = resp.calendars,
                        lastSyncedAt = Instant.now(),
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

    fun shiftAnchor(daysOffset: Long) {
        _state.update { it.copy(anchor = it.anchor.plusDays(daysOffset)) }
        load()
    }

    fun goToday() {
        _state.update { it.copy(anchor = LocalDate.now()) }
        load()
    }

    /** Events that touch the currently-anchored day. Same filter shape
     *  iOS DayView uses: startsAt < endOfDay && endsAt > startOfDay. */
    fun eventsForAnchor(): List<EventDTO> {
        val zone = ZoneId.systemDefault()
        val day = _state.value.anchor
        val startOfDay = day.atStartOfDay(zone).toInstant()
        val endOfDay = day.plusDays(1).atStartOfDay(zone).toInstant()
        return _state.value.events.filter { e ->
            val s = runCatching { Instant.parse(e.startsAt) }.getOrNull() ?: return@filter false
            val ed = runCatching { Instant.parse(e.endsAt) }.getOrNull() ?: return@filter false
            s.isBefore(endOfDay) && ed.isAfter(startOfDay)
        }.sortedBy { it.startsAt }
    }

    private companion object {
        // "2026-05-24T00:00:00+08:00" — matches what the server's
        // datetime({ offset: true }) Zod validator accepts.
        val ISO_WITH_OFFSET: DateTimeFormatter = DateTimeFormatter.ISO_OFFSET_DATE_TIME
    }
}
