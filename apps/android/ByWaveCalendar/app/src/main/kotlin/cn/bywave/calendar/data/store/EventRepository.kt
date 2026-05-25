// EventRepository — the bridge between the network (ApiClient) and the
// local cache (Room). ViewModels consume this; they never talk to
// Retrofit or Room directly.
//
// Strategy: cache + network, both as Flows. UI observes Room; network
// fetch writes into Room which auto-propagates. Cold launch instantly
// shows cached events while the network fetch runs in the background.

package cn.bywave.calendar.data.store

import android.content.Context
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.auth.TokenStore
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

class EventRepository(
    private val context: Context,
    private val tokens: TokenStore,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val db = AppDatabase.get(context)

    data class CacheSnapshot(
        val events: List<EventDTO>,
        val calendars: List<CalendarMeta>,
    )

    fun observe(): Flow<CacheSnapshot> = combine(
        db.eventDao().observeAll(),
        db.calendarDao().observeAll(),
    ) { eventRows, calendarRows ->
        CacheSnapshot(
            events = eventRows.map { it.toDto(json) },
            calendars = calendarRows.map { it.toDto() },
        )
    }

    /**
     * Fetch a window from the server and replace the local cache.
     * Returns true on success. Errors bubble to the caller so the
     * ViewModel can surface a banner without blocking the cached UI.
     */
    suspend fun fetchAndCache(fromIso: String, toIso: String) {
        val server = tokens.serverUrl ?: error("not signed in")
        val client = ApiClient.forServer(server, tokens)
        val resp = client.api.events(from = fromIso, to = toIso)

        // Clear-and-insert is fine because our query is the entire
        // window we care about. Incremental merge would be safer if
        // we ever support partial-window fetches (we don't yet).
        db.eventDao().replaceAll(resp.events.map { EventEntity.from(it, json) })
        db.calendarDao().replaceAll(resp.calendars.map { CalendarEntity.from(it) })
    }

    suspend fun wipe() {
        AppDatabase.wipe(context)
    }
}
