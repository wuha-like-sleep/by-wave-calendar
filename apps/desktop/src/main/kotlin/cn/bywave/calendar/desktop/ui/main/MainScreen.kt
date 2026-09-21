// Main calendar screen — top toolbar + sidebar + current view.
//
// v0.4 adds a Day / Week / Month segmented switcher to the top bar.
// Clicking a date cell in Month view jumps to Day view at that date;
// clicking any event opens the EventDetailDialog (read-only, v0.5 adds
// edit + delete).
//
// Layout: Column { TopBar; Row { Sidebar (260dp); ActiveView (fillMax) } }

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.TooltipArea
import androidx.compose.foundation.TooltipPlacement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Button
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.update.DownloadState
import cn.bywave.calendar.desktop.data.update.UpdateChecker
import cn.bywave.calendar.desktop.data.update.UpdateDownloader
import cn.bywave.calendar.desktop.data.update.UpdateInstaller
import cn.bywave.calendar.desktop.ui.calendar.ActiveSheet
import cn.bywave.calendar.desktop.ui.calendar.CalendarState
import cn.bywave.calendar.desktop.ui.calendar.DayView
import cn.bywave.calendar.desktop.ui.calendar.AgendaView
import cn.bywave.calendar.desktop.ui.calendar.MonthView
import cn.bywave.calendar.desktop.ui.calendar.ViewMode
import cn.bywave.calendar.desktop.ui.calendar.WeekView
import cn.bywave.calendar.desktop.ui.calendar.formatDayAnchor
import cn.bywave.calendar.desktop.ui.calendar.formatMonthAnchor
import cn.bywave.calendar.desktop.ui.calendar.formatWeekAnchor
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import cn.bywave.calendar.desktop.ui.calendar.startOfWeek
import cn.bywave.calendar.desktop.ui.event.EventDetailDialog
import cn.bywave.calendar.desktop.ui.event.EventEditDialog
import cn.bywave.calendar.desktop.ui.event.EventEditMode
import cn.bywave.calendar.desktop.ui.event.RecurringAction
import cn.bywave.calendar.desktop.ui.event.RecurringScopePicker
import cn.bywave.calendar.desktop.ui.theme.Dimens
import kotlinx.coroutines.launch

@Composable
fun MainScreen(
    onAddAccount: () -> Unit,
) {
    val profile by ProfileStore.profile.collectAsState()
    val profiles by ProfileStore.profiles.collectAsState()
    val p = profile

    val scope = rememberCoroutineScope()
    // 一个账号一个 ApiClient,日历视图和提醒共用它。
    //
    // 共用是有意的:刷新令牌的单飞锁(ApiClient.refreshMutex)是**实例**级别的。
    // 给提醒单开一个 ApiClient,就等于多一个每两分钟固定发请求的实例,迟早和
    // 用户的操作同时撞上 401 —— 两个实例各自去换令牌,服务端轮换之后必然有
    // 一个手里拿的是旧的,刷新失败会走 markSignedOut(),把人直接踢回登录页。
    val client = remember(p?.serverUrl, p?.userId) {
        if (p == null) null else ApiClient(p.serverUrl)
    }
    val state = remember(client) {
        if (client == null) null else CalendarState(client, scope)
    }

    LaunchedEffect(state) { state?.load() }

    // 事件提醒。
    //
    // 数据源是 ReminderFeed,不是 state.ui —— state.ui 里装的是「当前视图正好
    // 要画的那一段」(日视图 24 小时 / 周视图 7 天 / 月视图那 6 周格子),接过来
    // 就变成「提醒只对你此刻正在看的那几天生效」,而且不响的时候界面上没有任何
    // 迹象。ReminderFeed 自己按「从现在起 N 天」拉,跟用户在看哪一天无关。
    //
    // 两个协程放在同一个 LaunchedEffect 里,是为了保证「先清干净、再开跑」:
    // 切账号时上一个账号的事件和「响过」记录都要先归零。
    LaunchedEffect(client) {
        val c = client ?: return@LaunchedEffect
        cn.bywave.calendar.desktop.data.notify.ReminderFeed.reset()
        cn.bywave.calendar.desktop.data.notify.ReminderScheduler.reset()
        kotlinx.coroutines.coroutineScope {
            launch {
                cn.bywave.calendar.desktop.data.notify.ReminderFeed.run { from, to ->
                    c.events(from = from, to = to).events
                }
            }
            launch { cn.bywave.calendar.desktop.data.notify.ReminderScheduler.run() }
        }
    }

    // Background update check on every profile switch + first mount.
    // Throttle is in UpdateChecker; subsequent profile switches in the
    // same 6h window are no-ops. We do call once per session boot
    // though, so a fresh launch on day 2 always re-checks.
    LaunchedEffect(p?.serverUrl) {
        p?.serverUrl?.let { UpdateChecker.check(it) }
    }
    val updateInfo by UpdateChecker.available.collectAsState()
    var showUpdateDialog by remember { mutableStateOf(false) }
    // Settings page visibility. Toggled by the toolbar gear icon, the
    // Cmd+, shortcut, or the MenuBar item. Esc inside Settings closes
    // it (the SettingsScreen's own onClose).
    var showSettings by remember { mutableStateOf(false) }
    // Global search dialog visibility. Opened by the toolbar magnifier or
    // Cmd/Ctrl+F; Esc closes it (handled in the ShortcutAction.Escape arm).
    var showSearch by remember { mutableStateOf(false) }
    // When MenuBar's "检查更新" fires, ShortcutAction.CheckUpdate
    // arrives here; we kick the force-check then auto-pop the dialog
    // if something new was found. forceCheckOutcome lets us show a
    // light snackbar-ish indicator on "already latest" too.
    val forceOutcome by UpdateChecker.lastForceCheckOutcome.collectAsState()
    // A DMG that's downloaded + staged to apply on quit. Drives the slim
    // "退出后自动更新" banner below. Set by UpdateInstaller.stage() once
    // the background download completes.
    val staged by UpdateInstaller.staged.collectAsState()
    // Lets the user dismiss the staged-update banner for this session.
    // The update still applies on quit — this only hides the bar.
    var bannerDismissed by remember { mutableStateOf(false) }
    LaunchedEffect(updateInfo) {
        // v0.8: Chrome / VS Code style — download silently in the
        // background instead of popping a blocking dialog. The download
        // → stage chain (collector below) then surfaces a slim banner; the
        // swap applies on quit. We only kick a download when one isn't
        // already running/done and nothing is staged yet.
        val info = updateInfo ?: return@LaunchedEffect
        val asset = UpdateChecker.platform?.let { info.assets[it] } ?: return@LaunchedEffect
        val dl = UpdateDownloader.state.value
        if ((dl is DownloadState.Idle || dl is DownloadState.Failed) &&
            UpdateInstaller.staged.value == null
        ) {
            scope.launch { UpdateDownloader.download(asset.url, asset.sha256.ifBlank { null }) }
        }
    }
    // When the background download finishes, stage the file so it applies
    // on quit (and arm the shutdown hook). Collected once for the session.
    LaunchedEffect(Unit) {
        UpdateDownloader.state.collect { s ->
            if (s is DownloadState.Done) UpdateInstaller.stage(s.file)
        }
    }

    // 切账号 / 被登出时收掉搜索框。
    //
    // SearchDialog 的结果列表是它自己的 state,而它只是换了个 serverUrl
    // 参数 —— 组件没被重建,上一个账号的搜索结果会原样留在屏幕上,点一下
    // 还会跳到那条并不属于当前账号的日期。切账号时直接关掉最干净。
    // 这个 effect 首次挂载也会跑一次,那时 showSearch 本来就是 false。
    LaunchedEffect(state) { showSearch = false }

    // Pipe keyboard shortcuts (Cmd/Ctrl+N, etc.) into CalendarState.
    // Re-attaches when CalendarState rebuilds on profile switch. Escape
    // closes any open sheet (dialog focus consumes letter keys but Esc
    // reaches us via Window's onPreviewKeyEvent regardless).
    LaunchedEffect(state) {
        val s = state ?: return@LaunchedEffect
        ShortcutBus.flow.collect { action ->
            when (action) {
                ShortcutAction.New -> s.openCreate()
                ShortcutAction.Refresh -> s.load()
                ShortcutAction.Today -> s.today()
                ShortcutAction.Previous -> s.previous()
                ShortcutAction.Next -> s.next()
                ShortcutAction.Escape -> {
                    // Esc 的优先级:更新对话框 → 搜索框 → 设置页 → 其它模态。
                    // 更新对话框排最前,因为它是浮在所有东西之上的那一层;
                    // 以前这条链里没有它,于是 Cmd+U 弹出来的那个框成了唯一
                    // 一个按 Esc 关不掉的窗口(只能去点按钮)。
                    when {
                        showUpdateDialog -> {
                            showUpdateDialog = false
                            UpdateChecker.dismiss()
                        }
                        showSearch -> showSearch = false
                        showSettings -> showSettings = false
                        else -> s.dismissAllModals()
                    }
                }
                ShortcutAction.OpenSearch -> { showSearch = true }
                ShortcutAction.CheckUpdate -> {
                    val url = p?.serverUrl ?: return@collect
                    UpdateChecker.forceCheck(url)
                    // Open the dialog regardless of outcome — if update
                    // was found the LaunchedEffect already flipped
                    // showUpdateDialog=true; if not, we still want to
                    // give the user feedback via a small dialog.
                    showUpdateDialog = true
                }
                ShortcutAction.OpenSettings -> { showSettings = true }
                ShortcutAction.ViewDay -> s.setMode(ViewMode.Day)
                ShortcutAction.ViewWeek -> s.setMode(ViewMode.Week)
                ShortcutAction.ViewMonth -> s.setMode(ViewMode.Month)
                ShortcutAction.ViewAgenda -> s.setMode(ViewMode.Agenda)
            }
        }
    }

    if (p == null || state == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val ui by state.ui.collectAsState()
    // Observe locale so the anchor label (date formatters + agenda range)
    // and the inline "up to date" dialog re-render on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val anchorLabel = remember(locale, ui.mode, ui.anchor) { anchorLabelFor(ui.mode, ui.anchor) }

    // 整屏宽度决定顶栏和侧栏的形态。窗口最小宽度是 960dp(见 Main.kt),
    // 在那个宽度上顶栏原样排会溢出——Row 溢出是静默裁剪,被切掉的正好是
    // 排在最后的设置/刷新/搜索三个图标,用户会以为设置入口没了。
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val compact = maxWidth < 1180.dp
        // 侧栏在窄窗口收窄而不是消失:账号切换器和日历色卡都在里面,整块拿掉
        // 用户就没法切账号了。
        val sidebarWidth = if (compact) 210.dp else 260.dp

        Column(modifier = Modifier.fillMaxSize()) {
            TopBar(
                mode = ui.mode,
                anchorLabel = anchorLabel,
                loading = ui.loading,
                compact = compact,
                onModeChange = { state.setMode(it) },
                onPrev = { state.previous() },
                onToday = { state.today() },
                onNext = { state.next() },
                onRefresh = { state.load() },
                onNew = { state.openCreate() },
                onOpenSearch = { showSearch = true },
                // Settings page hosts sign-out + all account / security /
                // appearance / about controls. Previously the toolbar had
                // its own Logout icon — removed in favor of the Settings
                // path so a misclick can't drop the active profile.
                onOpenSettings = { showSettings = true },
            )
            HorizontalDivider()

            // Staged-update banner (re-added in v0.8; a minimal banner was
            // removed in v0.7.3). Non-blocking: a new version has already
            // downloaded in the background and will apply on quit. We offer
            // an immediate "立即重启" plus a "×" to hide the bar for this
            // session (the update still applies on quit regardless).
            val stagedFile = staged
            if (stagedFile != null && !bannerDismissed) {
                StagedUpdateBanner(
                    versionName = updateInfo?.versionName,
                    onRestartNow = { UpdateInstaller.staged.value?.let { UpdateInstaller.install(it) } },
                    onDismiss = { bannerDismissed = true },
                )
            }

            Row(modifier = Modifier.fillMaxSize()) {
                Sidebar(
                    width = sidebarWidth,
                    active = p,
                    profiles = profiles,
                    calendars = ui.calendars,
                    onProfileSelect = { ProfileStore.setActive(it) },
                    onAddAccount = onAddAccount,
                    onProfileRemove = { ProfileStore.remove(it) },
                )
                VerticalDivider()
                Box(modifier = Modifier.fillMaxSize()) {
                    when (ui.mode) {
                        ViewMode.Day -> DayView(
                            anchor = ui.anchor,
                            events = ui.events,
                            calendars = ui.calendars,
                            loading = ui.loading,
                            onEventClick = { state.openDetail(it) },
                            onEventEdit = { state.openEdit(it) },
                            onEventDuplicate = { state.openDuplicate(it) },
                            onEventDelete = { state.delete(it) },
                        )
                        ViewMode.Week -> WeekView(
                            weekStart = startOfWeek(ui.anchor),
                            events = ui.events,
                            calendars = ui.calendars,
                            onEventClick = { state.openDetail(it) },
                            onEventEdit = { state.openEdit(it) },
                            onEventDuplicate = { state.openDuplicate(it) },
                            onEventDelete = { state.delete(it) },
                            onEventMove = { ev, dm, dd -> state.applyMove(ev, dm, dd) },
                            onEventResize = { ev, dm -> state.applyResize(ev, dm) },
                            onEmptySlotClick = { seedTime -> state.openCreate(seedTime) },
                        )
                        ViewMode.Month -> MonthView(
                            anchor = ui.anchor,
                            events = ui.events,
                            calendars = ui.calendars,
                            onDayClick = { state.jumpToDay(it) },
                            onEventClick = { state.openDetail(it) },
                            onEventEdit = { state.openEdit(it) },
                            onEventDuplicate = { state.openDuplicate(it) },
                            onEventDelete = { state.delete(it) },
                        )
                        ViewMode.Agenda -> AgendaView(
                            anchor = ui.anchor,
                            events = ui.events,
                            calendars = ui.calendars,
                            loading = ui.loading,
                            onEventClick = { state.openDetail(it) },
                            onEventEdit = { state.openEdit(it) },
                            onEventDuplicate = { state.openDuplicate(it) },
                            onEventDelete = { state.delete(it) },
                        )
                    }
                    if (ui.error != null) {
                        ErrorBanner(message = ui.error!!, onRetry = { state.load() })
                    }
                    ui.undoDelete?.let { undo ->
                        UndoDeleteSnackbar(
                            undo = undo,
                            onUndo = { state.undoLastDelete() },
                            onTimeout = { state.dismissUndoDelete(undo.token) },
                            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
                        )
                    }
                }
            }
        }
    }

    // ---- Sheets / dialogs ----
    when (val sheet = ui.activeSheet) {
        is ActiveSheet.Detail -> EventDetailDialog(
            event = sheet.event,
            calendars = ui.calendars,
            onDismiss = { state.closeSheet() },
            onEdit = { state.openEdit(it) },
            onDelete = { ev ->
                state.closeSheet()
                state.delete(ev)
            },
        )
        is ActiveSheet.Create -> EventEditDialog(
            mode = EventEditMode.Create(sheet.seedStart),
            calendars = ui.calendars,
            saving = ui.saving,
            errorMessage = ui.formError,
            onSave = { _, _, _, _, create, _ ->
                if (create != null) state.create(create)
            },
            onDismiss = { state.closeSheet() },
            onQuickParse = { state.parseEvent(it) },
        )
        is ActiveSheet.Duplicate -> EventEditDialog(
            mode = EventEditMode.Duplicate(sheet.source),
            calendars = ui.calendars,
            saving = ui.saving,
            errorMessage = ui.formError,
            onSave = { _, _, _, _, create, _ ->
                if (create != null) state.create(create)
            },
            onDismiss = { state.closeSheet() },
        )
        is ActiveSheet.Edit -> EventEditDialog(
            mode = EventEditMode.Edit(sheet.event),
            calendars = ui.calendars,
            saving = ui.saving,
            errorMessage = ui.formError,
            onSave = { _, sourceId, sourceRrule, sourceStartsAt, _, update ->
                if (update != null && sourceId != null && sourceStartsAt != null) {
                    state.update(sourceId, sourceRrule, sourceStartsAt, update)
                }
            },
            onDismiss = { state.closeSheet() },
        )
        null -> Unit
    }

    // Scope picker for recurring edits
    if (ui.pendingScopeEdit != null) {
        RecurringScopePicker(
            action = RecurringAction.Edit,
            onPick = { state.resolveScopeEdit(it.wire) },
            onDismiss = { state.resolveScopeEdit(null) },
        )
    }
    // Scope picker for recurring deletes
    if (ui.pendingScopeDelete != null) {
        RecurringScopePicker(
            action = RecurringAction.Delete,
            onPick = { state.resolveScopeDelete(it.wire) },
            onDismiss = { state.resolveScopeDelete(null) },
        )
    }

    // In-app updater. Auto-opens when a new manifest is spotted; user
    // can also open it via MenuBar "检查更新" / Cmd+U. We render it
    // outside the main Column so the AlertDialog floats above
    // everything (including the Sidebar / view content).
    if (showUpdateDialog && updateInfo != null) {
        UpdateDialog(onDismiss = {
            showUpdateDialog = false
            UpdateChecker.dismiss()
        })
    } else if (showUpdateDialog && updateInfo == null) {
        // Force-check returned "up to date" — show a slim confirmation
        // dialog so the user knows the check happened. forceOutcome
        // is observed for the Checking state too (rare; usually
        // network call completes before the user can read the dialog).
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showUpdateDialog = false },
            title = { androidx.compose.material3.Text(cn.bywave.calendar.desktop.i18n.I18n.t("update.upToDate.title")) },
            text = {
                androidx.compose.material3.Text(
                    when (forceOutcome) {
                        UpdateChecker.ForceCheckOutcome.Checking -> cn.bywave.calendar.desktop.i18n.I18n.t("update.upToDate.checking")
                        is UpdateChecker.ForceCheckOutcome.Error ->
                            (forceOutcome as UpdateChecker.ForceCheckOutcome.Error).message
                        else -> cn.bywave.calendar.desktop.i18n.I18n.t(
                            "update.upToDate.body",
                            mapOf("version" to cn.bywave.calendar.desktop.BuildInfo.VERSION_NAME),
                        )
                    },
                )
            },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = { showUpdateDialog = false }) {
                    androidx.compose.material3.Text(cn.bywave.calendar.desktop.i18n.I18n.t("update.upToDate.button"))
                }
            },
        )
    }

    // Global search dialog. Opened by the toolbar magnifier / Cmd+F.
    // Picking a result jumps the calendar to that event's local date
    // (CalendarState.jumpToDay switches to Day view at that date) and
    // closes the dialog. Floats above everything via AlertDialog.
    if (showSearch) {
        SearchDialog(
            serverUrl = p.serverUrl,
            onJumpToDate = { day ->
                state.jumpToDay(day)
                showSearch = false
            },
            onDismiss = { showSearch = false },
        )
    }

    // Settings page — rendered as a full-screen overlay on top of the
    // calendar. Hosts account / calendars / security / appearance /
    // about. Sign-out, profile switch, and "+ add account" all bubble
    // back up to the same ProfileStore callbacks the toolbar used to
    // wire directly.
    if (showSettings) {
        SettingsScreen(
            profile = p,
            profiles = profiles,
            calendars = ui.calendars,
            onClose = { showSettings = false },
            onSignOut = {
                showSettings = false
                ProfileStore.clear()
            },
            onSwitchProfile = { id -> ProfileStore.setActive(id) },
            onRemoveProfile = { id -> ProfileStore.remove(id) },
            onAddAccount = {
                showSettings = false
                onAddAccount()
            },
            onCheckUpdate = {
                val url = p.serverUrl
                scope.launch { UpdateChecker.forceCheck(url) }
                // Don't close Settings — the dialog will float on top
                // when the manifest comes back. If "up to date," the
                // showUpdateDialog branch shows a slim confirmation.
                showUpdateDialog = true
            },
            // A calendar create / rename / recolor / delete in Settings
            // mutates server state; re-run the events fetch so the
            // updated calendar list (embedded in EventsResponse.calendars)
            // flows back into both the Settings list and the calendar
            // views behind the overlay.
            onCalendarsChanged = { state.load() },
        )
    }
}

private fun anchorLabelFor(mode: ViewMode, anchor: java.time.LocalDate): String = when (mode) {
    ViewMode.Day -> formatDayAnchor(anchor)
    ViewMode.Week -> formatWeekAnchor(startOfWeek(anchor))
    ViewMode.Month -> formatMonthAnchor(anchor)
    // Agenda spans a 30-day window from the anchor.
    ViewMode.Agenda -> cn.bywave.calendar.desktop.i18n.I18n.t(
        "topbar.agendaRange",
        mapOf("date" to formatWeekAnchor(anchor).substringBefore(" –")),
    )
}

/** 修饰键在这台机器上叫什么。macOS 写 ⌘,其它平台写 Ctrl —— 提示里
 *  印错了比不印更糟。 */
private val MOD_LABEL: String =
    if (System.getProperty("os.name").orEmpty().lowercase().contains("mac")) "⌘" else "Ctrl+"

/** 带快捷键提示的悬浮气泡。桌面端的快捷键如果不写在某处,等于没有:
 *  顶栏这几个图标按钮以前连名字都不显示,鼠标停上去什么也不出现,
 *  Cmd+F / Cmd+R / Cmd+, 只有读过源码的人知道。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WithTooltip(text: String, shortcut: String? = null, content: @Composable () -> Unit) {
    TooltipArea(
        tooltip = {
            Surface(
                shape = RoundedCornerShape(6.dp),
                tonalElevation = 4.dp,
                shadowElevation = 4.dp,
            ) {
                Text(
                    text = if (shortcut == null) text else "$text  $MOD_LABEL$shortcut",
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        },
        delayMillis = 500,
        tooltipPlacement = TooltipPlacement.CursorPoint(offset = androidx.compose.ui.unit.DpOffset(0.dp, 16.dp)),
        content = content,
    )
}

@Composable
private fun TopBar(
    mode: ViewMode,
    anchorLabel: String,
    loading: Boolean,
    /** 窄窗口:藏掉产品名、「新建」只留图标。让出来的 ~200dp 正好是
     *  末尾三个图标按钮被切掉的那部分。 */
    compact: Boolean,
    onModeChange: (ViewMode) -> Unit,
    onPrev: () -> Unit,
    onToday: () -> Unit,
    onNext: () -> Unit,
    onRefresh: () -> Unit,
    onNew: () -> Unit,
    onOpenSearch: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    // Collect locale so this whole TopBar re-renders when the user
    // switches language in Settings. Cheap; rebuilds the (small) row.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!compact) {
            Text(
                t("app.name"),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.width(20.dp))
        }

        WithTooltip(prevLabel(mode, t), "←") {
            IconButton(onClick = onPrev) {
                Icon(Icons.Default.ChevronLeft, contentDescription = prevLabel(mode, t))
            }
        }
        WithTooltip(t("topbar.today"), "T") {
            OutlinedButton(onClick = onToday) { Text(t("topbar.today")) }
        }
        WithTooltip(nextLabel(mode, t), "→") {
            IconButton(onClick = onNext) {
                Icon(Icons.Default.ChevronRight, contentDescription = nextLabel(mode, t))
            }
        }

        Spacer(Modifier.width(12.dp))
        // 日期标签吃掉所有富余宽度(weight),而不是在它后面塞一个
        // Spacer(weight) 把后面的按钮往右推。差别在窗口变窄时:
        // 前者让标签自己省略号收缩,后者会把末尾的设置图标挤出窗口。
        // 德语的月份名 + 年份最长,是这里的压力测试用例。
        Text(
            anchorLabel,
            style = MaterialTheme.typography.titleSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))

        // Day / Week / Month segmented switcher
        SingleChoiceSegmentedButtonRow {
            val options = ViewMode.entries
            options.forEachIndexed { idx, m ->
                SegmentedButton(
                    selected = mode == m,
                    onClick = { onModeChange(m) },
                    shape = SegmentedButtonDefaults.itemShape(index = idx, count = options.size),
                ) { Text(t(viewModeKey(m))) }
            }
        }

        Spacer(Modifier.width(16.dp))

        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(Dimens.spinnerSmall),
                strokeWidth = Dimens.spinnerStroke,
            )
            Spacer(Modifier.width(8.dp))
        }
        WithTooltip(t("topbar.new"), "N") {
            Button(onClick = onNew) {
                Icon(
                    Icons.Default.Add,
                    // 紧凑模式下文字没了,图标就得自己承担说明职责 ——
                    // contentDescription 在桌面端是 hover 提示的来源。
                    contentDescription = if (compact) t("topbar.new") else null,
                    modifier = Modifier.size(18.dp),
                )
                if (!compact) {
                    Spacer(Modifier.width(6.dp))
                    Text(t("topbar.new"))
                }
            }
        }
        Spacer(Modifier.width(4.dp))
        // Global search (Cmd/Ctrl+F) — opens the event search dialog.
        WithTooltip(t("topbar.search"), "F") {
            IconButton(onClick = onOpenSearch) {
                Icon(Icons.Default.Search, contentDescription = t("topbar.search"))
            }
        }
        WithTooltip(t("topbar.refresh"), "R") {
            IconButton(onClick = onRefresh) {
                Icon(Icons.Default.Refresh, contentDescription = t("topbar.refresh"))
            }
        }
        // Settings (Cmd+,) — primary entry to the Settings page. Logout
        // is still accessible there but no longer pollutes the toolbar
        // (a misclick used to drop the active profile with no confirm).
        WithTooltip(t("topbar.settings"), ",") {
            IconButton(onClick = onOpenSettings) {
                Icon(Icons.Default.Settings, contentDescription = t("topbar.settings"))
            }
        }
    }
}

/** ViewMode → I18n key. Kept separate from prev/next labels so the
 *  segmented switcher can show short labels (日 / 周 / 月) while the
 *  arrow buttons get the longer aria description (前一天 / 上一周 / …). */
private fun viewModeKey(mode: ViewMode): String = when (mode) {
    ViewMode.Day -> "viewmode.day"
    ViewMode.Week -> "viewmode.week"
    ViewMode.Month -> "viewmode.month"
    ViewMode.Agenda -> "viewmode.agenda"
}

private fun prevLabel(mode: ViewMode, t: (String) -> String): String = when (mode) {
    ViewMode.Day -> t("topbar.prevDay")
    ViewMode.Week -> t("topbar.prevWeek")
    ViewMode.Month -> t("topbar.prevMonth")
    ViewMode.Agenda -> t("topbar.prevAgenda")
}

private fun nextLabel(mode: ViewMode, t: (String) -> String): String = when (mode) {
    ViewMode.Day -> t("topbar.nextDay")
    ViewMode.Week -> t("topbar.nextWeek")
    ViewMode.Month -> t("topbar.nextMonth")
    ViewMode.Agenda -> t("topbar.nextAgenda")
}

@Composable
private fun Sidebar(
    width: Dp,
    active: cn.bywave.calendar.desktop.data.model.Profile,
    profiles: List<cn.bywave.calendar.desktop.data.model.Profile>,
    calendars: List<cn.bywave.calendar.desktop.data.model.CalendarMeta>,
    onProfileSelect: (String) -> Unit,
    onAddAccount: () -> Unit,
    onProfileRemove: (String) -> Unit,
) {
    // Observe locale so the section header + empty state re-render on switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    Column(
        modifier = Modifier
            .width(width)
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .verticalScroll(rememberScrollState())
            .padding(12.dp),
    ) {
        ProfileSwitcher(
            active = active,
            profiles = profiles,
            onSelect = onProfileSelect,
            onAddAccount = onAddAccount,
            onRemove = onProfileRemove,
        )
        Spacer(Modifier.height(16.dp))

        Text(
            t("sidebar.myCalendars"),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 10.dp),
        )
        Spacer(Modifier.height(8.dp))

        if (calendars.isEmpty()) {
            Text(
                t("sidebar.empty"),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.padding(start = 10.dp),
            )
        } else {
            Column(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(horizontal = 10.dp),
            ) {
                for (cal in calendars) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(12.dp)
                                .clip(CircleShape)
                                .background(parseHex(cal.color)),
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            cal.name,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ErrorBanner(message: String, onRetry: () -> Unit) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))
        OutlinedButton(onClick = onRetry) {
            Text(remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("error.retry") })
        }
    }
}

/** Bottom snackbar offering undo for the last delete (parity with
 *  web/iOS/Android). Auto-dismisses after 5s; keying the timer on the
 *  token restarts it per delete, and cancellation on removal is safe —
 *  Kotlin's delay() throws CancellationException, which propagates out
 *  of LaunchedEffect instead of falling through to onTimeout. */
@Composable
private fun UndoDeleteSnackbar(
    undo: cn.bywave.calendar.desktop.ui.calendar.UndoDelete,
    onUndo: () -> Unit,
    onTimeout: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    LaunchedEffect(undo.token) {
        kotlinx.coroutines.delay(5_000)
        onTimeout()
    }
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(10.dp),
        tonalElevation = 6.dp,
        shadowElevation = 6.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                remember(locale, undo) {
                    cn.bywave.calendar.desktop.i18n.I18n.t("undo.deleted", mapOf("name" to undo.summary))
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.width(12.dp))
            TextButton(onClick = onUndo) {
                Text(remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("undo.action") })
            }
        }
    }
}

/** Slim, non-blocking bar shown when a newer version has been downloaded
 *  and staged to apply on quit. "立即重启" applies it now (swap +
 *  relaunch); "×" hides the bar for this session (the update still
 *  applies when the user quits). Styled as a thin primaryContainer
 *  strip above the calendar. */
@Composable
private fun StagedUpdateBanner(
    versionName: String?,
    onRestartNow: () -> Unit,
    onDismiss: () -> Unit,
) {
    // Reactive locale so the strings re-render on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val message = remember(locale, versionName) {
        cn.bywave.calendar.desktop.i18n.I18n.t(
            "update.staged",
            mapOf("version" to ("v" + (versionName ?: ""))),
        )
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.primaryContainer)
            .padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "✓ $message",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))
        TextButton(onClick = onRestartNow) {
            Text(cn.bywave.calendar.desktop.i18n.I18n.t("update.restartNow"))
        }
        IconButton(onClick = onDismiss) {
            Icon(
                Icons.Default.Close,
                // 这里以前挂的是 settings.close(「关闭设置」)—— 和这个按钮
                // 实际干的事(收起更新提示条)对不上。用通用的「关闭」。
                contentDescription = cn.bywave.calendar.desktop.i18n.I18n.t("event.detail.close"),
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}
