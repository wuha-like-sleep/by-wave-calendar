// Day view only for v0.1. Header bar with prev/today/next + a List of
// event rows. Pull-to-refresh and swipe-to-shift-day come later; we
// only ship arrow buttons + the Today button in v0.1.
//
// Loosely mirrors iOS CalendarView (day mode) + DayView. Material 3
// idioms instead of SwiftUI Form / NavigationStack.

package cn.bywave.calendar.ui.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(
    onSignOut: () -> Unit,
    vm: CalendarViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(stringResourceCal(R.string.calendar_title)) },
                navigationIcon = {
                    // v0.1: settings opens a confirm-sign-out dialog
                    // directly. Full settings page comes in v0.3.
                    IconButton(onClick = onSignOut) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
                actions = {
                    IconButton(onClick = { vm.load() }, enabled = !state.loading) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(),
            )
        },
    ) { innerPadding ->
        CalendarBody(
            state = state,
            eventsForDay = vm.eventsForAnchor(),
            innerPadding = innerPadding,
            onPrev = { vm.shiftAnchor(-1) },
            onNext = { vm.shiftAnchor(+1) },
            onToday = { vm.goToday() },
        )
    }
}

@Composable
private fun CalendarBody(
    state: CalendarUiState,
    eventsForDay: List<EventDTO>,
    innerPadding: PaddingValues,
    onPrev: () -> Unit,
    onNext: () -> Unit,
    onToday: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(innerPadding),
    ) {
        // Date navigation header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onPrev) {
                Icon(Icons.Default.ChevronLeft, contentDescription = "Previous day")
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onToday) {
                Text(
                    text = formatAnchor(state.anchor),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = onNext) {
                Icon(Icons.Default.ChevronRight, contentDescription = "Next day")
            }
        }

        // Sync status / error
        val statusText = when {
            state.loading -> stringResourceCal(R.string.calendar_syncing)
            state.errorMessage != null -> state.errorMessage
            else -> stringResourceCal(R.string.calendar_synced)
        }
        Text(
            text = statusText,
            style = MaterialTheme.typography.bodySmall,
            color = if (state.errorMessage != null) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )

        Spacer(Modifier.height(8.dp))

        // Events list
        when {
            state.loading && eventsForDay.isEmpty() -> {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            eventsForDay.isEmpty() -> {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        text = if (state.anchor == LocalDate.now())
                            stringResourceCal(R.string.calendar_no_events_today)
                        else stringResourceCal(R.string.calendar_no_events),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(items = eventsForDay, key = { "${it.id}@${it.startsAt}" }) { ev ->
                        EventRow(event = ev, calendars = state.calendars)
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}

@Composable
private fun EventRow(event: EventDTO, calendars: List<CalendarMeta>) {
    val calColor = remember(event.calendarId, calendars) {
        calendars.firstOrNull { it.id == event.calendarId }?.color?.let { parseHex(it) }
            ?: MaterialColor.fallback
    }
    val cal = calendars.firstOrNull { it.id == event.calendarId }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(calColor),
        )
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = event.summary,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
            )
            Text(
                text = formatTimeLine(event),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (cal != null) {
                Text(
                    text = cal.name,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// -- Helpers --

private object MaterialColor {
    val fallback: Color get() = Color(0xFF6640E9)
}

private fun parseHex(hex: String): Color {
    val cleaned = hex.removePrefix("#")
    return runCatching {
        val v = cleaned.toLong(16)
        Color(
            red = ((v shr 16) and 0xff) / 255f,
            green = ((v shr 8) and 0xff) / 255f,
            blue = (v and 0xff) / 255f,
        )
    }.getOrDefault(MaterialColor.fallback)
}

private val ANCHOR_FMT = DateTimeFormatter.ofPattern("yyyy 年 M 月 d 日 EEEE")
private fun formatAnchor(d: LocalDate): String = d.format(ANCHOR_FMT)

private val TIME_FMT = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
private fun formatTimeLine(ev: EventDTO): String {
    if (ev.allDay) return "全天"
    val s = runCatching { Instant.parse(ev.startsAt) }.getOrNull()
    val e = runCatching { Instant.parse(ev.endsAt) }.getOrNull()
    if (s == null || e == null) return ""
    return "${TIME_FMT.format(s)} – ${TIME_FMT.format(e)}"
}

/** Tiny re-export so we can keep the import block lean. */
@Composable
private fun stringResourceCal(@androidx.annotation.StringRes id: Int) =
    androidx.compose.ui.res.stringResource(id)
