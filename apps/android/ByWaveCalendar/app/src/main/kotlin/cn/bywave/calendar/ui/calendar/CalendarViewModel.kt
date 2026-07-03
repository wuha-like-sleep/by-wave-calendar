// v0.4 refactor: read state from EventRepository (Room-backed) instead
// of holding events in the VM directly. Cold launch hits the cache
// immediately and the UI paints; the network fetch happens in the
// background and writes into Room, which republishes via Flow.

package cn.bywave.calendar.ui.calendar

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
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
    /** Set right after a NON-recurring delete succeeds → drives the "已删除 ·
     *  撤销" snackbar. One-shot: cleared when the snackbar is acted on/dismissed. */
    val undoDeleteId: String? = null,
    val lastSyncedAt: Instant? = null,
    val fetchedFrom: LocalDate? = null,
    val fetchedTo: LocalDate? = null,
)

class CalendarViewModel : ViewModel() {
    private val profiles = BywaveApp.instance.profiles
    private val repository = BywaveApp.instance.repository

    private val _state = MutableStateFlow(CalendarUiState())
    val state: StateFlow<CalendarUiState> = _state.asStateFlow()

    init {
        // Observe Room — cold start sees cache instantly, later
        // network fetches update Room which updates state via this flow.
        // The flow auto-switches when ProfileStore.activeId changes,
        // so account-switching surfaces the right cache without
        // recreating the VM.
        repository.observe()
            .onEach { snap ->
                _state.update { it.copy(events = snap.events, calendars = snap.calendars) }
            }
            .launchIn(viewModelScope)

        // Re-fetch when the active profile changes so the new account's
        // events get pulled from the network too.
        profiles.activeId
            .onEach { id ->
                if (id != null) load()
            }
            .launchIn(viewModelScope)
    }

    fun setMode(mode: ViewMode) {
        _state.update { it.copy(mode = mode) }
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

    fun reload() = load()

    /** Delete an event by id. For non-recurring events the extra args
     *  stay null. For recurring events the caller MUST pop the
     *  RecurringScopePicker first and pass through the picked scope +
     *  the occurrence's startsAt as recurrenceId — server defaults a
     *  missing scope to "series", which would silently nuke the whole
     *  recurring set. (Was the v0.8.2 silent-data-loss bug.) */
    fun deleteEvent(id: String, scope: String? = null, recurrenceId: String? = null) {
        viewModelScope.launch {
            try {
                val profile = profiles.active() ?: return@launch
                val client = ApiClient.forProfile(profile, profiles)
                client.api.deleteEvent(id, scope, recurrenceId)
                // Offer undo only for plain (non-recurring) deletes; restoring a
                // scoped recurring delete (EXDATE / split) by id wouldn't cleanly
                // reverse it, so we don't tempt the user with a broken undo.
                if (scope == null) _state.update { it.copy(undoDeleteId = id) }
                load()
            } catch (e: Exception) {
                _state.update { it.copy(errorMessage = e.localizedMessage ?: "删除失败") }
            }
        }
    }

    /** Undo the last non-recurring delete via the restore endpoint. */
    fun restoreLastDelete() {
        val id = _state.value.undoDeleteId ?: return
        _state.update { it.copy(undoDeleteId = null) }
        viewModelScope.launch {
            try {
                val profile = profiles.active() ?: return@launch
                val client = ApiClient.forProfile(profile, profiles)
                client.api.restoreEvent(id)
                load()
            } catch (e: Exception) {
                _state.update { it.copy(errorMessage = e.localizedMessage ?: "撤销失败") }
            }
        }
    }

    fun clearUndo() = _state.update { it.copy(undoDeleteId = null) }

    /** Sign out the currently active profile only. If there are
     *  other profiles, ProfileStore picks the next-most-recent as the
     *  new active; if this was the last one, activeId becomes null. */
    fun signOutActive() {
        viewModelScope.launch {
            try {
                val active = profiles.active() ?: return@launch
                // Best-effort cache wipe — a Room hiccup here must NOT crash the
                // app (unguarded, this launch had no handler) nor leave the user
                // stuck signed in, so swallow it and still invalidate + remove.
                runCatching { repository.wipeProfile(active.id) }
                    .onFailure { Log.w("SignOut", "wipeProfile failed: ${it.message}") }
                ApiClient.invalidate(active.id)
                profiles.remove(active.id)
            } catch (e: Exception) {
                _state.update { it.copy(errorMessage = e.localizedMessage ?: "退出登录失败") }
            }
        }
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
        if (profiles.active() == null) {
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

                repository.fetchAndCache(
                    fromIso = ISO.format(fromInstant.atZone(zone)),
                    toIso = ISO.format(toInstant.atZone(zone)),
                )

                _state.update {
                    it.copy(
                        loading = false,
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
        val marginDays = 14L
        return date.isBefore(from.plusDays(marginDays)) || date.isAfter(to.minusDays(marginDays))
    }

    private companion object {
        const val WINDOW_MONTHS_BACK = 2L
        const val WINDOW_MONTHS_FORWARD = 13L
        val ISO: DateTimeFormatter = DateTimeFormatter.ISO_OFFSET_DATE_TIME
    }
}

// ---- Month grid helpers ----

internal fun monthGridStart(month: YearMonth): LocalDate {
    val first = month.atDay(1)
    return first.with(TemporalAdjusters.previousOrSame(java.time.DayOfWeek.MONDAY))
}

internal fun monthGridDays(month: YearMonth): List<LocalDate> {
    val start = monthGridStart(month)
    return (0L until 42L).map { start.plusDays(it) }
}
