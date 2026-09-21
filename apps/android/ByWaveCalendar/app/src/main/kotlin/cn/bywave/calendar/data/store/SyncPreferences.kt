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
// mirrorToSystemCalendar 默认关：它会往用户的系统日历里写东西，那是别人
// 的地盘，必须本人点头。
//
// enableReminders 默认**开**。以前是关的，而桌面端是开的 —— 同一个账号，
// 最该响的那一端反而默认不响，而「日历不提醒我」正是用户最先抱怨的一件事。
// 两个后果要讲清楚：
//   - Android 13+：POST_NOTIFICATIONS 没授权之前什么都不会发生
//     （Reminders.isAvailable() 直接返回 false），设置页会显示一行
//     「还没允许发通知」引导去授权，不会出现「开关开着但静悄悄」。
//   - Android 12 及以下：通知默认就是允许的，所以**升级上来的老用户会
//     突然开始收到提醒**（默认提前 15 分钟，只针对非全天事件）。
//     这是有意的，发版说明里要写；一键就能关。

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

/** 提醒的默认值。和桌面端对齐；两处默认值只有一个来源，省得再走歪。 */
const val REMINDERS_DEFAULT: Boolean = true

data class SyncPrefs(
    val mirrorToSystemCalendar: Boolean = false,
    val remindersEnabled: Boolean = REMINDERS_DEFAULT,
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
        remindersEnabled = this[SyncPrefsKeys.REMINDERS_ENABLED] ?: REMINDERS_DEFAULT,
        reminderLeadMinutes = this[SyncPrefsKeys.REMINDER_LEAD_MIN] ?: 15,
    )
}
