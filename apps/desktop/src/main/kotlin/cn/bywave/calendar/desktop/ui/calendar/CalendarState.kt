// Lightweight state holder for the main calendar screen. Compose
// Desktop doesn't have AndroidX ViewModel, so we use a plain class
// scoped via `remember` to the screen. State is a single MutableStateFlow
// so the UI can collectAsState() it.
//
// v0.4 extends the v0.3 holder with view-mode switching (Day / Week /
// Month). The fetched window is "the smallest range that covers the
// current view": for Day → that day; for Week → the Mon-Sun window;
// for Month → the 6-week visible grid. We refetch when the anchor or
// view mode changes.

package cn.bywave.calendar.desktop.ui.calendar

import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.cache.EventCache
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.ParseEventResult
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.desktop.data.notify.ReminderFeed
import cn.bywave.calendar.desktop.util.userFacingDetail
import cn.bywave.calendar.desktop.util.userFacingError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Which secondary modal/dialog is currently open. At most one. */
sealed class ActiveSheet {
    /** Read-only details for an event. */
    data class Detail(val event: EventDTO) : ActiveSheet()
    /** Create new event (optionally seeded with a start time). `clientUid`
     *  is generated ONCE when the editor opens (see [CalendarState.openCreate])
     *  and reused on every save attempt so a retried create (e.g. save →
     *  timeout → save again) collapses onto the same server row instead of
     *  duplicating. */
    data class Create(
        val seedStart: java.time.LocalDateTime? = null,
        val clientUid: String = newClientUid(),
    ) : ActiveSheet()
    /** Edit an existing event. Updates are idempotent by event id, so no
     *  clientUid is sent. */
    data class Edit(val event: EventDTO) : ActiveSheet()
    /** "Copy as new" — same shape as Create but pre-filled from source.
     *  Lands as a POST, so it carries its own stable `clientUid` too. */
    data class Duplicate(
        val source: EventDTO,
        val clientUid: String = newClientUid(),
    ) : ActiveSheet()
}

/** Mint a stable client-side uid for an idempotent create. Format mirrors
 *  an iCalendar UID (`<uuid>@bywave`); the server treats it as the event's
 *  uid (UNIQUE per calendar). */
internal fun newClientUid(): String = java.util.UUID.randomUUID().toString() + "@bywave"

/** When the user pressed "Save" on the edit form of a recurring event,
 *  we park the pending update here while the scope picker is up. Once
 *  they pick, we issue the actual PATCH with the chosen scope. */
data class PendingEdit(
    val sourceId: String,
    val sourceStartsAt: String,
    val body: EventUpdateInput,
    /** 非 null = 这次修改来自主界面上的拖动 / 拉伸，不是编辑弹窗。 */
    val dragged: DraggedEvent? = null,
)

/**
 * 拖动 / 拉伸松手之后，事件先按新时间画在新位置（[moved]）；请求失败就换回
 * [original]，弹回原位。
 *
 * 以前没有这一步：失败写进 formError，而 formError 只在编辑弹窗里渲染 ——
 * 拖动根本没有弹窗，于是失败了界面上一个字都没有。
 */
data class DraggedEvent(val original: EventDTO, val moved: EventDTO)

/** 编辑弹窗（新建 / 编辑 / 复制）开着没有 —— 开着的话错误写进弹窗里。 */
internal fun isFormSheet(sheet: ActiveSheet?): Boolean =
    sheet is ActiveSheet.Create || sheet is ActiveSheet.Edit || sheet is ActiveSheet.Duplicate

/** 弹窗外的操作失败了，给主界面提示条的那句话：「没能删除『X』。」+ 服务端给的理由（有的话）。 */
internal fun actionFailureText(titleKey: String, name: String, e: Throwable): String {
    // 没有标题的事件别写成「没能删除「」」，用提醒那边同一个兜底叫法。
    val shown = name.ifBlank { cn.bywave.calendar.desktop.i18n.I18n.t("reminder.untitled") }
    val title = cn.bywave.calendar.desktop.i18n.I18n.t(titleKey, mapOf("name" to shown))
    val reason = userFacingDetail(e) ?: return title
    return cn.bywave.calendar.desktop.i18n.I18n.t(
        "action.failedWithReason",
        mapOf("action" to title, "reason" to reason),
    )
}

/** 把 [list] 里「是 [from] 那一条」的事件换成 [to]。重复事件的各次发生共用 id，
 *  所以按 id + startsAt 认。找不到就原样返回（比如中途刷新过，列表已经是服务端的了）。 */
internal fun replaceEvent(list: List<EventDTO>, from: EventDTO, to: EventDTO): List<EventDTO> {
    var hit = false
    val out = list.map {
        if (!hit && it.id == from.id && it.startsAt == from.startsAt && it.endsAt == from.endsAt) {
            hit = true
            to
        } else it
    }
    return if (hit) out else list
}

/** Same shape for delete — we park the source while the scope picker
 *  asks for the scope. */
data class PendingDelete(
    val sourceId: String,
    val sourceStartsAt: String,
    val summary: String,
)

/** One just-deleted event offered for undo via the MainScreen snackbar
 *  (parity with web/iOS/Android — the 1.0.14 release note promised this
 *  but only the API half had landed). `token` distinguishes successive
 *  deletes so a stale auto-dismiss can't kill a newer snackbar. */
data class UndoDelete(
    val eventId: String,
    val summary: String,
    val token: Long,
)

data class CalendarUiState(
    val mode: ViewMode = ViewMode.Week,
    val anchor: LocalDate = LocalDate.now(),
    val events: List<EventDTO> = emptyList(),
    val calendars: List<CalendarMeta> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val activeSheet: ActiveSheet? = null,
    val saving: Boolean = false,
    val formError: String? = null,
    val pendingScopeEdit: PendingEdit? = null,
    val pendingScopeDelete: PendingDelete? = null,
    val undoDelete: UndoDelete? = null,
    /** 弹窗外的操作（删除、拖动改时间、撤销删除）失败时给用户看的那句话，
     *  主界面顶部提示条显示，用户点 × 关掉。和 [formError] 分开：那个只在
     *  编辑弹窗里渲染，弹窗外的失败写进去等于没写。 */
    val actionError: String? = null,
)

class CalendarState(
    private val client: ApiClient,
    private val scope: CoroutineScope,
) {
    private val _ui = MutableStateFlow(CalendarUiState())
    val ui: StateFlow<CalendarUiState> = _ui.asStateFlow()

    private var loadJob: Job? = null

    /** Refetch the active window. Stale-while-revalidate: if a fresh
     *  cache entry exists for the current (deviceId, window), we paint
     *  it immediately so the user sees data the moment they open the
     *  APP / navigate; the network call happens in the background and
     *  replaces the in-memory state when it lands.
     *
     *  `useCache = false`：刚改完数据（新建 / 改时间 / 删除 / 撤销）之后的那次
     *  刷新不先画缓存 —— 缓存还是改之前的样子，先画它的话刚拖好的事件会先跳回
     *  原位、等网络回来再跳过去，刚删掉的事件也会先冒出来一下。 */
    fun load(useCache: Boolean = true) {
        loadJob?.cancel()
        loadJob = scope.launch {
            val s = _ui.value
            val (from, to) = windowFor(s.mode, s.anchor)
            val fromIso = ISO_INSTANT.format(from)
            val toIso = ISO_INSTANT.format(to)

            // 1. Paint cache instantly (no spinner) if we have one for
            //    this exact (profile, window) tuple. Cache miss → leave
            //    current state alone but flip `loading=true` so the
            //    user sees the network spinner.
            //
            //    缓存按**这个 client 的账号**读写，不按「当前活动账号」：切账号
            //    时还在飞的那次加载，结果不能写进另一个账号的缓存。
            val deviceId = client.profileId
            val cached = if (useCache) deviceId?.let { EventCache.read(it, fromIso, toIso) } else null
            if (cached != null) {
                _ui.value = _ui.value.copy(
                    events = cached.events,
                    calendars = cached.calendars,
                    loading = true,   // still revalidating
                    error = null,
                )
            } else {
                _ui.value = _ui.value.copy(loading = true, error = null)
            }

            // 2. Hit the network. On success: replace + persist. On
            //    failure: keep whatever we showed (cache or empty), set
            //    error message. CancellationException is NOT an error
            //    — it just means the user navigated away mid-fetch
            //    (e.g. clicked prev/next twice quickly), so the next
            //    load() call wins and we don't surface the cancellation.
            try {
                val resp = client.events(from = fromIso, to = toIso)
                _ui.value = _ui.value.copy(
                    events = resp.events,
                    calendars = resp.calendars,
                    loading = false,
                )
                if (deviceId != null) EventCache.write(deviceId, fromIso, toIso, resp)
            } catch (e: CancellationException) {
                // Re-throw so the coroutine machinery sees it correctly.
                // DON'T flip to error state — this is a benign cancellation.
                throw e
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(
                    loading = false,
                    error = userFacingError(e, "error.loadFailed"),
                )
            }
        }
    }

    fun setMode(mode: ViewMode) {
        if (_ui.value.mode == mode) return
        _ui.value = _ui.value.copy(mode = mode)
        load()
    }

    fun previous() {
        val s = _ui.value
        _ui.value = s.copy(anchor = step(s.mode, s.anchor, forward = false))
        load()
    }

    fun next() {
        val s = _ui.value
        _ui.value = s.copy(anchor = step(s.mode, s.anchor, forward = true))
        load()
    }

    fun today() {
        val today = LocalDate.now()
        if (_ui.value.anchor != today) {
            _ui.value = _ui.value.copy(anchor = today)
            load()
        }
    }

    /** Jump to a specific day. Used from MonthView when the user
     *  clicks a date cell — we switch to Day mode + set anchor. */
    fun jumpToDay(day: LocalDate) {
        _ui.value = _ui.value.copy(mode = ViewMode.Day, anchor = day)
        load()
    }

    // ---- Sheet routing ----

    fun openDetail(event: EventDTO) {
        _ui.value = _ui.value.copy(activeSheet = ActiveSheet.Detail(event), formError = null)
    }

    fun openCreate(seedStart: java.time.LocalDateTime? = null) {
        _ui.value = _ui.value.copy(activeSheet = ActiveSheet.Create(seedStart), formError = null)
    }

    fun openEdit(event: EventDTO) {
        _ui.value = _ui.value.copy(activeSheet = ActiveSheet.Edit(event), formError = null)
    }

    fun openDuplicate(event: EventDTO) {
        _ui.value = _ui.value.copy(activeSheet = ActiveSheet.Duplicate(event), formError = null)
    }

    fun closeSheet() {
        _ui.value = _ui.value.copy(activeSheet = null, formError = null)
    }

    /** Esc 的落点:把当前挂着的所有模态都收掉。
     *
     *  以前 Esc 只走 closeSheet(),而重复事件的「改这一个 / 改以后 / 改整个
     *  系列」选择器不是 activeSheet,是 pendingScopeEdit / pendingScopeDelete
     *  这两个字段 —— 于是这个对话框成了全 App 唯一按 Esc 关不掉的窗口,
     *  只能去点「取消」。把三处一起清,语义才和用户理解的「Esc = 退出当前
     *  这一步」一致。
     *
     *  清 pending 等价于用户点了取消:resolveScope*(null) 也只是把它置空、
     *  不发请求。 */
    fun dismissAllModals() {
        _ui.value = _ui.value.copy(
            activeSheet = null,
            formError = null,
            pendingScopeEdit = null,
            pendingScopeDelete = null,
        )
    }

    // ---- Create / update / delete ----

    /** Create a new event. Closes the sheet + reloads on success.
     *
     *  `clientUid` is read from the open Create/Duplicate sheet (generated
     *  once when that sheet opened), NOT minted here — so a retried save
     *  reuses the same uid and the server collapses the retry onto the
     *  first row instead of duplicating. Falls back to a fresh uid only if
     *  no create sheet is somehow open (defensive; shouldn't happen). */
    fun create(body: EventCreateInput) {
        val clientUid = when (val sheet = _ui.value.activeSheet) {
            is ActiveSheet.Create -> sheet.clientUid
            is ActiveSheet.Duplicate -> sheet.clientUid
            else -> newClientUid()
        }
        scope.launch {
            // 新的一次操作开始，上一次的失败提示就过时了（见 dismissActionError 的说明）。
            _ui.value = _ui.value.copy(saving = true, formError = null, actionError = null)
            try {
                client.createEvent(body, clientUid = clientUid)
                _ui.value = _ui.value.copy(saving = false, activeSheet = null)
                load(useCache = false)
                // 提醒有自己的一份数据（ReminderFeed），跟这里的 load() 不是同一份。
                // 本机刚建的会要立刻进那一份，否则最坏要等到它下一个刷新间隔——
                // 「新建一个 10 分钟后的会，结果没响」就是这么来的。
                ReminderFeed.requestRefresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                reportFormFailure(e)
            }
        }
    }

    /** 编辑弹窗里发起的保存失败了：弹窗还开着就写进弹窗；用户已经把弹窗关了
     *  （保存途中按了 Esc）就改走主界面提示条 —— 否则这次失败谁也看不见。 */
    private fun reportFormFailure(e: Exception) {
        val msg = userFacingError(e, "error.saveFailed")
        _ui.value = if (isFormSheet(_ui.value.activeSheet)) {
            _ui.value.copy(saving = false, formError = msg)
        } else {
            _ui.value.copy(saving = false, actionError = msg)
        }
    }

    /** 用户点了提示条上的 ×。
     *
     *  另外，新建、保存、拖动、删除、撤销每一次开始时都会先收掉旧的失败提示：提示条只说
     *  最近一次操作。以前它只在点 × 时才收，删除失败后再删一次成功了，事件已经不见、
     *  底部弹着「已删除 / 撤销」，顶上的红条还写着「没能删除」，说法和实际正好相反。 */
    fun dismissActionError() {
        _ui.value = _ui.value.copy(actionError = null)
    }

    /** 一句话录入：把「明天下午三点牙医」交给服务端解析成字段。
     *  `now` 传本地墙上时间，好让「明天 / 周五」按用户所在时区算。
     *
     *  以前这里是 `runCatching{...}.getOrNull()`，任何失败都吞成 null，而调用方
     *  拿到 null 就什么都不做——用户看到的是：输入一句话、点「解析」、转一下、
     *  表单纹丝不动，也没有任何说明。现在把失败原样交出去，由对话框贴一行提示。 */
    suspend fun parseEvent(text: String): Result<ParseEventResult> {
        val now = java.time.LocalDateTime.now().withNano(0).toString()
        return runCatching { client.parseEvent(text, now) }
    }

    /** Update an event. If `sourceRrule` is non-null we park the update
     *  and open the scope picker; the caller resumes via [resolveScopeEdit]. */
    fun update(
        sourceId: String,
        sourceRrule: String?,
        sourceStartsAt: String,
        body: EventUpdateInput,
        /** 非 null = 主界面上的拖动 / 拉伸（见 [applyMove]），null = 编辑弹窗。 */
        dragged: DraggedEvent? = null,
    ) {
        if (sourceRrule != null) {
            // 重复事件先问范围；问的时候事件还画在原位，取消就什么都不用改。
            _ui.value = _ui.value.copy(
                pendingScopeEdit = PendingEdit(sourceId, sourceStartsAt, body, dragged),
            )
            return
        }
        sendUpdate(sourceId, body, dragged)
    }

    /** Scope picker callback for edits. scope=null means "user cancelled". */
    fun resolveScopeEdit(scope: String?) {
        val pending = _ui.value.pendingScopeEdit ?: return
        _ui.value = _ui.value.copy(pendingScopeEdit = null)
        if (scope == null) return
        val body = pending.body.copy(
            scope = scope,
            recurrenceId = if (scope == "series") null else pending.sourceStartsAt,
        )
        sendUpdate(pending.sourceId, body, pending.dragged)
    }

    private fun sendUpdate(sourceId: String, body: EventUpdateInput, dragged: DraggedEvent? = null) {
        if (dragged != null) {
            // 先画在松手的位置，别让它弹回原处、等请求回来再跳过去。
            _ui.value = _ui.value.copy(events = replaceEvent(_ui.value.events, dragged.original, dragged.moved))
        }
        scope.launch {
            _ui.value = _ui.value.copy(actionError = null)
            // 拖动不是弹窗里的保存：不碰 saving / formError，免得用户这时打开的
            // 编辑弹窗被莫名其妙地置灰或清掉提示。
            if (dragged == null) _ui.value = _ui.value.copy(saving = true, formError = null)
            try {
                client.updateEvent(sourceId, body)
                if (dragged == null) _ui.value = _ui.value.copy(saving = false, activeSheet = null)
                load(useCache = false)
                ReminderFeed.requestRefresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (dragged == null) {
                    reportFormFailure(e)
                } else {
                    // 弹回原位 + 说清楚。以前写进 formError，而拖动根本没有弹窗。
                    _ui.value = _ui.value.copy(
                        events = replaceEvent(_ui.value.events, dragged.moved, dragged.original),
                        actionError = actionFailureText("action.moveFailed", dragged.original.summary, e),
                    )
                }
            }
        }
    }

    /** Initiate delete. For recurring events we open the scope picker;
     *  for non-recurring we delete immediately. */
    fun delete(event: EventDTO) {
        if (event.rrule != null) {
            _ui.value = _ui.value.copy(
                pendingScopeDelete = PendingDelete(event.id, event.startsAt, event.summary),
            )
            return
        }
        sendDelete(event.id, scope = null, recurrenceId = null, summary = event.summary)
    }

    fun resolveScopeDelete(scope: String?) {
        val pending = _ui.value.pendingScopeDelete ?: return
        _ui.value = _ui.value.copy(pendingScopeDelete = null)
        if (scope == null) return
        sendDelete(
            id = pending.sourceId,
            scope = scope,
            recurrenceId = if (scope == "series") null else pending.sourceStartsAt,
            summary = pending.summary,
        )
    }

    /** Drag-released: shift an event by `deltaMinutes` (in time) and
     *  `deltaDays` (across columns) and PATCH startsAt/endsAt. The
     *  delta is what the WeekView already snapped to 15-minute boundaries
     *  + whole-day columns, so we don't need to re-snap here.
     *
     *  Recurring events reuse the existing scope-picker flow via
     *  [update] — pickerless edits would silently rewrite the whole
     *  series, the same data-loss bug we already fix for save+delete. */
    fun applyMove(event: EventDTO, deltaMinutes: Int, deltaDays: Int) {
        if (deltaMinutes == 0 && deltaDays == 0) return
        val origStart = parseInstant(event.startsAt) ?: return
        val origEnd = parseInstant(event.endsAt) ?: return
        val totalMin = deltaMinutes.toLong() + deltaDays.toLong() * 24L * 60L
        val newStart = origStart.plus(totalMin, java.time.temporal.ChronoUnit.MINUTES)
        val newEnd = origEnd.plus(totalMin, java.time.temporal.ChronoUnit.MINUTES)
        val zone = ZoneId.systemDefault()
        val iso = DateTimeFormatter.ISO_OFFSET_DATE_TIME
        val body = cn.bywave.calendar.desktop.data.model.EventUpdateInput(
            startsAt = iso.format(newStart.atZone(zone)),
            endsAt = iso.format(newEnd.atZone(zone)),
        )
        val moved = event.copy(startsAt = body.startsAt!!, endsAt = body.endsAt!!)
        update(event.id, event.rrule, event.startsAt, body, DraggedEvent(original = event, moved = moved))
    }

    /** Drag-released on the bottom-edge resize handle: stretch the
     *  event to end at a new time, keeping start unchanged. */
    fun applyResize(event: EventDTO, deltaMinutes: Int) {
        if (deltaMinutes == 0) return
        val origStart = parseInstant(event.startsAt) ?: return
        val origEnd = parseInstant(event.endsAt) ?: return
        // Clamp: end must stay at least 15 min after start.
        val candidate = origEnd.plus(deltaMinutes.toLong(), java.time.temporal.ChronoUnit.MINUTES)
        val minEnd = origStart.plus(15L, java.time.temporal.ChronoUnit.MINUTES)
        val finalEnd = if (candidate.isBefore(minEnd)) minEnd else candidate
        val zone = ZoneId.systemDefault()
        val iso = DateTimeFormatter.ISO_OFFSET_DATE_TIME
        val body = cn.bywave.calendar.desktop.data.model.EventUpdateInput(
            endsAt = iso.format(finalEnd.atZone(zone)),
        )
        val moved = event.copy(endsAt = body.endsAt!!)
        update(event.id, event.rrule, event.startsAt, body, DraggedEvent(original = event, moved = moved))
    }

    private fun sendDelete(id: String, scope: String?, recurrenceId: String?, summary: String? = null) {
        this.scope.launch {
            _ui.value = _ui.value.copy(saving = true, formError = null, actionError = null)
            try {
                client.deleteEvent(id, scope, recurrenceId)
                // Whole-event (series) deletes are plain soft-deletes the
                // /restore endpoint can reverse — offer undo. Instance/
                // future scopes edit the master (exdate/UNTIL) and can't
                // be undone by restore, so no snackbar for those.
                val undo = if ((scope == null || scope == "series") && summary != null)
                    UndoDelete(eventId = id, summary = summary, token = System.nanoTime())
                else null
                _ui.value = _ui.value.copy(saving = false, activeSheet = null, undoDelete = undo ?: _ui.value.undoDelete)
                load(useCache = false)
                // 删掉的会不该再响。
                ReminderFeed.requestRefresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // 删除从来不在编辑弹窗里发起（右键菜单、详情弹窗先关再删、范围
                // 选择器），以前写进 formError 等于没写 —— 用户点了删除，事件还在，
                // 一个字的说明都没有。事件本来就没先删，界面保持原样即可。
                _ui.value = _ui.value.copy(
                    saving = false,
                    actionError = actionFailureText("action.deleteFailed", summary ?: "", e),
                )
            }
        }
    }

    /** Undo the last delete (snackbar action). Restore is idempotent
     *  server-side, so a double-click is harmless. */
    fun undoLastDelete() {
        val undo = _ui.value.undoDelete ?: return
        this.scope.launch {
            _ui.value = _ui.value.copy(actionError = null)
            try {
                client.restoreEvent(undo.eventId)
                _ui.value = _ui.value.copy(undoDelete = null)
                load(useCache = false)
                ReminderFeed.requestRefresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // 撤销条留着（还没到时间的话用户可以再点一次），同时说清楚没恢复成。
                _ui.value = _ui.value.copy(
                    actionError = actionFailureText("action.restoreFailed", undo.summary, e),
                )
            }
        }
    }

    /** Auto-dismiss from the snackbar timer. Token-guarded so a stale
     *  timer can't dismiss a newer snackbar. */
    fun dismissUndoDelete(token: Long) {
        if (_ui.value.undoDelete?.token == token) {
            _ui.value = _ui.value.copy(undoDelete = null)
        }
    }

    private fun step(mode: ViewMode, from: LocalDate, forward: Boolean): LocalDate {
        val dir = if (forward) 1L else -1L
        return when (mode) {
            ViewMode.Day -> from.plusDays(dir)
            ViewMode.Week -> from.plusWeeks(dir)
            ViewMode.Month -> from.plusMonths(dir)
            // Agenda shows a rolling ~30-day window; prev/next pages it.
            ViewMode.Agenda -> from.plusDays(dir * AGENDA_WINDOW_DAYS)
        }
    }

    companion object {
        private val ISO_INSTANT: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT
        /** Length of the Agenda view's rolling window, in days. */
        private const val AGENDA_WINDOW_DAYS = 30L

        /** 当前视图要拉的那一段。前闭后开——和服务端同一套约定。
         *
         *  注意这里返回的是**界面正好要画的那一段**：日视图 24 小时、周视图 7 天、
         *  月视图当月那 6 周格子。提醒不能用它当数据源（用了就变成「只提醒你此刻
         *  正在看的那几天」），提醒走 ReminderFeed.windowFor()。 */
        internal fun windowFor(
            mode: ViewMode,
            anchor: LocalDate,
            zone: ZoneId = ZoneId.systemDefault(),
        ): Pair<java.time.Instant, java.time.Instant> {
            return when (mode) {
                ViewMode.Day -> {
                    val s = anchor.atStartOfDay(zone).toInstant()
                    val e = anchor.plusDays(1).atStartOfDay(zone).toInstant()
                    s to e
                }
                ViewMode.Week -> {
                    val ws = startOfWeek(anchor)
                    ws.atStartOfDay(zone).toInstant() to
                        ws.plusDays(7).atStartOfDay(zone).toInstant()
                }
                ViewMode.Month -> {
                    val cells = monthGridDays(YearMonth.from(anchor))
                    cells.first().atStartOfDay(zone).toInstant() to
                        cells.last().plusDays(1).atStartOfDay(zone).toInstant()
                }
                // Agenda: a flat list from the anchor day forward for
                // AGENDA_WINDOW_DAYS. The window starts at the anchor (today by
                // default) so it reads as "what's coming up".
                ViewMode.Agenda -> {
                    val s = anchor.atStartOfDay(zone).toInstant()
                    val e = anchor.plusDays(AGENDA_WINDOW_DAYS).atStartOfDay(zone).toInstant()
                    s to e
                }
            }
        }
    }
}
