// SearchViewModel — observes the active-profile cache via
// EventRepository and exposes a filtered slice keyed off the user's
// query. Filter is debounced 200ms so typing fast doesn't thrash
// recomposition on long lists.

package cn.bywave.calendar.ui.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update

data class SearchUiState(
    val query: String = "",
    val results: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
)

@OptIn(FlowPreview::class)
class SearchViewModel : ViewModel() {
    private val repository = BywaveApp.instance.repository

    private val _query = MutableStateFlow("")

    /** Combine the repository's reactive cache with the debounced
     *  query, emit a filtered result list. */
    val state: StateFlow<SearchUiState> = combine(
        repository.observe(),
        _query.debounce(200),
    ) { snap, q ->
        val trimmed = q.trim()
        val results = if (trimmed.isEmpty()) emptyList()
                      else snap.events.filter { match(it, trimmed) }
                                      .sortedByDescending { it.startsAt }
        SearchUiState(query = q, results = results, calendars = snap.calendars)
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = SearchUiState(),
    )

    fun onQuery(v: String) {
        _query.value = v
    }

    /** Case-insensitive substring match across summary / description /
     *  location. Doesn't search the link or attendees yet — those
     *  are less commonly searched and add false positives.  */
    private fun match(ev: EventDTO, needle: String): Boolean {
        val nLower = needle.lowercase()
        return ev.summary.contains(nLower, ignoreCase = true) ||
            (ev.description ?: "").contains(nLower, ignoreCase = true) ||
            (ev.location ?: "").contains(nLower, ignoreCase = true)
    }
}
