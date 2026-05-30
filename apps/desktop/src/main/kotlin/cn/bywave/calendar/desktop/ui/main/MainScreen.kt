// Main calendar screen — top toolbar + sidebar + current view.
//
// v0.4 adds a Day / Week / Month segmented switcher to the top bar.
// Clicking a date cell in Month view jumps to Day view at that date;
// clicking any event opens the EventDetailDialog (read-only, v0.5 adds
// edit + delete).
//
// Layout: Column { TopBar; Row { Sidebar (260dp); ActiveView (fillMax) } }

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.OutlinedButton
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
    val state = remember(p?.serverUrl, p?.userId) {
        if (p == null) null else CalendarState(ApiClient(p.serverUrl), scope)
    }

    LaunchedEffect(state) { state?.load() }

    // Event-reminder scheduler: polls the loaded events and fires a native
    // desktop notification `leadMinutes` before each event's start. Bound to
    // the current state's event flow; re-binds on profile switch. Lives as
    // long as the main screen (the whole session). Honors ReminderPrefs
    // (on/off + lead) read live each tick.
    LaunchedEffect(state) {
        val s = state ?: return@LaunchedEffect
        cn.bywave.calendar.desktop.data.notify.ReminderScheduler.run(s.ui)
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
                    // Esc precedence: search dialog, then Settings page,
                    // then any open sheet/dialog. The search dialog floats
                    // on top so it "owns" the keystroke when visible.
                    when {
                        showSearch -> showSearch = false
                        showSettings -> showSettings = false
                        else -> s.closeSheet()
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

    Column(modifier = Modifier.fillMaxSize()) {
        TopBar(
            mode = ui.mode,
            anchorLabel = anchorLabel,
            loading = ui.loading,
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
                        onEventClick = { state.openDetail(it) },
                        onEventEdit = { state.openEdit(it) },
                        onEventDuplicate = { state.openDuplicate(it) },
                        onEventDelete = { state.delete(it) },
                    )
                }
                if (ui.error != null) {
                    ErrorBanner(message = ui.error!!, onRetry = { state.load() })
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

@Composable
private fun TopBar(
    mode: ViewMode,
    anchorLabel: String,
    loading: Boolean,
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
        Text(
            t("app.name"),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.width(20.dp))

        IconButton(onClick = onPrev) {
            Icon(Icons.Default.ChevronLeft, contentDescription = prevLabel(mode, t))
        }
        OutlinedButton(onClick = onToday) { Text(t("topbar.today")) }
        IconButton(onClick = onNext) {
            Icon(Icons.Default.ChevronRight, contentDescription = nextLabel(mode, t))
        }

        Spacer(Modifier.width(12.dp))
        Text(anchorLabel, style = MaterialTheme.typography.titleSmall)

        Spacer(Modifier.weight(1f))

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
        Button(onClick = onNew) {
            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(t("topbar.new"))
        }
        Spacer(Modifier.width(4.dp))
        // Global search (Cmd/Ctrl+F) — opens the event search dialog.
        IconButton(onClick = onOpenSearch) {
            Icon(Icons.Default.Search, contentDescription = t("topbar.search"))
        }
        IconButton(onClick = onRefresh) {
            Icon(Icons.Default.Refresh, contentDescription = t("topbar.refresh"))
        }
        // Settings (Cmd+,) — primary entry to the Settings page. Logout
        // is still accessible there but no longer pollutes the toolbar
        // (a misclick used to drop the active profile with no confirm).
        IconButton(onClick = onOpenSettings) {
            Icon(Icons.Default.Settings, contentDescription = t("topbar.settings"))
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
            .width(260.dp)
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
                contentDescription = cn.bywave.calendar.desktop.i18n.I18n.t("settings.close"),
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}
