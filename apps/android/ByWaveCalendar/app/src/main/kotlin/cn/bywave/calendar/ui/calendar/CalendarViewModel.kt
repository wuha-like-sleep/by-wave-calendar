// v0.4 refactor: read state from EventRepository (Room-backed) instead
// of holding events in the VM directly. Cold launch hits the cache
// immediately and the UI paints; the network fetch happens in the
// background and writes into Room, which republishes via Flow.

package cn.bywave.calendar.ui.calendar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.sync.ConfirmedEventDeletion
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
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
    /** One-shot request to open an event's detail sheet, issued from
     *  outside CalendarScreen (search result tap, quick-add "已创建"
     *  feedback). CalendarScreen consumes it into its selectedEvent
     *  state and calls [CalendarViewModel.clearDetailRequest]. */
    val detailRequest: EventDTO? = null,
    /** Set right after a quick-add direct save succeeds → drives the
     *  "已创建 · 撤销" snackbar on CalendarScreen. One-shot. */
    val createdNotice: EventDTO? = null,
    /** 未处理邀请数（待回复、事件未取消、未过期）→ 顶栏邀请按钮的徽章。
     *  刷新失败静默保持旧值：徽章只是提示，不值得为它报错。 */
    val pendingInvitations: Int = 0,
    val lastSyncedAt: Instant? = null,
    val fetchedFrom: LocalDate? = null,
    val fetchedTo: LocalDate? = null,
)

class CalendarViewModel : ViewModel() {
    private val profiles = BywaveApp.instance.profiles
    private val repository = BywaveApp.instance.repository
    // Application 单例兼作取本地化文案的 Context——这个 VM 继承的是普通
    // ViewModel，没有 getApplication()。和 EventEditViewModel 同一套做法。
    private val app = BywaveApp.instance
    private var undoProfileId: String? = null
    private val deletionsInFlight = mutableSetOf<Pair<String, ConfirmedEventDeletion>>()

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
                loadJob?.cancel()
                undoProfileId = null
                _state.update { it.copy(undoDeleteId = null, detailRequest = null, createdNotice = null,
                    errorMessage = null, loading = false, pendingInvitations = 0,
                    fetchedFrom = null, fetchedTo = null, lastSyncedAt = null) }
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

    /** Ask CalendarScreen to open [event]'s detail sheet. Used by the
     *  search screen (result tap opens the event, not just its day) and
     *  by the quick-add created-notice's "打开" affordance. */
    fun requestDetail(event: EventDTO) {
        _state.update { it.copy(detailRequest = event) }
    }

    fun clearDetailRequest() {
        _state.update { it.copy(detailRequest = null) }
    }

    /** Show the "已创建" snackbar for a quick-add direct save, and move
     *  the calendar onto the event's day so the created event is right
     *  there once the snackbar is gone. */
    fun showCreatedNotice(event: EventDTO) {
        val day = runCatching {
            Instant.parse(event.startsAt).atZone(ZoneId.systemDefault()).toLocalDate()
        }.getOrNull()
        _state.update { it.copy(createdNotice = event) }
        if (day != null) {
            setMode(ViewMode.Day)
            setAnchor(day)
        }
    }

    fun clearCreatedNotice() {
        _state.update { it.copy(createdNotice = null) }
    }

    /** Delete an event by id. For non-recurring events the extra args
     *  stay null. For recurring events the caller MUST pop the
     *  RecurringScopePicker first and pass through the picked scope +
     *  the occurrence's startsAt as recurrenceId — server defaults a
     *  missing scope to "series", which would silently nuke the whole
     *  recurring set. (Was the v0.8.2 silent-data-loss bug.) */
    /** 当前账号的离线队列全部条目（含待处理）。日历页的待同步指示
     *  和队列页都读它。 */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    val pendingOps: StateFlow<List<cn.bywave.calendar.sync.PendingOp>> =
        profiles.activeId.flatMapLatest { activeId ->
            val profile = profiles.profiles.value.firstOrNull { it.id == activeId }
            if (profile == null) flowOf(emptyList())
            else repository.offline.observeFor(profile)
        }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun deleteEvent(id: String, scope: String? = null, recurrenceId: String? = null) {
        val profile = profiles.active() ?: return
        val deletion = ConfirmedEventDeletion(id, scope, recurrenceId)
        val operation = profile.id to deletion
        if (!deletionsInFlight.add(operation)) return
        _state.update { it.copy(errorMessage = null) }
        viewModelScope.launch {
            try {
                // 走离线队列：本地行立刻删掉、条目入队，有网当场重放
                // 掉，没网等恢复。以前这里直连 API，断网删事件只会
                // 弹一个报错、事件还留在原地——用户以为删了其实没删，
                // 或者反过来根本删不动。
                repository.offline.submitDelete(profile, id, scope, recurrenceId)
                if (profiles.activeId.value != profile.id) return@launch
                undoProfileId = profile.id
                // Offer undo only for plain (non-recurring) deletes; restoring a
                // scoped recurring delete (EXDATE / split) by id wouldn't cleanly
                // reverse it, so we don't tempt the user with a broken undo.
                if (scope == null) _state.update { it.copy(undoDeleteId = id) }
            } catch (e: kotlinx.coroutines.CancellationException) { throw e
            } catch (e: Exception) {
                if (profiles.activeId.value != profile.id) return@launch
                _state.update { it.copy(errorMessage = app.getString(R.string.cal_err_delete_failed)) }
            } finally {
                deletionsInFlight.remove(operation)
            }
        }
    }

    /** Undo the last non-recurring delete. Still queued locally → just
     *  cancel the queue entry and put the rows back, no network at all.
     *  Already synced → the restore endpoint (server soft delete). */
    fun restoreLastDelete() {
        val id = _state.value.undoDeleteId ?: return
        val profile = profiles.active()?.takeIf { it.id == undoProfileId } ?: return
        _state.update { it.copy(undoDeleteId = null) }
        viewModelScope.launch {
            try {
                if (repository.offline.cancelPendingDelete(profile, id)) return@launch
                val client = ApiClient.forProfile(profile, profiles)
                client.api.restoreEvent(id)
                if (profiles.activeId.value == profile.id) load()
            } catch (e: kotlinx.coroutines.CancellationException) { throw e
            } catch (e: Exception) {
                if (profiles.activeId.value != profile.id) return@launch
                _state.update { it.copy(errorMessage = app.getString(R.string.cal_err_undo_failed)) }
            }
        }
    }

    /** 队列页逐条裁决待处理条目。裁决后刷新一次：采用服务端版本 /
     *  放弃要靠窗口拉取把本地行覆盖回正，保留我的修改靠重放本身。 */
    fun resolveAttention(
        opId: String,
        resolution: cn.bywave.calendar.data.store.AttentionResolution,
    ) {
        val profile = profiles.active() ?: return
        viewModelScope.launch {
            runCatching { repository.offline.resolveAttention(profile, opId, resolution) }
            if (profiles.activeId.value == profile.id) load()
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
                ApiClient.invalidate(active.id)
                profiles.remove(active.id)
                profiles.onPassiveRemoval?.invoke(active)
            } catch (e: Exception) {
                _state.update { it.copy(errorMessage = app.getString(R.string.cal_err_signout_failed)) }
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

    private var loadJob: kotlinx.coroutines.Job? = null
    fun refreshIfIdle() { if (loadJob?.isActive != true) load() }

    /** 邀请徽章计数。和事件加载同节拍（load 触发时顺带刷），单独一条
     *  轻请求；失败不写 errorMessage、不清零旧值。 */
    private fun refreshInvitationBadge() {
        val profile = profiles.active() ?: return
        viewModelScope.launch {
            runCatching {
                val resp = ApiClient.forProfile(profile, profiles).api.invitations()
                val now = Instant.now()
                resp.invitations.count { inv ->
                    inv.responseStatus == "pending" && !inv.event.cancelled &&
                        runCatching { Instant.parse(inv.expiresAt).isAfter(now) }.getOrDefault(false)
                }
            }.onSuccess { n -> _state.update { it.copy(pendingInvitations = n) } }
        }
    }

    private fun load() {
        refreshInvitationBadge()
        if (profiles.active() == null) {
            _state.update { it.copy(errorMessage = app.getString(R.string.cal_err_not_signed_in)) }
            return
        }
        val loadingProfile = profiles.activeId.value
        loadJob?.cancel()
        _state.update { it.copy(loading = true, errorMessage = null) }

        loadJob = viewModelScope.launch {
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

                // 拉取成功 = 网络是通的：顺手把离线队列往前推一轮
                //（回前台轮询兜底触发点之一）。
                profiles.active()?.let { activeProfile ->
                    runCatching { repository.offline.replay(activeProfile) }
                }

                if (profiles.activeId.value != loadingProfile) return@launch
                _state.update {
                    it.copy(
                        loading = false,
                        lastSyncedAt = Instant.now(),
                        fetchedFrom = from,
                        fetchedTo = to,
                    )
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                if (profiles.activeId.value != loadingProfile) return@launch
                _state.update {
                    it.copy(
                        loading = false,
                        errorMessage = app.getString(R.string.cal_err_load_failed),
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
