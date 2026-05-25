// SyncPreferences — DataStore-backed user toggles for the optional
// "ambient" sync features added in v0.6:
//
//   - mirrorToSystemCalendar: write our events into a sub-calendar
//     in the Android system "Calendar" provider so the user sees
//     them in their stock Calendar / clock app / Google Calendar /
//     etc. without opening this APP.
//
//   - enableReminders: schedule local notifications via AlarmManager
//     `leadTimeMinutes` ahead of each timed event's start.
//
// Both default to OFF — opting in requires the relevant runtime
// permission (READ_CALENDAR + WRITE_CALENDAR / POST_NOTIFICATIONS) so
// surfacing them as toggles in Settings is the right place to gate
// the system prompt.

package cn.bywave.calendar.data.store

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.syncDataStore by preferencesDataStore(name = "bwc-sync-prefs")

object SyncPrefsKeys {
    val MIRROR_TO_SYSTEM = booleanPreferencesKey("mirror_to_system_calendar")
    val REMINDERS_ENABLED = booleanPreferencesKey("reminders_enabled")
    val REMINDER_LEAD_MIN = intPreferencesKey("reminder_lead_minutes")
}

data class SyncPrefs(
    val mirrorToSystemCalendar: Boolean = false,
    val remindersEnabled: Boolean = false,
    /** Minutes before event start to fire the local notification.
     *  iOS uses 15 by default; matching that. */
    val reminderLeadMinutes: Int = 15,
)

class SyncPreferences(private val context: Context) {
    val flow: Flow<SyncPrefs> = context.syncDataStore.data.map { p -> p.toModel() }

    suspend fun current(): SyncPrefs = context.syncDataStore.data.first().toModel()

    suspend fun setMirrorToSystem(enabled: Boolean) {
        context.syncDataStore.edit { it[SyncPrefsKeys.MIRROR_TO_SYSTEM] = enabled }
    }

    suspend fun setRemindersEnabled(enabled: Boolean) {
        context.syncDataStore.edit { it[SyncPrefsKeys.REMINDERS_ENABLED] = enabled }
    }

    suspend fun setReminderLeadMinutes(minutes: Int) {
        context.syncDataStore.edit { it[SyncPrefsKeys.REMINDER_LEAD_MIN] = minutes }
    }

    private fun Preferences.toModel(): SyncPrefs = SyncPrefs(
        mirrorToSystemCalendar = this[SyncPrefsKeys.MIRROR_TO_SYSTEM] ?: false,
        remindersEnabled = this[SyncPrefsKeys.REMINDERS_ENABLED] ?: false,
        reminderLeadMinutes = this[SyncPrefsKeys.REMINDER_LEAD_MIN] ?: 15,
    )
}
