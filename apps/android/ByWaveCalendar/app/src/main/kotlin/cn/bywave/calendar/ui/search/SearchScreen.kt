// Global event search across the locally cached wide window. No
// server call — we already have ~15 months of events in Room, filter
// in-memory by case-insensitive substring on summary / description /
// location. Mirrors iOS SearchView.
//
// Sub-second on a few thousand events; if usage grows past that we'd
// move to FTS5 via Room. For v0.7 plain List.filter is plenty.

package cn.bywave.calendar.ui.search

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.calendar.calendarColor
import cn.bywave.calendar.ui.calendar.calendarName
import cn.bywave.calendar.ui.calendar.formatTimeRange
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.calendar.parseInstant
import cn.bywave.calendar.ui.components.EmptyState
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(
    onBack: () -> Unit,
    onEventClick: (EventDTO) -> Unit,
    vm: SearchViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    val focus = remember { FocusRequester() }
    val ime = LocalSoftwareKeyboardController.current

    // Auto-focus the search field when the screen opens — saves a tap.
    LaunchedEffect(Unit) {
        focus.requestFocus()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    OutlinedTextField(
                        value = state.query,
                        onValueChange = vm::onQuery,
                        placeholder = { Text(stringResource(R.string.search2_placeholder)) },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus),
                        trailingIcon = {
                            if (state.query.isNotEmpty()) {
                                IconButton(onClick = { vm.onQuery("") }) {
                                    Icon(Icons.Default.Clear, contentDescription = stringResource(R.string.search2_clear))
                                }
                            }
                        },
                        leadingIcon = {
                            Icon(Icons.Default.Search, contentDescription = null)
                        },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.search2_back))
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                state.query.isBlank() -> EmptyState(
                    icon = Icons.Default.Search,
                    title = stringResource(R.string.search2_empty_prompt_title),
                    subtitle = stringResource(R.string.search2_empty_prompt_subtitle),
                )
                state.results.isEmpty() -> EmptyState(
                    icon = Icons.Default.SearchOff,
                    title = stringResource(R.string.search2_no_results_title),
                    subtitle = stringResource(R.string.search2_no_results_subtitle),
                )
                else -> ResultsList(
                    results = state.results,
                    calendars = state.calendars,
                    onEventClick = { ev ->
                        ime?.hide()
                        onEventClick(ev)
                    },
                )
            }
        }
    }
}

@Composable
private fun ResultsList(
    results: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onEventClick: (EventDTO) -> Unit,
) {
    // Group by day for visual structure — sticky-header-style would
    // be nicer but adds API complexity; v0.7 just uses inline headers.
    val grouped = remember(results) {
        results.groupBy { dayKey(it) }
            .toSortedMap(compareByDescending { it })  // newest first
    }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        for ((day, items) in grouped) {
            item(key = "header-$day") {
                Text(
                    text = day,
                    style = MaterialTheme.typography.labelMedium,
                    color = mutedTextColor(),
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            items(items = items, key = { "${it.id}@${it.startsAt}" }) { ev ->
                ResultRow(event = ev, calendars = calendars, onClick = { onEventClick(ev) })
                HorizontalDivider()
            }
        }
        item { Spacer(Modifier.size(24.dp)) }
    }
}

@Composable
private fun ResultRow(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    onClick: () -> Unit,
) {
    val color = calendarColor(event, calendars)
    val cal = calendarName(event, calendars)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(color),
        )
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = event.summary,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = formatTimeRange(event),
                    style = MaterialTheme.typography.bodySmall,
                    color = mutedTextColor(),
                )
                if (!cal.isNullOrBlank()) {
                    Text(
                        text = " · $cal",
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                        maxLines = 1,
                    )
                }
            }
            if (!event.location.isNullOrBlank()) {
                Text(
                    text = event.location,
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                    maxLines = 1,
                )
            }
        }
    }
}

private val DAY_FMT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy 年 M 月 d 日 EEEE").withZone(ZoneId.systemDefault())

private fun dayKey(ev: EventDTO): String {
    val inst = parseInstant(ev.startsAt) ?: return "—"
    return DAY_FMT.format(inst)
}
