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
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.ui.calendar.ActiveSheet
import cn.bywave.calendar.desktop.ui.calendar.CalendarState
import cn.bywave.calendar.desktop.ui.calendar.DayView
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

@Composable
fun MainScreen(
    onSignedOut: () -> Unit,
) {
    val profile by ProfileStore.profile.collectAsState()
    val p = profile

    val scope = rememberCoroutineScope()
    val state = remember(p?.serverUrl, p?.userId) {
        if (p == null) null else CalendarState(ApiClient(p.serverUrl), scope)
    }

    LaunchedEffect(state) { state?.load() }

    if (p == null || state == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val ui by state.ui.collectAsState()

    Column(modifier = Modifier.fillMaxSize()) {
        TopBar(
            mode = ui.mode,
            anchorLabel = anchorLabelFor(ui.mode, ui.anchor),
            loading = ui.loading,
            onModeChange = { state.setMode(it) },
            onPrev = { state.previous() },
            onToday = { state.today() },
            onNext = { state.next() },
            onRefresh = { state.load() },
            onNew = { state.openCreate() },
            onSignOut = {
                ProfileStore.clear()
                onSignedOut()
            },
        )
        HorizontalDivider()

        Row(modifier = Modifier.fillMaxSize()) {
            Sidebar(
                email = p.email,
                serverUrl = p.serverUrl,
                calendars = ui.calendars,
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
}

private fun anchorLabelFor(mode: ViewMode, anchor: java.time.LocalDate): String = when (mode) {
    ViewMode.Day -> formatDayAnchor(anchor)
    ViewMode.Week -> formatWeekAnchor(startOfWeek(anchor))
    ViewMode.Month -> formatMonthAnchor(anchor)
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
    onSignOut: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "ByWave Calendar",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.width(20.dp))

        IconButton(onClick = onPrev) {
            Icon(Icons.Default.ChevronLeft, contentDescription = prevLabel(mode))
        }
        OutlinedButton(onClick = onToday) { Text("今天") }
        IconButton(onClick = onNext) {
            Icon(Icons.Default.ChevronRight, contentDescription = nextLabel(mode))
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
                ) { Text(m.label) }
            }
        }

        Spacer(Modifier.width(16.dp))

        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
            )
            Spacer(Modifier.width(8.dp))
        }
        Button(onClick = onNew) {
            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text("新建")
        }
        Spacer(Modifier.width(4.dp))
        IconButton(onClick = onRefresh) {
            Icon(Icons.Default.Refresh, contentDescription = "刷新")
        }
        IconButton(onClick = onSignOut) {
            Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = "退出登录")
        }
    }
}

private fun prevLabel(mode: ViewMode): String = when (mode) {
    ViewMode.Day -> "前一天"
    ViewMode.Week -> "上一周"
    ViewMode.Month -> "上一月"
}

private fun nextLabel(mode: ViewMode): String = when (mode) {
    ViewMode.Day -> "后一天"
    ViewMode.Week -> "下一周"
    ViewMode.Month -> "下一月"
}

@Composable
private fun Sidebar(
    email: String,
    serverUrl: String,
    calendars: List<cn.bywave.calendar.desktop.data.model.CalendarMeta>,
) {
    Column(
        modifier = Modifier
            .width(260.dp)
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Text(
            email,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            serverUrl,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.outline,
        )
        Spacer(Modifier.height(20.dp))

        Text(
            "我的日历",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))

        if (calendars.isEmpty()) {
            Text(
                "暂无日历",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
        OutlinedButton(onClick = onRetry) { Text("重试") }
    }
}
