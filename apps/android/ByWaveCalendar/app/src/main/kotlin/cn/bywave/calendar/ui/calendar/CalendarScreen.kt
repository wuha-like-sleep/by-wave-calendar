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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
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
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.event.EventDetailSheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(
    onOpenSettings: () -> Unit,
    onCreateEvent: () -> Unit,
    onEditEvent: (EventDTO) -> Unit,
    vm: CalendarViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    var selectedEvent by remember { mutableStateOf<EventDTO?>(null) }

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
                    IconButton(onClick = { vm.reload() }, enabled = !state.loading) {
                        Icon(Icons.Default.Refresh, contentDescription = "刷新")
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
            onDayClick = { day ->
                vm.setMode(ViewMode.Day)
                vm.setAnchor(day)
            },
            eventsForDay = { vm.eventsForDay(it) },
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
                    )
                    ViewMode.Week -> WeekView(
                        weekStart = startOfWeek(state.anchor),
                        events = state.events,
                        calendars = state.calendars,
                        onEventClick = onEventClick,
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
