// EventRepository — bridge between the network (ApiClient) and the
// local cache (Room). v0.5: scopes all observation and writes by the
// active Profile so switching accounts surfaces a different cache
// without contaminating either.

package cn.bywave.calendar.data.store

import android.content.Context
import androidx.room.withTransaction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.auth.ProfileStore
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.EventsSyncResponse
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import cn.bywave.calendar.sync.ConfirmedEventDeletion
import cn.bywave.calendar.sync.PendingOpKind
import cn.bywave.calendar.sync.SnapshotMutationGate
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

    /** /events 窗口的 ETag 存档，按 (服务器, 账号, 窗口) 分键。服务端
     *  的令牌由「可见日历集合 + 窗口 + 内容版本」算出，键里少了哪一维
     *  都可能拿着别的窗口的令牌去问、换回一个假的 304。令牌只是上次
     *  服务端发的那一个字符串：本地或服务端任何一处改过数据，服务端
     *  的令牌都会变，下一次条件请求自然拿回 200，不存在「拿着旧令牌
     *  永远看不到新数据」的风险。 */
    private val etagPrefs by lazy {
        context.getSharedPreferences("bwc-events-etag", Context.MODE_PRIVATE)
    }

    private fun etagKey(profile: Profile, fromIso: String, toIso: String) =
        "${profile.serverUrl}|${profile.id}|$fromIso|$toIso"

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
            val profile = profiles.profiles.value.firstOrNull { it.id == activeId }
            val pendingFlow = if (profile != null) {
                offline.observeFor(profile)
            } else {
                flowOf(emptyList())
            }
            combine(
                db.eventDao().observeForProfile(activeId),
                db.calendarDao().observeForProfile(activeId),
                pendingFlow,
            ) { eventRows, calendarRows, pendingOps ->
                // 有未同步条目的事件打上 pendingSync，界面据此显示
                // 「待同步」——本地行已经是改后的样子，但不能让用户
                // 以为它已经到了服务端。
                val pendingIds = pendingOps.map { it.eventId }.toSet()
                CacheSnapshot(
                    events = eventRows.map { row ->
                        val dto = row.toDto(json)
                        if (dto.id in pendingIds) dto.copy(pendingSync = true) else dto
                    },
                    calendars = calendarRows.map { it.toDto() },
                )
            }
        }
    }

    /**
     * Server-side full-history search for the active profile. The local
     * cache only covers a ~15-month window; anything older lives only on
     * the server. Errors bubble (network failures included) so the
     * caller can fall back to local-only results and say so.
     */
    suspend fun searchServer(query: String, limit: Int = 100): cn.bywave.calendar.data.model.SearchResponse {
        val profile = profiles.active() ?: error("not signed in")
        val client = ApiClient.forProfile(profile, profiles)
        return client.api.search(query, limit)
    }

    /** 本机 Room 缓存里已有的全部地点（地址簿播种材料）。缓存窗口
     *  之外的老事件不在里面——播种只是起点，之后靠保存慢慢攒。 */
    suspend fun cachedLocations(profile: Profile): List<String> =
        db.eventDao().listForProfile(profile.id).mapNotNull { it.location }

    /** 地点联想在线兜底。任何失败都吞成空列表：在线建议拿不到就
     *  当没有，绝不把本地建议也拖下水。 */
    suspend fun geoSuggest(
        profile: Profile,
        query: String,
        lang: String?,
    ): List<cn.bywave.calendar.data.model.GeoSuggestion> =
        runCatching {
            val client = ApiClient.forProfile(profile, profiles)
            client.api.geoSuggest(query, lang).suggestions
        }.getOrDefault(emptyList())

    /** Preview an ICS import for the active profile — the server runs
     *  the same dedupe judgement as the real import but writes
     *  nothing, so the user sees the counts before committing. */
    suspend fun previewImport(
        calendarId: String,
        text: String,
        filename: String?,
    ): cn.bywave.calendar.data.model.IcsImportPreview {
        val profile = profiles.active() ?: error("not signed in")
        val client = ApiClient.forProfile(profile, profiles)
        return client.api.importPreview(calendarId, cn.bywave.calendar.data.model.IcsImportRequest(text, filename))
    }

    /** Import ICS text into one of the active profile's calendars. */
    suspend fun importIcs(
        calendarId: String,
        text: String,
        filename: String?,
    ): cn.bywave.calendar.data.model.IcsImportResult {
        val profile = profiles.active() ?: error("not signed in")
        val client = ApiClient.forProfile(profile, profiles)
        return client.api.importIcs(calendarId, cn.bywave.calendar.data.model.IcsImportRequest(text, filename))
    }

    /** /events/sync 的同步存档（令牌 + 窗口基线），按 (服务器, 账号)
     *  分键，与 ETag 存档同一套键法。令牌只对它签发时那个窗口的本地
     *  镜像有效：窗口对不上就当没有令牌、走全量重建基线（与 Web
     *  syncPlan 的基线语义一致）。 */
    private val syncPrefs by lazy {
        context.getSharedPreferences("bwc-events-sync", Context.MODE_PRIVATE)
    }

    private fun syncKey(profile: Profile) = "${profile.serverUrl}|${profile.id}"

    /** 取这个窗口基线的令牌：基线对不上（窗口变了）返回 null。 */
    private fun storedSyncToken(profile: Profile, window: String): String? {
        val key = syncKey(profile)
        if (syncPrefs.getString("$key|window", null) != window) return null
        return syncPrefs.getString(key, null)
    }

    private fun saveSyncState(profile: Profile, token: String, window: String) {
        val key = syncKey(profile)
        syncPrefs.edit().putString(key, token).putString("$key|window", window).apply()
    }

    private fun clearSyncState(profile: Profile) {
        val key = syncKey(profile)
        syncPrefs.edit().remove(key).remove("$key|window").apply()
    }

    /** 清掉某个账号在同步存档里的全部条目（键里带 profile id，扫
     *  一遍精确匹配）。profile id 每次配对都会换，残留条目本来就
     *  读不到；清掉是顺手把关，免得存档无限攒。 */
    private fun clearSyncStateFor(profileId: String) {
        val editor = syncPrefs.edit()
        syncPrefs.all.keys.filter { it.contains("|$profileId") }.forEach { editor.remove(it) }
        editor.apply()
    }

    /** 一次窗口拉取的结局：内容没变（旧路径的 304）、全量底稿、
     *  或一份增量响应（套到本地镜像的活在快照闸门里干）。Full 的
     *  nextSyncToken 是「待存档」的新令牌——只在快照真正落进 Room
     *  之后才存（见 fetchAndCache）；旧 ETag 路径来的 Full 没有
     *  令牌（null）。 */
    private sealed interface WindowFetch {
        object NotModified : WindowFetch
        data class Full(
            val calendars: List<CalendarMeta>,
            val serverEvents: List<EventDTO>,
            val nextSyncToken: String?,
        ) : WindowFetch
        data class Delta(
            val calendars: List<CalendarMeta>,
            val delta: EventsSyncResponse,
        ) : WindowFetch
    }

    /**
     * Fetch a window from the server and replace the active profile's
     * cache. Errors bubble so the ViewModel can surface a banner
     * without blocking the existing cached UI.
     */
    private val fetchMutex = Mutex()
    private val snapshotGate = SnapshotMutationGate()

    /** 离线写队列引擎。建 / 改 / 删先经它落本地再重放，窗口拉取
     *  时也由它把未同步条目合并回展示集。 */
    val offline: OfflineQueue = OfflineQueue(db, profiles, snapshotGate, json)

    suspend fun fetchAndCache(fromIso: String, toIso: String): Unit = fetchMutex.withLock {
        val profile = profiles.active() ?: error("not signed in")
        val revision = snapshotGate.capture()
        val client = ApiClient.forProfile(profile, profiles)
        // 拉取通道的分流全在 fetchWindow 里（增量同步优先、旧 ETag
        // 全量兜底）；这里只认结局。NotModified（304）= 窗口没变，
        // Room、提醒、镜像全都原样不动，和以前一样。
        val fetched = fetchWindow(client, profile, fromIso, toIso)
        if (fetched is WindowFetch.NotModified) return@withLock
        val calendars = when (fetched) {
            is WindowFetch.Full -> fetched.calendars
            is WindowFetch.Delta -> fetched.calendars
            WindowFetch.NotModified -> error("unreachable")
        }
        snapshotGate.applySnapshot(revision, relevant = { profiles.active()?.id == profile.id }) {
            currentCoroutineContext().ensureActive()
            // 未同步条目合并：服务端窗口是权威底稿，但本地还没送出去的
            // 改动不能被这次替换冲掉（新建会消失、改的会弹回、删的会
            // 复活）。合并规则在 OfflineQueue.mergeServerEvents。
            val pendingOps = offline.pendingFor(profile)
            val previousFull = db.eventDao().listForProfile(profile.id).map { it.toDto(json) }
            val mergedEvents = when (fetched) {
                is WindowFetch.Full -> offline.mergeServerEvents(fetched.serverEvents, pendingOps, previousFull)
                is WindowFetch.Delta -> {
                    // 增量先套到本地镜像（上一份合并集）上，再过一遍
                    // 队列合并：变更母事件整组替换、删的删、名单外
                    // 日历剪掉；队列里还没落定的母事件整组跳过，
                    // 本地新建行由 mergeServerEvents 从 previousFull
                    // 接回。计划函数是纯逻辑，见 EventSyncPlan。
                    val protectedIds = pendingOps.map { it.eventId }.toSet()
                    val createIds = pendingOps
                        .filter { it.kind == PendingOpKind.CREATE }
                        .map { it.eventId }.toSet()
                    val mirrorRows = EventSyncPlan.applyDelta(
                        previousLocal = previousFull,
                        upsertedIds = fetched.delta.upsertedIds?.toSet() ?: emptySet(),
                        deletedIds = fetched.delta.deletedIds?.toSet() ?: emptySet(),
                        incoming = fetched.delta.events,
                        visibleCalendarIds = fetched.delta.calendars.map { it.id }.toSet(),
                        protectedIds = protectedIds,
                        localCreateIds = createIds,
                    )
                    offline.mergeServerEvents(mirrorRows, pendingOps, previousFull)
                }
                WindowFetch.NotModified -> error("unreachable")
            }
            val previousEvents = db.withTransaction {
                // Alarm identity needs no optional metadata. A corrupt old
                // extraJson must not prevent replacing the cache.
                val previous = db.eventDao().listForProfile(profile.id)
                    .map { it.copy(extraJson = null).toDto(json) }
                db.eventDao().replaceForProfile(
                    profile.id,
                    mergedEvents.map { EventEntity.from(it, profile.id, json) },
                )
                db.calendarDao().replaceForProfile(
                    profile.id,
                    calendars.map { CalendarEntity.from(it, profile.id) },
                )
                previous
            }
            // 镜像已经落进 Room，这时才存新令牌：令牌若先存下、快照
            // 却没落地（账号中途切换、闸门把这次应用跳过），令牌就
            // 越过了没被应用的那批变化，它们再也不会被增量带回来。
            when (fetched) {
                is WindowFetch.Full -> fetched.nextSyncToken?.let {
                    saveSyncState(profile, it, "$fromIso|$toIso")
                }
                is WindowFetch.Delta -> saveSyncState(profile, fetched.delta.nextSyncToken, "$fromIso|$toIso")
                WindowFetch.NotModified -> Unit
            }
            // Finish an already-started application under the gate. A delete
            // queued during this pass runs afterwards and removes its event
            // from BOTH the new cache and the freshly scheduled side effects.
            // Cancelling the old list also catches remotely deleted/moved
            // events which no longer exist in the replacement cache.
            runCatching { reminders.cancelAll(profile, previousEvents) }
            currentCoroutineContext().ensureActive()
            if (profiles.active()?.id != profile.id) return@applySnapshot
            val current = prefs.current()
            val selectedCalendars = if (current.mirrorToSystemCalendar) prefs.selectedCalendars(profile.id) else null
            currentCoroutineContext().ensureActive()
            if (profiles.active()?.id != profile.id) return@applySnapshot
            if (current.mirrorToSystemCalendar) {
                runCatching { mirror.mirror(profile, calendars, mergedEvents, selectedCalendars) }
            }
            if (current.remindersEnabled) {
                runCatching {
                    reminders.reschedule(profile, mergedEvents, current.reminderLeadMinutes, calendars)
                }
            }
        }
    }

    /** 窗口拉取的分流：先走 /events/sync（有基线令牌走增量、没有
     *  走全量），同步通道任何非 410 失败都清掉同步存档、回退到
     *  原来的 ETag 条件请求全量路径——同步挂掉不能把日历也拖挂。
     *  410 只出现在增量路径上（令牌解不开 / 已被服务端日志
     *  裁剪）：清存档后无令牌全量重建一次，重建再失败同样回退
     *  旧路径，不连环重试。 */
    private suspend fun fetchWindow(
        client: ApiClient,
        profile: Profile,
        fromIso: String,
        toIso: String,
    ): WindowFetch {
        val window = "$fromIso|$toIso"
        val token = storedSyncToken(profile, window)
        val outcome: WindowFetch? = try {
            if (token != null) {
                val resp = client.api.eventsSync(fromIso, toIso, token)
                when {
                    resp.code() == 410 -> {
                        clearSyncState(profile)
                        fullSyncWindow(client, profile, fromIso, toIso)
                    }
                    resp.isSuccessful -> {
                        val body = resp.body()
                        if (body == null) {
                            clearSyncState(profile)
                            null
                        } else {
                            WindowFetch.Delta(body.calendars, body)
                        }
                    }
                    else -> {
                        clearSyncState(profile)
                        null
                    }
                }
            } else {
                fullSyncWindow(client, profile, fromIso, toIso)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // 网络失败、解码失败都算同步通道失败：清存档、回退旧路径。
            clearSyncState(profile)
            null
        }
        if (outcome != null) return outcome
        // 回退：原来的 ETag 条件请求全量路径，一字不改。条件请求：
        // 这个窗口的内容没变时服务端只回 304 空响应，整个窗口
        // （15 个月）的正文、JSON 解析、Room 全量替换、提醒重排、
        // 系统日历镜像全部省掉。304 不是错误——信封拦截器对没有
        // JSON 正文的响应直接放行，Retrofit 也不会替我们抛异常，
        // 所以要在这里显式判状态码；非 304 的失败则手动抛回
        // HttpException，保持和以前「events() 直接抛」一样的报错面。
        val key = etagKey(profile, fromIso, toIso)
        val httpResp = client.api.events(
            from = fromIso, to = toIso,
            ifNoneMatch = etagPrefs.getString(key, null),
        )
        if (httpResp.code() == 304) return WindowFetch.NotModified
        if (!httpResp.isSuccessful) throw retrofit2.HttpException(httpResp)
        val resp = httpResp.body() ?: throw retrofit2.HttpException(httpResp)
        httpResp.headers()["ETag"]?.let { etagPrefs.edit().putString(key, it).apply() }
        return WindowFetch.Full(resp.calendars, resp.events, nextSyncToken = null)
    }

    /** 无令牌全量同步一次：成功返回带着新令牌的 Full（令牌由
     *  fetchAndCache 在快照落地后存档），失败返回 null 让调用方
     *  回退旧路径。无令牌请求服务端不会回 410。 */
    private suspend fun fullSyncWindow(
        client: ApiClient,
        profile: Profile,
        fromIso: String,
        toIso: String,
    ): WindowFetch.Full? {
        val resp = client.api.eventsSync(fromIso, toIso, null)
        if (!resp.isSuccessful) return null
        val body = resp.body() ?: return null
        return WindowFetch.Full(body.calendars, body.events, body.nextSyncToken)
    }

    /** Remove a server-confirmed delete immediately, including its reminders
     * and local system-calendar copy. A slow GET never owns this short gate;
     * an already-applying snapshot finishes first and cannot undo this removal. */
    suspend fun applyConfirmedDeletion(profile: Profile, deletion: ConfirmedEventDeletion) = snapshotGate.mutate {
        val removed = db.withTransaction {
            val rows = db.eventDao().listForProfile(profile.id)
                .filter { deletion.removes(it.id, it.startsAt) }
            if (rows.isNotEmpty()) db.eventDao().deleteRows(rows)
            rows.map { it.copy(extraJson = null).toDto(json) }
        }
        runCatching { reminders.cancelAll(profile, removed) }
        if (profiles.active()?.id != profile.id) return@mutate
        val current = prefs.current()
        if (current.mirrorToSystemCalendar) {
            val selected = prefs.selectedCalendars(profile.id)
            val events = db.eventDao().listForProfile(profile.id).map { it.toDto(json) }
            val calendars = db.calendarDao().listForProfile(profile.id).map { it.toDto() }
            currentCoroutineContext().ensureActive()
            if (profiles.active()?.id != profile.id) return@mutate
            runCatching { mirror.mirror(profile, calendars, events, selected) }
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
    suspend fun applySyncPreferences(throwOnCalendarError: Boolean = false) = snapshotGate.exclusively {
        val profile = profiles.active() ?: return@exclusively
        val events = runCatching { db.eventDao().listForProfile(profile.id).map { it.toDto(json) } }
            .getOrElse { return@exclusively }
        val current = prefs.current()

        if (current.remindersEnabled) {
            // Calendars ride along so all-day event-level alarms can
            // anchor in the calendar's timezone (extra.timezone wins
            // when the event carries one — see Reminders).
            val calendars = runCatching { db.calendarDao().listForProfile(profile.id).map { it.toDto() } }
                .getOrElse { emptyList() }
            runCatching { reminders.reschedule(profile, events, current.reminderLeadMinutes, calendars) }
        } else {
            runCatching { reminders.cancelAll(profile, events) }
        }

        if (current.mirrorToSystemCalendar) {
            val calendars = runCatching { db.calendarDao().listForProfile(profile.id).map { it.toDto() } }
                .getOrElse { emptyList() }
            val result = runCatching { mirror.mirror(profile, calendars, events, prefs.selectedCalendars(profile.id)) }
            if (throwOnCalendarError) result.getOrThrow()
        } else {
            val result = runCatching { mirror.unmirror(profile) }
            if (throwOnCalendarError) result.getOrThrow()
        }
    }

    /** Wipe just one profile's cache (used when removing that account). */
    suspend fun wipeProfile(profileId: String): Unit = snapshotGate.mutate {
        clearSyncStateFor(profileId)
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
    suspend fun wipeProfileFully(profile: cn.bywave.calendar.data.auth.Profile): Unit = snapshotGate.mutate {
        val events = runCatching { db.eventDao().listForProfile(profile.id).map { it.toDto(json) } }
            .getOrElse { emptyList() }
        runCatching { reminders.cancelAll(profile, events) }
        runCatching { mirror.unmirror(profile) }
        clearSyncStateFor(profile.id)
        AppDatabase.wipeProfile(context, profile.id)
    }

    /** Wipe everything (used by "sign out all"). */
    suspend fun wipeAll(): Unit = snapshotGate.mutate {
        AppDatabase.wipeAll(context)
    }
}
