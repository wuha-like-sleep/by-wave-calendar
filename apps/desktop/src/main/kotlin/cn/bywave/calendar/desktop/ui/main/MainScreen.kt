// Main calendar screen — top toolbar + sidebar + current view.
//
// v0.4 adds a Day / Week / Month segmented switcher to the top bar.
// Clicking a date cell in Month view jumps to Day view at that date;
// clicking any event opens the EventDetailDialog (read-only, v0.5 adds
// edit + delete).
//
// Layout: Column { TopBar; Row { Sidebar (260dp); ActiveView (fillMax) } }

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.material3.Checkbox
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.ui.unit.sp
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
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ButtonDefaults
import cn.bywave.calendar.desktop.ui.theme.BrandMark
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
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.FileUpload
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
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
    // ApiClient 绑定的是建立它的那个账号(deviceId):令牌按那个账号读、按那个
    // 账号换、吊销了也只登出那个账号。所以 key 必须是 deviceId —— 以前按
    // serverUrl + userId 认,同一台服务器上的两个配对会共用一个 client,而 client
    // 里读的又是「当前活动账号」的票。换票的单飞锁现在按账号全进程共用
    // (见 ApiClient.refreshLockFor),设置页另起的 client 也不会和这里抢着换票。
    val client = remember(p?.deviceId, p?.serverUrl) {
        if (p == null) null else ApiClient(p)
    }
    val state = remember(client) {
        if (client == null) null else CalendarState(client, scope)
    }

    var showOfflineQueue by remember { mutableStateOf(false) }

    LaunchedEffect(state) { state?.load() }
    val focused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(state, focused) {
        val active = state ?: return@LaunchedEffect
        if (!focused) return@LaunchedEffect
        if (active.ui.value.activeSheet !is ActiveSheet.Detail) active.refreshIfIdle()
        while (true) {
            kotlinx.coroutines.delay(15_000)
            if (active.ui.value.activeSheet !is ActiveSheet.Detail) active.refreshIfIdle()
        }
    }

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
                    val resp = c.events(from = from, to = to)
                    // 全天事件级提醒的墙上时间换算要用到日历时区，顺手交给
                    // ReminderFeed（事件自己的 extra.timezone 优先于它）。
                    cn.bywave.calendar.desktop.data.notify.ReminderFeed.noteCalendars(resp.calendars)
                    resp.events
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
        p?.let { UpdateChecker.check(it.serverUrl, it.deviceId) }
    }
    val updateInfo by UpdateChecker.available.collectAsState()
    var showUpdateDialog by remember { mutableStateOf(false) }
    // Settings page visibility. Toggled by the toolbar gear icon, the
    // Cmd+, shortcut, or the MenuBar item. Esc inside Settings closes
    // it (the SettingsScreen's own onClose).
    var showSettings by remember { mutableStateOf(false) }
    // Deep-link target for Settings: when set via a sidebar calendar's
    // edit button, Settings opens on the Calendars tab with that
    // calendar's edit dialog up. Cleared whenever Settings is opened
    // the ordinary way (gear / shortcut) and when it closes.
    var settingsEditCalendarId by remember { mutableStateOf<String?>(null) }
    // Same idea for creating: the sidebar's "new calendar" entry opens
    // Settings on the Calendars tab with the create dialog up.
    var settingsCreateCalendar by remember { mutableStateOf(false) }
    // Global search dialog visibility. Opened by the toolbar magnifier or
    // Cmd/Ctrl+F; Esc closes it (handled in the ShortcutAction.Escape arm).
    var showSearch by remember { mutableStateOf(false) }
    // Invitations addressed to me: dialog visibility + the toolbar
    // badge (invitations still awaiting my reply).
    var showInvitations by remember { mutableStateOf(false) }
    var invitationPending by remember { mutableStateOf(0) }
    // 购买清单对话框：顶栏购物车入口打开列表态；initialListId 预留
    // 给需要直达某张清单详情的入口（当前顶栏入口传 null）。
    var showShoppingLists by remember { mutableStateOf(false) }
    var shoppingInitialListId by remember { mutableStateOf<String?>(null) }

    suspend fun refreshInvitationBadge(c: ApiClient) {
        // Badge is advisory — a failed fetch keeps the previous count.
        runCatching {
            val now = java.time.Instant.now()
            invitationPending = c.invitations().invitations.count { inv ->
                inv.responseStatus == "pending" && !inv.event.cancelled &&
                    (runCatching { java.time.Instant.parse(inv.expiresAt) }.getOrNull()?.isAfter(now) ?: true)
            }
        }
    }

    // Badge refresh: once per client (account) and then on a slow poll
    // alongside the calendar's own refresh rhythm.
    LaunchedEffect(client) {
        val c = client ?: return@LaunchedEffect
        while (true) {
            refreshInvitationBadge(c)
            kotlinx.coroutines.delay(60_000)
        }
    }
    // ICS import: the file picked in the toolbar's native file dialog.
    // Non-null → the import confirmation dialog is showing.
    var importFile by remember { mutableStateOf<java.io.File?>(null) }
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
            scope.launch { UpdateDownloader.download(asset.url, asset.sha256, asset.sizeBytes, asset.fallbackUrl, asset.mirrorUrl) }
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
    LaunchedEffect(state) { showSearch = false; importFile = null }

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
                        showSettings -> { showSettings = false; settingsEditCalendarId = null; settingsCreateCalendar = false }
                        else -> s.dismissAllModals()
                    }
                }
                ShortcutAction.OpenSearch -> { showSearch = true }
                ShortcutAction.OpenImport -> { pickIcsFile()?.let { importFile = it } }
                ShortcutAction.CheckUpdate -> {
                    val url = p?.serverUrl ?: return@collect
                    UpdateChecker.forceCheck(url, p?.deviceId)
                    // Open the dialog regardless of outcome — if update
                    // was found the LaunchedEffect already flipped
                    // showUpdateDialog=true; if not, we still want to
                    // give the user feedback via a small dialog.
                    showUpdateDialog = true
                }
                ShortcutAction.OpenSettings -> { settingsEditCalendarId = null; settingsCreateCalendar = false; showSettings = true }
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
    val deviceZone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()
    LaunchedEffect(state, deviceZone, ui.saving) {
        state.followDisplayTimeZone(deviceZone)
    }
    val signedOutNotices by ProfileStore.signedOutNotices.collectAsState()
    // 主界面和设置页共用：设置页是盖在主界面上的不透明整屏，提示条只画在主界面上的话，
    // 用户在设置页里时账号被切走（设备列表、分享链接这些请求拿到 401 就会触发），
    // 页面内容直接换成另一个账号的、没有任何说明 —— 这时点「退出登录」「移除设备」
    // 作用在的是另一个账号上。
    val signedOutBanners: @Composable () -> Unit = {
        for (notice in signedOutNotices) {
            SignedOutNoticeBanner(
                notice = notice,
                currentEmail = p.email.ifBlank { p.displayName ?: p.userId },
                onSignInAgain = {
                    // 登录页的服务器地址预填成被登出的那个账号的服务器。
                    // 提示不在这里收：重新登回那个账号时 ProfileStore.save 会收掉；
                    // 进了登录页又点「取消」回来，提示还得在。
                    ProfileStore.rememberServerUrl(notice.serverUrl)
                    onAddAccount()
                },
                onDismiss = { ProfileStore.dismissSignedOutNotice(notice.profileId) },
            )
        }
    }
    // Observe locale so the anchor label (date formatters + agenda range)
    // and the inline "up to date" dialog re-render on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val anchorLabel = remember(locale, ui.mode, ui.anchor, deviceZone) { anchorLabelFor(ui.mode, ui.anchor) }

    // 整屏宽度决定顶栏和侧栏的形态。窗口最小宽度是 960dp(见 Main.kt),
    // 在那个宽度上顶栏原样排会溢出——Row 溢出是静默裁剪,被切掉的正好是
    // 排在最后的设置/刷新/搜索三个图标,用户会以为设置入口没了。
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val compact = maxWidth < 1180.dp
        // 侧栏在窄窗口收窄而不是消失:账号切换器和日历色卡都在里面,整块拿掉
        // 用户就没法切账号了。
        val sidebarWidth = if (compact) 224.dp else 256.dp
        var hiddenCalendars by remember(p.deviceId) { mutableStateOf(emptySet<String>()) }
        val displayedEvents = remember(ui.events, hiddenCalendars) { ui.events.filterNot { it.calendarId in hiddenCalendars } }

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
                invitationPending = invitationPending,
                onOpenInvitations = { showInvitations = true },
                onOpenShoppingLists = { shoppingInitialListId = null; showShoppingLists = true },
                onOpenImport = { pickIcsFile()?.let { importFile = it } },
                // Settings page hosts sign-out + all account / security /
                // appearance / about controls. Previously the toolbar had
                // its own Logout icon — removed in favor of the Settings
                // path so a misclick can't drop the active profile.
                onOpenSettings = { settingsEditCalendarId = null; settingsCreateCalendar = false; showSettings = true },
            )
            HorizontalDivider()

            // 另一个账号被服务端登出了、本机切到了这个账号。放在最上面、用醒目的
            // 颜色、要用户自己点掉 —— 以前是静默切走,用户以为自己还在原来那个
            // 账号里,看着的却是另一个账号的日历。
            signedOutBanners()

            // Staged-update banner (re-added in v0.8; a minimal banner was
            // removed in v0.7.3). Non-blocking: a new version has already
            // downloaded in the background and will apply on quit. We offer
            // an immediate "立即重启" plus a "×" to hide the bar for this
            // session (the update still applies on quit regardless).
            val stagedFile = staged
            if (stagedFile != null && !bannerDismissed) {
                StagedUpdateBanner(
                    versionName = updateInfo?.versionName,
                    onRestartNow = {
                        UpdateInstaller.staged.value?.let { file ->
                            scope.launch(kotlinx.coroutines.Dispatchers.IO) { UpdateInstaller.install(file) }
                        }
                    },
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
                    anchor = ui.anchor,
                    onDaySelect = { state.jumpToDay(it) },
                    hiddenCalendars = hiddenCalendars,
                    onCalendarToggle = { id -> hiddenCalendars = if (id in hiddenCalendars) hiddenCalendars - id else hiddenCalendars + id },
                    onEditCalendar = { cal ->
                        settingsEditCalendarId = cal.id
                        settingsCreateCalendar = false
                        showSettings = true
                    },
                    onNewCalendar = {
                        settingsEditCalendarId = null
                        settingsCreateCalendar = true
                        showSettings = true
                    },
                )
                Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(start = 8.dp, top = 14.dp, end = 18.dp, bottom = 18.dp).clip(RoundedCornerShape(20.dp)).background(MaterialTheme.colorScheme.surface)) {
                    androidx.compose.runtime.key(deviceZone.id) {
                    Crossfade(targetState = ui.mode, animationSpec = tween(160), label = "calendar-view") { visibleMode ->
                    when (visibleMode) {
                        ViewMode.Day -> DayView(
                            anchor = ui.anchor,
                            events = displayedEvents,
                            calendars = ui.calendars,
                            loading = ui.loading,
                            onEventClick = { state.openDetail(it) },
                            onEventEdit = { state.openEdit(it) },
                            onEventDuplicate = { state.openDuplicate(it) },
                            onEventDelete = { state.delete(it) },
                        )
                        ViewMode.Week -> WeekView(
                            weekStart = startOfWeek(ui.anchor),
                            events = displayedEvents,
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
                            events = displayedEvents,
                            calendars = ui.calendars,
                            onDayClick = { state.jumpToDay(it) },
                            onEventClick = { state.openDetail(it) },
                            onEventEdit = { state.openEdit(it) },
                            onEventDuplicate = { state.openDuplicate(it) },
                            onEventDelete = { state.delete(it) },
                        )
                        ViewMode.Agenda -> AgendaView(
                            anchor = ui.anchor,
                            events = displayedEvents,
                            calendars = ui.calendars,
                            loading = ui.loading,
                            onEventClick = { state.openDetail(it) },
                            onEventEdit = { state.openEdit(it) },
                            onEventDuplicate = { state.openDuplicate(it) },
                            onEventDelete = { state.delete(it) },
                        )
                    }
                    }
                    }
                    Column(modifier = Modifier.fillMaxWidth()) {
                        if (ui.error != null) {
                            ErrorBanner(message = ui.error!!, onRetry = { state.load() })
                        }
                        // 删除 / 拖动改时间 / 撤销删除失败。这几条路上没有弹窗,
                        // 以前失败写进 formError(只有编辑弹窗会画它),等于没写。
                        ui.actionError?.let { msg ->
                            ActionErrorBanner(message = msg, onDismiss = { state.dismissActionError() })
                        }
                        // 离线队列指示：有没送出去的改动就亮一条，
                        // 待处理（被服务端拒绝、要用户裁决）优先。
                        if (ui.pendingOps.isNotEmpty()) {
                            PendingSyncBanner(
                                pendingCount = ui.pendingOps.count {
                                    it.state == cn.bywave.calendar.sync.PendingOpState.PENDING
                                },
                                attentionCount = ui.pendingOps.count {
                                    it.state == cn.bywave.calendar.sync.PendingOpState.ATTENTION
                                },
                                onClick = { showOfflineQueue = true },
                            )
                        }
                    }
                    ui.undoDelete?.let { undo ->
                        UndoDeleteSnackbar(
                            undo = undo,
                            onUndo = { state.undoLastDelete() },
                            onTimeout = { state.dismissUndoDelete(undo.token) },
                            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
                        )
                    }
                    ui.createdNotice?.let { notice ->
                        CreatedNoticeSnackbar(
                            notice = notice,
                            onOpen = { state.openCreatedNotice() },
                            onUndo = { state.undoQuickSave() },
                            onTimeout = { state.dismissCreatedNotice(notice.token) },
                            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
                        )
                    }
                }
            }
        }
    }

    if (showOfflineQueue) {
        OfflineQueueDialog(
            ops = ui.pendingOps,
            onResolve = { opId, resolution -> state.resolveAttention(opId, resolution) },
            onDismiss = { showOfflineQueue = false },
        )
    }

    // ---- Sheets / dialogs ----
    when (val sheet = ui.activeSheet) {
        is ActiveSheet.Detail -> EventDetailDialog(
            event = sheet.event,
            pendingSync = ui.pendingSyncIds.contains(sheet.event.id),
            calendars = ui.calendars,
            attendees = ui.detailAttendees?.takeIf { ui.detailAttendeesFor == sheet.event.id },
            onDecideProposal = { proposal, accept -> state.decideProposal(proposal, accept) },
            onDismiss = { state.closeSheet() },
            onEdit = { state.openEdit(it) },
            onRefresh = { state.refreshIfIdle() },
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
            onQuickSaveDispatched = { state.armQuickSaveNotice() },
            onLocalAddressSuggestions = { q, title -> state.localAddressSuggestions(q, title) },
            onOnlineAddressSuggestions = { state.onlineAddressSuggestions(it) },
            onSuggestionPicked = { address, online ->
                if (online != null) state.learnOnlineSuggestion(online) else state.noteAddressPicked(address)
            },
            shoppingClient = client,
            onCheckConflicts = { calId, startsAt, endsAt, excludeId ->
                state.checkConflicts(calId, startsAt, endsAt, excludeId)
            },
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
            shoppingClient = client,
            onCheckConflicts = { calId, startsAt, endsAt, excludeId ->
                state.checkConflicts(calId, startsAt, endsAt, excludeId)
            },
            onLocalAddressSuggestions = { q, title -> state.localAddressSuggestions(q, title) },
            onOnlineAddressSuggestions = { state.onlineAddressSuggestions(it) },
            onSuggestionPicked = { address, online ->
                if (online != null) state.learnOnlineSuggestion(online) else state.noteAddressPicked(address)
            },
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
            shoppingClient = client,
            onCheckConflicts = { calId, startsAt, endsAt, excludeId ->
                state.checkConflicts(calId, startsAt, endsAt, excludeId)
            },
            onLocalAddressSuggestions = { q, title -> state.localAddressSuggestions(q, title) },
            onOnlineAddressSuggestions = { state.onlineAddressSuggestions(it) },
            onSuggestionPicked = { address, online ->
                if (online != null) state.learnOnlineSuggestion(online) else state.noteAddressPicked(address)
            },
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
    // Confirmation for plain (non-recurring) deletes. Recurring ones
    // confirm through the scope picker above; plain ones used to fire
    // immediately with only the 5-second undo bar as a net, while
    // Android / iOS ask first AND offer undo. The undo bar still
    // follows a confirmed delete.
    if (ui.pendingConfirmDelete != null) {
        val pendingDelete = ui.pendingConfirmDelete!!
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { state.resolveConfirmDelete(false) },
            title = {
                androidx.compose.material3.Text(
                    cn.bywave.calendar.desktop.i18n.I18n.t("event.deleteConfirmTitle"),
                )
            },
            text = {
                androidx.compose.material3.Text(
                    cn.bywave.calendar.desktop.i18n.I18n.t(
                        "event.deleteConfirmMessage",
                        mapOf("name" to pendingDelete.summary),
                    ),
                )
            },
            confirmButton = {
                androidx.compose.material3.Button(
                    onClick = { state.resolveConfirmDelete(true) },
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) {
                    androidx.compose.material3.Text(
                        cn.bywave.calendar.desktop.i18n.I18n.t("event.detail.delete"),
                    )
                }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(
                    onClick = { state.resolveConfirmDelete(false) },
                ) {
                    androidx.compose.material3.Text(
                        cn.bywave.calendar.desktop.i18n.I18n.t("common.cancel"),
                    )
                }
            },
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
            profile = p,
            // Local search corpus: the events this window currently
            // holds. The dialog filters them instantly and falls back
            // to them (labelled local-only) when the server is
            // unreachable — the Android search shape.
            localEvents = ui.events,
            calendars = ui.calendars,
            onOpenResult = { event, day, needsHydration ->
                state.jumpToDay(day)
                state.openDetailFromSearch(event, needsHydration)
                showSearch = false
            },
            onDismiss = { showSearch = false },
        )
    }

    // Invitations addressed to me — list + respond dialog, opened from
    // the toolbar envelope. Closing it refreshes the toolbar badge.
    if (showInvitations) {
        val c = client
        if (c != null) {
            InvitationsDialog(
                client = c,
                onDismiss = {
                    showInvitations = false
                    scope.launch { refreshInvitationBadge(c) }
                },
            )
        }
    }

    // 购买清单 — 顶栏购物车打开。与邀请对话框一样用主 client（绑定
    // 当前账号），关掉即销毁内部状态。
    if (showShoppingLists) {
        val c = client
        if (c != null) {
            ShoppingListsDialog(
                client = c,
                initialListId = shoppingInitialListId,
                onDismiss = { showShoppingLists = false },
            )
        }
    }

    // ICS import confirmation — the file was picked with the native
    // file dialog from the toolbar. A successful import reloads the
    // events fetch so the imported events (and the calendar list)
    // flow into the views, same as after a Settings calendar change.
    importFile?.let { file ->
        ImportIcsDialog(
            profile = p,
            file = file,
            calendars = ui.calendars,
            onImported = {
                importFile = null
                state.load()
            },
            onDismiss = { importFile = null },
        )
    }

    // Settings page — rendered as a full-screen overlay on top of the
    // calendar. Hosts account / calendars / security / appearance /
    // about. Sign-out, profile switch, and "+ add account" all bubble
    // back up to the same ProfileStore callbacks the toolbar used to
    // wire directly.
    if (showSettings) {
        SettingsOverlay(profile = p, banners = signedOutBanners) {
            SettingsScreen(
                profile = p,
                profiles = profiles,
                calendars = ui.calendars,
                onClose = { showSettings = false; settingsEditCalendarId = null; settingsCreateCalendar = false },
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
                    scope.launch { UpdateChecker.forceCheck(url, p.deviceId) }
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
                initialCalendarsEditId = settingsEditCalendarId,
                initialCalendarsCreate = settingsCreateCalendar,
            )
        }
    }
}

/**
 * 设置页这一整层：上面是被登出提示条，下面是设置页本体。
 *
 * 1. 整层铺一个 Surface。Material3 的 Surface 会接住落在它范围里的所有鼠标事件；
 *    以前外面套的是 Column，提示条又画在 SettingsScreen 自己的 Surface 之外 ——
 *    提示条上的文字和留白不接点击，点下去穿透到压在下面的主界面顶栏，正好是
 *    「今天」「新建」、视图切换那一排按钮，鼠标停在上面还会冒出它们的悬浮提示。
 *
 * 2. 设置页按账号整页重建。设置里的设备列表、预约链接、分享链接都是进页面拉一次、
 *    之后只在手动刷新时重拉；账号在设置页开着的时候换了（另一个账号被登出自动切走，
 *    或者在这里点了切换），页面上留的还是上一个账号的列表，开着的子对话框点下去却
 *    作用在新账号上。认的是 deviceId + serverUrl（和 MainScreen 里 ApiClient 的
 *    key 一致），不是整个 Profile：换票会换掉 refreshToken，按整个对象认的话，
 *    每次后台换票都会把用户在设置里正填着的表单清空。
 */
@Composable
internal fun SettingsOverlay(
    profile: cn.bywave.calendar.desktop.data.model.Profile,
    banners: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            banners()
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                key(profile.deviceId, profile.serverUrl) {
                    content()
                }
            }
        }
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
    invitationPending: Int,
    onOpenInvitations: () -> Unit,
    onOpenShoppingLists: () -> Unit,
    onOpenImport: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    // Collect locale so this whole TopBar re-renders when the user
    // switches language in Settings. Cheap; rebuilds the (small) row.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(80.dp)
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {

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
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))

        Row(
            modifier = Modifier.clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            ViewMode.entries.forEach { option ->
                androidx.compose.material3.TextButton(
                    onClick = { onModeChange(option) },
                    shape = RoundedCornerShape(9.dp),
                    colors = ButtonDefaults.textButtonColors(
                        containerColor = if (mode == option) MaterialTheme.colorScheme.surface else Color.Transparent,
                        contentColor = if (mode == option) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    ),
                    modifier = Modifier.height(36.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp),
                ) { Text(t(viewModeKey(option)), fontWeight = if (mode == option) FontWeight.SemiBold else FontWeight.Normal) }
            }
        }
        Spacer(Modifier.width(12.dp))

        WithTooltip(t("topbar.new"), "N") {
            Button(onClick = onNew, shape = RoundedCornerShape(12.dp), modifier = Modifier.height(40.dp)) {
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
                Icon(Icons.Outlined.Search, contentDescription = t("topbar.search"))
            }
        }
        // Invitations addressed to me — badge counts the ones still
        // awaiting my reply (same definition as Android / iOS).
        WithTooltip(t("invitations.title")) {
            IconButton(onClick = onOpenInvitations) {
                androidx.compose.material3.BadgedBox(
                    badge = {
                        if (invitationPending > 0) {
                            androidx.compose.material3.Badge { Text(invitationPending.toString()) }
                        }
                    },
                ) {
                    Icon(Icons.Outlined.Email, contentDescription = t("invitations.title"))
                }
            }
        }
        // 购买清单 — 与邀请 / 搜索同一排的顶栏入口。
        WithTooltip(t("shopping.title")) {
            IconButton(onClick = onOpenShoppingLists) {
                Icon(Icons.Outlined.ShoppingCart, contentDescription = t("shopping.title"))
            }
        }
        WithTooltip(t("import.title"), "I") {
            IconButton(onClick = onOpenImport) {
                Icon(Icons.Outlined.FileUpload, contentDescription = t("import.title"))
            }
        }
        WithTooltip(t("topbar.refresh"), "R") {
            IconButton(onClick = onRefresh, enabled = !loading) {
                if (loading) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(Icons.Outlined.Refresh, contentDescription = t("topbar.refresh"))
            }
        }
        // Settings (Cmd+,) — primary entry to the Settings page. Logout
        // is still accessible there but no longer pollutes the toolbar
        // (a misclick used to drop the active profile with no confirm).
        WithTooltip(t("topbar.settings"), ",") {
            IconButton(onClick = onOpenSettings) {
                Icon(Icons.Outlined.Settings, contentDescription = t("topbar.settings"))
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
    anchor: java.time.LocalDate,
    onDaySelect: (java.time.LocalDate) -> Unit,
    hiddenCalendars: Set<String>,
    onCalendarToggle: (String) -> Unit,
    onEditCalendar: (cn.bywave.calendar.desktop.data.model.CalendarMeta) -> Unit,
    onNewCalendar: () -> Unit,
) {
    // Observe locale so the section header + empty state re-render on switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    Column(
        modifier = Modifier
            .width(width)
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp, vertical = 20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BrandMark(44.dp)
            Column {
                Text("ByWave", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Text(t("app.name"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(28.dp))
        ProfileSwitcher(
            active = active,
            profiles = profiles,
            onSelect = onProfileSelect,
            onAddAccount = onAddAccount,
            onRemove = onProfileRemove,
        )
        Spacer(Modifier.height(24.dp))
        MiniCalendar(anchor, onDaySelect)
        Spacer(Modifier.height(28.dp))
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
                    Row(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onCalendarToggle(cal.id) }.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = cal.id !in hiddenCalendars, onCheckedChange = { onCalendarToggle(cal.id) }, colors = androidx.compose.material3.CheckboxDefaults.colors(checkedColor = parseHex(cal.color)), modifier = Modifier.size(32.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(
                            cal.name,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        // Direct edit entry — the web sidebar's calendar
                        // menu opens the properties editor in one click;
                        // here the only path used to be gear → Calendars
                        // tab → find the row → pencil. The button opens
                        // Settings pre-landed on that calendar's editor.
                        IconButton(
                            onClick = { onEditCalendar(cal) },
                            modifier = Modifier.size(28.dp),
                        ) {
                            Icon(
                                Icons.Default.Edit,
                                contentDescription = t("settings.calendars.edit"),
                                modifier = Modifier.size(15.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }

        // Direct "new calendar" entry under the calendar list — creating
        // used to require gear → Settings → Calendars tab → "+ New
        // calendar"; this lands on that same create dialog in one click,
        // mirroring the per-row edit pencil above and the web sidebar's
        // "+" menu. Shown even when the list is empty (first calendar).
        Row(
            modifier = Modifier
                .padding(horizontal = 10.dp, vertical = 4.dp)
                .clip(RoundedCornerShape(10.dp))
                .clickable { onNewCalendar() }
                .padding(vertical = 6.dp, horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.Add,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.width(8.dp))
            Text(
                t("settings.calendars.new"),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun MiniCalendar(anchor: java.time.LocalDate, onSelect: (java.time.LocalDate) -> Unit) {
    val zone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()
    val today = java.time.LocalDate.now(zone)
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    var month by remember(anchor.month, anchor.year) { mutableStateOf(java.time.YearMonth.from(anchor)) }
    val t = cn.bywave.calendar.desktop.i18n.I18n
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(formatMonthAnchor(month.atDay(1)), modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            IconButton(onClick = { month = month.minusMonths(1) }, modifier = Modifier.size(28.dp)) { Icon(Icons.Default.ChevronLeft, t.t("topbar.prevMonth"), Modifier.size(18.dp)) }
            IconButton(onClick = { month = month.plusMonths(1) }, modifier = Modifier.size(28.dp)) { Icon(Icons.Default.ChevronRight, t.t("topbar.nextMonth"), Modifier.size(18.dp)) }
        }
        Spacer(Modifier.height(10.dp))
        Row {
            (1..7).forEach { day -> Box(Modifier.weight(1f).height(24.dp), contentAlignment = Alignment.Center) { Text(t.t("weekday.short.$day"), fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        }
        val days = cn.bywave.calendar.desktop.ui.calendar.monthGridDays(month)
        days.chunked(7).forEach { week ->
            Row {
                week.forEach { day ->
                    val selected = day == anchor
                    val bg by animateColorAsState(if (selected) MaterialTheme.colorScheme.primary else Color.Transparent, tween(120), label = "selected-date")
                    Box(Modifier.weight(1f).aspectRatio(1f).padding(1.dp).clip(CircleShape).background(bg).clickable(role = androidx.compose.ui.semantics.Role.Button) { onSelect(day) }, contentAlignment = Alignment.Center) {
                        Text(day.dayOfMonth.toString(), fontSize = 11.sp, fontWeight = if (day == today || selected) FontWeight.Bold else FontWeight.Normal,
                            color = when { selected -> MaterialTheme.colorScheme.onPrimary; day == today -> MaterialTheme.colorScheme.primary; day.month != month.month -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .45f); else -> MaterialTheme.colorScheme.onSurface })
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

/** 弹窗外的操作（删除 / 拖动改时间 / 撤销删除）失败的提示条。不自动消失：
 *  这是「你刚才那一下没成」，一闪而过就又回到了「什么都没发生」。 */
@Composable
private fun ActionErrorBanner(message: String, onDismiss: () -> Unit) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))
        IconButton(onClick = onDismiss) {
            Icon(
                Icons.Default.Close,
                contentDescription = remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("event.detail.close") },
                tint = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/** 「某账号已被登出，现在显示的是另一个账号」。醒目、可关闭，带「重新登录」。 */
@Composable
private fun SignedOutNoticeBanner(
    notice: cn.bywave.calendar.desktop.data.auth.SignedOutNotice,
    currentEmail: String,
    onSignInAgain: () -> Unit,
    onDismiss: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    // 存的是邮箱 + key，这里才翻译：提示挂着的时候用户切了语言也跟得上。
    val message = remember(locale, notice, currentEmail) {
        cn.bywave.calendar.desktop.i18n.I18n.t(
            "auth.otherAccountSignedOut",
            mapOf("email" to notice.email, "current" to currentEmail),
        )
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.AutoMirrored.Filled.Logout,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.width(10.dp))
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))
        TextButton(onClick = onSignInAgain) {
            Text(remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("auth.signInAgain") })
        }
        IconButton(onClick = onDismiss) {
            Icon(
                Icons.Default.Close,
                contentDescription = remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("event.detail.close") },
                tint = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.size(18.dp),
            )
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

/** 「已创建：X」反馈条 — 一句话直接保存成功后出现，5 秒自动消失。
 *  「打开」弹这个事件的详情，「撤销」把它删掉（删除本身再给一条
 *  可恢复的撤销条）。与 UndoDeleteSnackbar 同一形状。 */
@Composable
private fun CreatedNoticeSnackbar(
    notice: cn.bywave.calendar.desktop.ui.calendar.CreatedNotice,
    onOpen: () -> Unit,
    onUndo: () -> Unit,
    onTimeout: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    LaunchedEffect(notice.token) {
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
                remember(locale, notice) {
                    cn.bywave.calendar.desktop.i18n.I18n.t("created.notice", mapOf("name" to notice.event.summary))
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.width(12.dp))
            TextButton(onClick = onOpen) {
                Text(remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("created.open") })
            }
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
