// SearchViewModel — local-first search with a server fallback.
//
// Local: observes the active-profile cache via EventRepository and
// filters in memory (debounced 200ms). Instant and works offline, but
// the Room cache only holds a ~15-month window.
//
// Server fallback: when the local filter comes up empty for a query —
// or the user explicitly asks for all history — we call
// GET /api/v1/search (the same endpoint the web palette and iOS use)
// and show what it returns in a separate, clearly-labeled section.
// A failed call (no network, server error) keeps the local results
// and flags `offline` so the UI can say the results are local-only.

package cn.bywave.calendar.ui.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class SearchUiState(
    val query: String = "",
    /** Local cache hits. */
    val results: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
    /** Server hits (all history), with ids already shown locally removed. */
    val serverResults: List<EventDTO> = emptyList(),
    /** The server search for the current query is running. */
    val serverLoading: Boolean = false,
    /** The server search for the current query has finished (ok or not). */
    val serverDone: Boolean = false,
    /** The server could not be reached — results are local-only. */
    val offline: Boolean = false,
)

/** Server-search outcome for one specific query. Kept apart from the UI
 *  state so a late response for a stale query can be dropped by
 *  comparing `forQuery` against the current query. */
private data class ServerPart(
    val forQuery: String = "",
    val results: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
    val loading: Boolean = false,
    val done: Boolean = false,
    val offline: Boolean = false,
)

@OptIn(FlowPreview::class)
class SearchViewModel : ViewModel() {
    private val repository = BywaveApp.instance.repository

    private val _query = MutableStateFlow("")
    private val _server = MutableStateFlow(ServerPart())
    private var serverJob: Job? = null

    val state: StateFlow<SearchUiState> = combine(
        repository.observe(),
        _query.debounce(200),
        _server,
    ) { snap, q, server ->
        val trimmed = q.trim()
        val results = if (trimmed.isEmpty()) emptyList()
                      else snap.events.filter { match(it, trimmed) }
                                      .sortedByDescending { it.startsAt }
        // The server part only counts while it belongs to this query.
        val srv = if (server.forQuery == trimmed) server else ServerPart()
        val localIds = results.map { it.id }.toSet()
        val serverResults = if (trimmed.isEmpty()) emptyList()
                            else srv.results.filter { it.id !in localIds }
        // Server hits may belong to calendars the local snapshot does not
        // carry (never synced into the window) — merge their name/color in
        // so rows are not anonymous.
        val knownIds = snap.calendars.map { it.id }.toSet()
        val calendars = snap.calendars + srv.calendars.filter { it.id !in knownIds }
        SearchUiState(
            query = q,
            results = results,
            calendars = calendars,
            serverResults = serverResults,
            serverLoading = srv.loading,
            serverDone = srv.done,
            offline = srv.offline,
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = SearchUiState(),
    )

    init {
        // Auto-fallback: once a query settles and the local filter found
        // nothing, ask the server. The explicit "search all history"
        // action in the UI covers the other case (local hits exist, but
        // the user suspects older events outside the local window).
        viewModelScope.launch {
            _query.debounce(350).collect { raw ->
                val q = raw.trim()
                if (q.isEmpty()) {
                    _server.value = ServerPart()
                    return@collect
                }
                val current = state.value
                if (current.query.trim() == q && current.results.isEmpty()) {
                    runServerSearch(q)
                }
            }
        }
    }

    fun onQuery(v: String) {
        _query.value = v
    }

    /** User tapped "search all history" — ask the server even though
     *  the local filter produced results. */
    fun searchAllHistory() {
        val q = _query.value.trim()
        if (q.isNotEmpty()) runServerSearch(q)
    }

    private fun runServerSearch(q: String) {
        val cur = _server.value
        // Already running or already answered for this query — unless the
        // answer was "offline", in which case a manual tap is a retry.
        if (cur.forQuery == q && (cur.loading || (cur.done && !cur.offline))) return
        serverJob?.cancel()
        _server.value = ServerPart(forQuery = q, loading = true)
        serverJob = viewModelScope.launch {
            try {
                val resp = repository.searchServer(q)
                if (_query.value.trim() != q) return@launch // query moved on; drop it
                _server.value = ServerPart(
                    forQuery = q,
                    results = resp.events,
                    calendars = resp.calendars.map {
                        CalendarMeta(id = it.id, name = it.name, color = it.color ?: "#6366f1")
                    },
                    done = true,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (_query.value.trim() != q) return@launch
                // No network / server unreachable: keep local results and
                // let the UI say they are local-only.
                _server.value = ServerPart(forQuery = q, done = true, offline = true)
            }
        }
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
