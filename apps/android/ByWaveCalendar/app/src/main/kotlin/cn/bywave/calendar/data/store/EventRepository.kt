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

    /**
     * 把「提醒 / 镜像到系统日历」这两个开关的当前状态**立刻**落到系统上。
     *
     * 之前这两件事只在 fetchAndCache() 里做，也就是只有联网同步成功那一刻
     * 才会重新排期。三个后果，都是用户能直接撞上的：
     *
     *   1. 把提醒提前量从 15 分钟改成 1 小时，已经排好的闹钟还是 15 分钟。
     *      下一次同步碰巧发生之前，改了等于没改，而界面上那一行显示的
     *      是新值——用户以为生效了。
     *   2. 把「事件提醒」开关关掉，只是不再排新的；已经进了 AlarmManager
     *      的最多 64 个照响不误。用户关了开关还一直被打扰，而且没有任何
     *      办法撤销（这正是当初退出登录那条路上踩过的同一个坑）。
     *   3. 把「镜像到系统日历」关掉，系统日历里那份 ByWave 日程永久留着。
     *
     * 取消提醒必须能重建出当初的 PendingIntent，所以要先从 Room 把事件
     * 读出来再操作。两个动作各自 runCatching：镜像失败不该让提醒也不生效。
     */
    suspend fun applySyncPreferences() {
        val profile = profiles.active() ?: return
        val events = runCatching { db.eventDao().listForProfile(profile.id).map { it.toDto(json) } }
            .getOrElse { return }
        val current = prefs.current()

        if (current.remindersEnabled) {
            runCatching { reminders.reschedule(profile, events, current.reminderLeadMinutes) }
        } else {
            runCatching { reminders.cancelAll(profile, events) }
        }

        if (current.mirrorToSystemCalendar) {
            val calendars = runCatching { db.calendarDao().listForProfile(profile.id).map { it.toDto() } }
                .getOrElse { emptyList() }
            runCatching { mirror.mirror(profile, calendars, events) }
        } else {
            runCatching { mirror.unmirror(profile) }
        }
    }

    /** Wipe just one profile's cache (used when removing that account). */
    suspend fun wipeProfile(profileId: String) {
        AppDatabase.wipeProfile(context, profileId)
    }

    /**
     * 退出登录 / 设备被吊销时的完整清理。
     *
     * 只清 Room 是不够的：提醒是排进系统 AlarmManager 的，系统日历里的镜像
     * 是写进 CalendarProvider 的，两者都活在 App 之外。以前 cancelAll() 和
     * unmirror() 定义了却**全仓没有任何调用点**——后果是账号退出之后，
     * 已排期的提醒会按旧数据继续响（包括早就改期或删掉的会议），
     * 用户在设置里关掉提醒开关也撤销不了；系统日历里那份 ByWave 日程
     * 同样永久残留，而 App 里已经查无此账号。
     *
     * 取消提醒需要能重建出当初的 PendingIntent，所以必须在清 Room **之前**
     * 把事件读出来。
     */
    suspend fun wipeProfileFully(profile: cn.bywave.calendar.data.auth.Profile) {
        val events = runCatching { db.eventDao().listForProfile(profile.id).map { it.toDto(json) } }
            .getOrElse { emptyList() }
        runCatching { reminders.cancelAll(profile, events) }
        runCatching { mirror.unmirror(profile) }
        AppDatabase.wipeProfile(context, profile.id)
    }

    /** Wipe everything (used by "sign out all"). */
    suspend fun wipeAll() {
        AppDatabase.wipeAll(context)
    }
}
