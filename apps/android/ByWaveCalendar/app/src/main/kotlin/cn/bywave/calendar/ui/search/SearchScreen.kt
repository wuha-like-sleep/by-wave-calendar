// Event search, local-first with a server fallback.
//
// Local: filter the Room cache (~15 months) in memory by
// case-insensitive substring on summary / description / location —
// instant and offline-capable.
// Server: when the local filter finds nothing (or the user taps
// "search all history"), SearchViewModel asks GET /api/v1/search —
// the same endpoint the web palette and iOS SearchView use — and the
// extra hits land in a separate "all history" section below, so the
// two scopes are never silently mixed. Offline, only local results
// show, with a hint saying so.

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
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.calendar.calendarColor
import cn.bywave.calendar.ui.calendar.calendarName
import cn.bywave.calendar.ui.calendar.eventTimeText
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.calendar.parseInstant
import cn.bywave.calendar.ui.calendar.rememberCalendarFormats
import cn.bywave.calendar.ui.calendar.toLocalDate
import cn.bywave.calendar.ui.components.EmptyState
import java.time.Instant
import java.time.LocalDate

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
                // 服务端还在查的时候不算「没有结果」—— 空状态要等两边都查完。
                state.results.isEmpty() && state.serverResults.isEmpty() && !state.serverLoading -> EmptyState(
                    icon = Icons.Default.SearchOff,
                    title = stringResource(R.string.search2_no_results_title),
                    subtitle = if (state.offline) stringResource(R.string.search2_offline_hint)
                               else stringResource(R.string.search2_no_results_subtitle),
                )
                else -> ResultsList(
                    results = state.results,
                    serverResults = state.serverResults,
                    calendars = state.calendars,
                    serverLoading = state.serverLoading,
                    serverDone = state.serverDone,
                    offline = state.offline,
                    onSearchAllHistory = vm::searchAllHistory,
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
    serverResults: List<EventDTO>,
    calendars: List<CalendarMeta>,
    serverLoading: Boolean,
    serverDone: Boolean,
    offline: Boolean,
    onSearchAllHistory: () -> Unit,
    onEventClick: (EventDTO) -> Unit,
) {
    val formats = rememberCalendarFormats()
    // 按天分组。注意这里必须先按 LocalDate 分组、再拿日期排序，最后才格式化：
    // 之前是直接 groupBy(格式化后的字符串) 然后按字符串倒序，而
    // 「2026 年 10 月 1 日」和「2026 年 2 月 1 日」按字符串比大小是 "1" < "2"，
    // 于是 10 月的结果排到了 2 月后面——跨月搜索时间线整个是乱的。
    // 换成本地化格式之后（英文的 Oct / Feb）只会更乱。
    val grouped = remember(results) {
        results.groupBy { toLocalDate(parseInstant(it.startsAt)) }
            .toSortedMap(compareByDescending { it ?: LocalDate.MIN })  // 最近的在上面
    }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        if (offline) {
            item(key = "offline-hint") {
                Text(
                    text = stringResource(R.string.search2_offline_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = mutedTextColor(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
        for ((day, items) in grouped) {
            // 解析不出时间的事件仍然成组显示，不让它整块消失。
            val header = day?.let { formats.dayHeader.format(it) } ?: "—"
            item(key = "header-${day ?: "unknown"}") {
                Text(
                    text = header,
                    style = MaterialTheme.typography.labelMedium,
                    color = mutedTextColor(),
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            items(items = items, key = { "${it.id}@${it.startsAt}" }) { ev ->
                Column(Modifier.animateItem()) {
                    ResultRow(event = ev, calendars = calendars, onClick = { onEventClick(ev) })
                    HorizontalDivider()
                }
            }
        }
        // ---- 服务端「全部历史」区段：和本地结果分开标明范围，不混排 ----
        if (serverResults.isNotEmpty()) {
            item(key = "server-header") {
                Text(
                    text = stringResource(R.string.search2_server_section),
                    style = MaterialTheme.typography.labelMedium,
                    color = mutedTextColor(),
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            items(items = serverResults, key = { "server-${it.id}@${it.startsAt}" }) { ev ->
                Column(Modifier.animateItem()) {
                    ServerResultRow(event = ev, calendars = calendars, onClick = { onEventClick(ev) })
                    HorizontalDivider()
                }
            }
        }
        if (serverLoading) {
            item(key = "server-loading") {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(12.dp))
                    Text(
                        text = stringResource(R.string.search2_server_searching),
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                    )
                }
            }
        } else if (!serverDone && results.isNotEmpty()) {
            // 本地有结果时不自动打扰服务器，把「查全部历史」留给用户点。
            // （本地没结果的那种情况 ViewModel 已经自动问过服务器了。）
            item(key = "server-more") {
                Text(
                    text = stringResource(R.string.search2_server_more),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(onClick = onSearchAllHistory)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
        }
        item { Spacer(Modifier.size(24.dp)) }
    }
}

/** 服务端结果行：重复事件显示「下一次发生」的时间（服务端给的
 *  nextStartsAt），整段平移、时长不变。点击打开的仍然是原始那条 ——
 *  显示用的副本只改展示时间，主事件的 startsAt 不能被它污染。 */
@Composable
private fun ServerResultRow(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    onClick: () -> Unit,
) {
    val display = remember(event) {
        val next = event.nextStartsAt ?: return@remember event
        val start = parseInstant(event.startsAt) ?: return@remember event
        val end = parseInstant(event.endsAt) ?: return@remember event
        val nextInstant = parseInstant(next) ?: return@remember event
        event.copy(
            startsAt = next,
            endsAt = Instant.ofEpochMilli(end.toEpochMilli() + (nextInstant.toEpochMilli() - start.toEpochMilli())).toString(),
        )
    }
    ResultRow(event = display, calendars = calendars, onClick = onClick)
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
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = eventTimeText(event),
                    style = MaterialTheme.typography.bodySmall,
                    color = mutedTextColor(),
                )
                if (!cal.isNullOrBlank()) {
                    // weight(fill = false) 让日历名只占它需要的宽度，但超出时
                    // 会被压缩并加省略号。之前它在 Row 里没有任何宽度约束，
                    // 长日历名（「市场部 2026 上半年排期」）直接被切在屏幕外，
                    // 连省略号都没有。
                    Text(
                        text = " · $cal",
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
            }
            if (!event.location.isNullOrBlank()) {
                Text(
                    text = event.location,
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

