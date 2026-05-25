// EventRepository — bridge between the network (ApiClient) and the
// local cache (Room). v0.5: scopes all observation and writes by the
// active Profile so switching accounts surfaces a different cache
// without contaminating either.

package cn.bywave.calendar.data.store

import android.content.Context
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.auth.ProfileStore
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.sync.Reminders
import cn.bywave.calendar.sync.SystemCalendarMirror
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.serialization.json.Json

class EventRepository(
    private val context: Context,
    private val profiles: ProfileStore,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val db = AppDatabase.get(context)
    private val mirror = SystemCalendarMirror(context)
    private val reminders = Reminders(context)
    private val prefs = SyncPreferences(context)

    data class CacheSnapshot(
        val events: List<EventDTO>,
        val calendars: List<CalendarMeta>,
    )

    /**
     * Observable cache for the currently active profile. Switches
     * automatically when the user picks a different profile via
     * ProfileStore.setActive(...) — Flow re-emits with the new
     * profile's events and calendars.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun observe(): Flow<CacheSnapshot> = profiles.activeId.flatMapLatest { activeId ->
        if (activeId == null) {
            flowOf(CacheSnapshot(emptyList(), emptyList()))
        } else {
            combine(
                db.eventDao().observeForProfile(activeId),
                db.calendarDao().observeForProfile(activeId),
            ) { eventRows, calendarRows ->
                CacheSnapshot(
                    events = eventRows.map { it.toDto(json) },
                    calendars = calendarRows.map { it.toDto() },
                )
            }
        }
    }

    /**
     * Fetch a window from the server and replace the active profile's
     * cache. Errors bubble so the ViewModel can surface a banner
     * without blocking the existing cached UI.
     */
    suspend fun fetchAndCache(fromIso: String, toIso: String) {
        val profile = profiles.active() ?: error("not signed in")
        val client = ApiClient.forProfile(profile, profiles)
        val resp = client.api.events(from = fromIso, to = toIso)
        db.eventDao().replaceForProfile(
            profile.id,
            resp.events.map { EventEntity.from(it, profile.id, json) },
        )
        db.calendarDao().replaceForProfile(
            profile.id,
            resp.calendars.map { CalendarEntity.from(it, profile.id) },
        )

        // Ambient sync (v0.6) — opt-in via Settings. Each is gated on
        // its own runtime permission inside the helper, so calling
        // them unconditionally is safe (no-ops when off / unpermitted).
        val current = prefs.current()
        if (current.mirrorToSystemCalendar) {
            runCatching { mirror.mirror(profile, resp.calendars, resp.events) }
        }
        if (current.remindersEnabled) {
            runCatching { reminders.reschedule(profile, resp.events, current.reminderLeadMinutes) }
        }
    }

    /** Wipe just one profile's cache (used when removing that account). */
    suspend fun wipeProfile(profileId: String) {
        AppDatabase.wipeProfile(context, profileId)
    }

    /** Wipe everything (used by "sign out all"). */
    suspend fun wipeAll() {
        AppDatabase.wipeAll(context)
    }
}
