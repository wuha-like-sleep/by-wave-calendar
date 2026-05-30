// Top-level calendar screen. View-mode tabs (Day/Week/Month) + nav
// bar (prev / today / next + refresh + settings) + FAB to create
// events. Event tap opens EventDetailSheet; "edit" from there →
// EventEditScreen; FAB → EventEditScreen in create mode.
//
// Navigation between detail sheet and edit screen / settings is owned
// by the parent (MainActivity NavHost) via callbacks; CalendarScreen
// stays declarative.

package cn.bywave.calendar.ui.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.ui.draw.clip
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.event.EventActionsSheet
import cn.bywave.calendar.ui.event.EventDetailSheet
import cn.bywave.calendar.ui.event.RecurringAction
import cn.bywave.calendar.ui.event.RecurringScope
import cn.bywave.calendar.ui.event.RecurringScopePicker
import cn.bywave.calendar.ui.profile.ProfileSwitcherDialog
import cn.bywave.calendar.ui.theme.MultiAccountGreen
import cn.bywave.calendar.ui.theme.Sizing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(
    onOpenSettings: () -> Unit,
    onCreateEvent: () -> Unit,
    onEditEvent: (EventDTO) -> Unit,
    onDuplicateEvent: (EventDTO) -> Unit,
    onOpenAttendees: (EventDTO) -> Unit,
    onAddAccount: () -> Unit,
    onOpenSearch: () -> Unit,
    vm: CalendarViewModel = viewModel(),
) {
    val profiles = remember { BywaveApp.instance.profiles }
    val profilesList by profiles.profiles.collectAsState()
    val activeId by profiles.activeId.collectAsState()
    val active = profilesList.firstOrNull { it.id == activeId }

    val state by vm.state.collectAsState()
    var selectedEvent by remember { mutableStateOf<EventDTO?>(null) }
    var actionsForEvent by remember { mutableStateOf<EventDTO?>(null) }
    var pendingDelete by remember { mutableStateOf<EventDTO?>(null) }
    // Separate state for "delete confirmed, but it's a recurring event,
    // need to ask which scope". The AlertDialog is intentionally still
    // shown for non-recurring events as a safety net; recurring events
    // skip the dialog and go straight to the scope picker since picking
    // a scope IS the confirmation.
    var pendingRecurringDelete by remember { mutableStateOf<EventDTO?>(null) }
    var showSwitcher by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("日历") },
                navigationIcon = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "设置")
                    }
                },
                actions = {
                    IconButton(onClick = onOpenSearch) {
                        Icon(Icons.Default.Search, contentDescription = "搜索")
                    }
                    IconButton(onClick = { vm.reload() }, enabled = !state.loading) {
                        Icon(Icons.Default.Refresh, contentDescription = "刷新")
                    }
                    // Avatar badge — opens the profile switcher. Shows
                    // a small green dot when there's more than one
                    // profile to hint the multi-account feature.
                    //
                    // The visible circle is 36dp, but we wrap it in a
                    // 48dp clickable IconButton-sized box so the touch
                    // target meets the accessibility minimum and the
                    // ripple reads like the other top-bar actions.
                    Box(
                        modifier = Modifier
                            .padding(end = 4.dp)
                            .size(Sizing.minTouchTarget)
                            .clip(CircleShape)
                            .clickable(
                                onClickLabel = "切换账号",
                            ) { showSwitcher = true },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(Sizing.avatar)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = active?.initial ?: "?",
                                color = MaterialTheme.colorScheme.onPrimary,
                                fontWeight = FontWeight.SemiBold,
                            )
                            if (profilesList.size > 1) {
                                Box(
                                    modifier = Modifier
                                        .align(Alignment.BottomEnd)
                                        .size(Sizing.calendarDotSmall)
                                        .clip(CircleShape)
                                        .background(MaterialTheme.colorScheme.surface),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(7.dp)
                                            .clip(CircleShape)
                                            .background(MultiAccountGreen),
                                    )
                                }
                            }
                        }
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onCreateEvent) {
                Icon(Icons.Default.Add, contentDescription = "新建事件")
            }
        },
    ) { innerPadding ->
        CalendarBody(
            state = state,
            innerPadding = innerPadding,
            onModeChange = vm::setMode,
            onPrev = { vm.shiftAnchor(-1) },
            onNext = { vm.shiftAnchor(+1) },
            onToday = { vm.goToday() },
            onEventClick = { selectedEvent = it },
            onEventLongPress = { actionsForEvent = it },
            onDayClick = { day ->
                vm.setMode(ViewMode.Day)
                vm.setAnchor(day)
            },
            eventsForDay = { vm.eventsForDay(it) },
        )
    }

    if (showSwitcher) {
        ProfileSwitcherDialog(
            profiles = profilesList,
            activeId = activeId,
            onPick = { p ->
                showSwitcher = false
                if (p.id != activeId) profiles.setActive(p.id)
            },
            onAddAccount = {
                showSwitcher = false
                onAddAccount()
            },
            onDismiss = { showSwitcher = false },
        )
    }

    val ev = selectedEvent
    if (ev != null) {
        EventDetailSheet(
            event = ev,
            calendars = state.calendars,
            onDismiss = { selectedEvent = null },
            onEdit = {
                selectedEvent = null
                onEditEvent(ev)
            },
            onOpenAttendees = {
                selectedEvent = null
                onOpenAttendees(ev)
            },
        )
    }

    val actionsEv = actionsForEvent
    if (actionsEv != null) {
        EventActionsSheet(
            event = actionsEv,
            calendars = state.calendars,
            onEdit = {
                actionsForEvent = null
                onEditEvent(actionsEv)
            },
            onDuplicate = {
                actionsForEvent = null
                onDuplicateEvent(actionsEv)
            },
            onDelete = {
                actionsForEvent = null
                // Recurring events route to the scope picker — without
                // it, the server defaults to "series" and wipes the
                // entire repeating set. Non-recurring events use the
                // simple confirm dialog.
                if (!actionsEv.rrule.isNullOrBlank()) {
                    pendingRecurringDelete = actionsEv
                } else {
                    pendingDelete = actionsEv
                }
            },
            onOpenAttendees = {
                actionsForEvent = null
                onOpenAttendees(actionsEv)
            },
            onDismiss = { actionsForEvent = null },
        )
    }

    val pd = pendingDelete
    if (pd != null) {
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除事件？") },
            text = { Text("「${pd.summary}」将被永久删除，此操作不可恢复。") },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    vm.deleteEvent(pd.id)
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            },
        )
    }

    // Recurring-event delete: bottom sheet with 仅此次 / 此后 / 整个系列.
    // The user's pick IS the confirmation — no separate AlertDialog
    // needed (the choice is destructive but explicit). Mirrors iOS
    // RecurringScopePicker + the web modal.
    val pdr = pendingRecurringDelete
    if (pdr != null) {
        RecurringScopePicker(
            action = RecurringAction.Delete,
            onPick = { scope ->
                // Server's `recurrenceId` is the original occurrence's
                // ISO startsAt — that's what the row carries. For
                // scope=series we still pass it (server ignores) so
                // the call site stays one shape.
                pendingRecurringDelete = null
                vm.deleteEvent(
                    id = pdr.id,
                    scope = scope.wire,
                    recurrenceId = pdr.startsAt,
                )
            },
            onDismiss = { pendingRecurringDelete = null },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CalendarBody(
    state: CalendarUiState,
    innerPadding: PaddingValues,
    onModeChange: (ViewMode) -> Unit,
    onPrev: () -> Unit,
    onNext: () -> Unit,
    onToday: () -> Unit,
    onEventClick: (EventDTO) -> Unit,
    onEventLongPress: (EventDTO) -> Unit,
    onDayClick: (java.time.LocalDate) -> Unit,
    eventsForDay: (java.time.LocalDate) -> List<EventDTO>,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(innerPadding),
    ) {
        // View mode tabs
        SingleChoiceSegmentedButtonRow(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            val options = listOf(ViewMode.Day to "日", ViewMode.Week to "周", ViewMode.Month to "月")
            options.forEachIndexed { index, (mode, label) ->
                SegmentedButton(
                    selected = state.mode == mode,
                    onClick = { onModeChange(mode) },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                ) { Text(label) }
            }
        }

        // Date navigation header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onPrev) {
                Icon(Icons.Default.ChevronLeft, contentDescription = "上一个")
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onToday) {
                Text(
                    text = formatAnchor(state.mode, state.anchor),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = onNext) {
                Icon(Icons.Default.ChevronRight, contentDescription = "下一个")
            }
        }

        val statusText = when {
            state.loading -> "同步中…"
            state.errorMessage != null -> state.errorMessage
            else -> "已同步"
        }
        Text(
            text = statusText,
            style = MaterialTheme.typography.bodySmall,
            color = if (state.errorMessage != null) MaterialTheme.colorScheme.error
                    else mutedTextColor(),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )

        Spacer(Modifier.size(4.dp))

        Box(modifier = Modifier.fillMaxSize().weight(1f)) {
            if (state.loading && state.events.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else {
                when (state.mode) {
                    ViewMode.Day -> DayView(
                        anchor = state.anchor,
                        events = eventsForDay(state.anchor),
                        calendars = state.calendars,
                        onEventClick = onEventClick,
                        onEventLongPress = onEventLongPress,
                    )
                    ViewMode.Week -> WeekView(
                        weekStart = startOfWeek(state.anchor),
                        events = state.events,
                        calendars = state.calendars,
                        onEventClick = onEventClick,
                        onEventLongPress = onEventLongPress,
                    )
                    ViewMode.Month -> MonthView(
                        anchor = state.anchor,
                        events = state.events,
                        calendars = state.calendars,
                        onDayClick = onDayClick,
                    )
                }
            }
        }
    }
}
