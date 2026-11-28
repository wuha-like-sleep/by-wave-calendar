// Global event search dialog. Reachable from the toolbar magnifier icon
// or Cmd/Ctrl+F. Mirrors the web Cmd+K palette and iOS SearchView, with
// the same local-first + server-fallback shape Android's search uses:
//
//   - Local: the events CalendarState currently holds (the loaded window
//     and its disk snapshots) are filtered in memory — instant, and it
//     works offline. The needle matches summary / description / location,
//     case-insensitively, exactly like Android's local filter. This
//     corpus is much smaller than Android's ~15-month Room cache, which
//     is why the server part below matters more here.
//   - Server: GET /api/v1/search?q=…&limit=100 on a short debounce
//     (300ms), matching across every calendar the user can see and all
//     history. Hits that aren't already shown locally land in a separate
//     section headed "全部历史（服务器）" so the scope of each group is
//     explicit. A failed call keeps the local results and flags the
//     dialog offline ("连不上服务器，仅显示本地结果") instead of
//     replacing them with an error.
//   - Clicking a result jumps the calendar to that event's local date
//     via CalendarState.jumpToDay() AND opens the event's detail dialog
//     over it (CalendarState.openDetailFromSearch) — the day jump alone
//     left the user hunting for the event in the day view. Local hits
//     open their full DTO directly; server hits open a promoted stub
//     that CalendarState hydrates from GET /events/{id}.
//
// The search response is a lighter shape than EventDTO (no description /
// extra), which is fine here. Local EventDTOs are converted into the same
// row shape for rendering, keeping the source DTO alongside for the tap.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.SearchResultDTO
import cn.bywave.calendar.desktop.data.model.toEventDTO
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import cn.bywave.calendar.desktop.ui.theme.Dimens
import cn.bywave.calendar.desktop.ui.theme.hoverHighlight
import cn.bywave.calendar.desktop.ui.theme.rowShape
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Local time formatter for a result row — shows the event's start in the
 *  user's local zone (the server returns ISO8601 with offset). Falls back
 *  to the raw string if parsing fails (defensive, never crash a row). */
@Composable
internal fun resultTimeLabel(iso: String, displayZone: ZoneId): String {
    val formatter = remember(displayZone) {
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(displayZone)
    }
    return cn.bywave.calendar.desktop.ui.calendar.parseInstant(iso)?.let(formatter::format) ?: iso
}

/** Convert a locally held event into the shared result-row shape,
 *  resolving the calendar name / colour from the loaded calendar list. */
private fun EventDTO.toSearchRow(calendars: List<CalendarMeta>): SearchResultDTO {
    val cal = calendars.firstOrNull { it.id == calendarId }
    return SearchResultDTO(
        id = id,
        calendarId = calendarId,
        calendarName = cal?.name,
        calendarColor = cal?.color,
        summary = summary,
        location = location,
        startsAt = startsAt,
        endsAt = endsAt,
        allDay = allDay,
        rrule = rrule,
    )
}

/** Android-parity local filter: summary / description / location,
 *  case-insensitive substring. */
private fun EventDTO.matchesLocal(needleLower: String): Boolean =
    summary.lowercase().contains(needleLower) ||
        (description ?: "").lowercase().contains(needleLower) ||
        (location ?: "").lowercase().contains(needleLower)

/**
 * Search dialog.
 *
 * @param profile the account to search in (a short-lived ApiClient bound to it,
 *   same one-shot pattern the Settings dialogs use).
 * @param localEvents events the main window currently holds — the local
 *   search corpus (loaded window + restored snapshots).
 * @param calendars the account's calendars, for local rows' name/colour.
 * @param onOpenResult called with the chosen result promoted to an
 *   EventDTO, its local date, and whether the DTO is a partial server
 *   stub that still needs hydrating — the caller wires this to
 *   CalendarState.jumpToDay() + openDetailFromSearch() then closes the
 *   dialog.
 * @param onDismiss close without navigating.
 */
@Composable
fun SearchDialog(
    profile: cn.bywave.calendar.desktop.data.model.Profile,
    localEvents: List<EventDTO> = emptyList(),
    calendars: List<CalendarMeta> = emptyList(),
    onOpenResult: (event: EventDTO, day: java.time.LocalDate, needsHydration: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val displayZone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()

    var query by remember { mutableStateOf("") }
    // Server-section results (all history), already de-duplicated against
    // the local section. Local results are derived, not state — they
    // follow the query and the held events instantly.
    var serverResults by remember { mutableStateOf<List<SearchResultDTO>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    // The server search for the current query has finished (ok or not).
    var serverDone by remember { mutableStateOf(false) }
    // The server could not be reached — results are local-only.
    var offline by remember { mutableStateOf(false) }
    // A tapped result whose date would not parse. Kept separate from the
    // search state: a failed search is "offline" now, not an error.
    var jumpError by remember { mutableStateOf<String?>(null) }

    val trimmed = query.trim()
    // Local hits keep their full EventDTO next to the row shape: a tap
    // opens the detail with the real event, no promotion / hydration.
    val localResults = remember(trimmed, localEvents, calendars) {
        if (trimmed.isEmpty()) {
            emptyList()
        } else {
            val needle = trimmed.lowercase()
            localEvents.filter { it.matchesLocal(needle) }
                .sortedBy { it.startsAt }
                .map { it.toSearchRow(calendars) to it }
        }
    }
    val localRows = remember(localResults) { localResults.map { it.first } }
    val allResults = localRows + serverResults

    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } }

    /** 打开某条结果：跳到它所在的那天，并打开它的详情。结果行点击和
     *  输入框回车共用。 */
    fun openResult(r: SearchResultDTO, event: EventDTO, needsHydration: Boolean) {
        // 点了一条搜索结果，无论如何都得有反应。
        //
        // 以前这里是「解析失败就 return」：解析一旦失败，对话框不关、日历不动、
        // 屏幕上一个字都不多，用户只会以为鼠标没点着，反复点。现在解析走公用的
        // parseInstant（多认一种不带时区的写法），真解析不了就把话说出来。
        val day = cn.bywave.calendar.desktop.ui.calendar.parseInstant(event.startsAt)
            ?.atZone(displayZone)?.toLocalDate()
        if (day != null) {
            onOpenResult(event, day, needsHydration)
        } else {
            jumpError = cn.bywave.calendar.desktop.i18n.I18n.t("search.jumpFailed")
        }
    }

    /** 回车打开第一条结果（本地优先，与列表的视觉顺序一致）。 */
    fun openFirst() {
        val local = localResults.firstOrNull()
        if (local != null) {
            openResult(local.first, local.second, needsHydration = false)
            return
        }
        val server = serverResults.firstOrNull() ?: return
        openResult(server, server.toEventDTO(), needsHydration = true)
    }

    // Debounced server search. Re-runs whenever the (trimmed) query changes.
    // A fresh keystroke cancels the previous in-flight LaunchedEffect, so
    // only the last query wins — same debounce iOS does (250ms there; 300
    // here is plenty responsive for a desktop typist).
    LaunchedEffect(trimmed) {
        serverResults = emptyList()
        serverDone = false
        offline = false
        searching = false
        jumpError = null
        if (trimmed.isEmpty()) return@LaunchedEffect
        searching = true
        kotlinx.coroutines.delay(300)
        val api = ApiClient(profile)
        runCatching { api.search(trimmed, limit = 100) }
            .onSuccess {
                api.close()
                // Drop hits the local section already shows. The pair
                // (id, startsAt) identifies an occurrence — a recurring
                // series shares one id across many starts.
                val localKeys = localRows.map { r -> r.id to r.startsAt }.toSet()
                serverResults = it.events.filter { r -> (r.id to r.startsAt) !in localKeys }
                searching = false
                serverDone = true
            }
            .onFailure {
                api.close()
                // CancellationException means a newer keystroke superseded
                // this run — leave state alone so the newer run owns it.
                if (it is kotlinx.coroutines.CancellationException) throw it
                // Android parity: a failed server call is not an error
                // state — the local results stay and the dialog says
                // they are local-only.
                offline = true
                searching = false
                serverDone = true
            }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Search, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    t("search.title"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        },
        text = {
            Column(
                modifier = Modifier.width(460.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text(t("search.placeholder")) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester)
                        // 搜索框里敲回车 = 打开第一条结果。这是所有搜索框
                        // 的默认预期,以前回车没反应,用户得手动去点那一行。
                        // 还在搜 / 没有结果时回车什么都不做,不要弹错。
                        .onPreviewKeyEvent { e ->
                            if (e.type == KeyEventType.KeyDown &&
                                (e.key == Key.Enter || e.key == Key.NumPadEnter) &&
                                allResults.isNotEmpty()
                            ) {
                                openFirst(); true
                            } else {
                                false
                            }
                        },
                )

                when {
                    jumpError != null -> {
                        Text(
                            jumpError!!,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    trimmed.isEmpty() -> {
                        Text(
                            t("search.hint"),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 8.dp),
                        )
                    }
                    else -> {
                        // Results list. Cap the height so a big result set
                        // scrolls inside the dialog instead of overflowing
                        // the window.
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 360.dp)
                                .verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            if (offline) {
                                Text(
                                    t("search.offlineHint"),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            localResults.forEach { (r, event) ->
                                SearchResultRow(
                                    result = r,
                                    displayZone = displayZone,
                                    onClick = { openResult(r, event, needsHydration = false) },
                                )
                            }
                            if (searching && serverResults.isEmpty()) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    CircularProgressIndicator(
                                        strokeWidth = Dimens.spinnerStroke,
                                        modifier = Modifier.size(Dimens.spinnerSmall),
                                    )
                                    Spacer(Modifier.width(10.dp))
                                    Text(
                                        t("search.serverSearching"),
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            }
                            if (serverResults.isNotEmpty()) {
                                Text(
                                    t("search.serverSection"),
                                    style = MaterialTheme.typography.labelMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(top = if (localResults.isEmpty()) 0.dp else 6.dp),
                                )
                                serverResults.forEach { r ->
                                    SearchResultRow(
                                        result = r,
                                        displayZone = displayZone,
                                        onClick = { openResult(r, r.toEventDTO(), needsHydration = true) },
                                    )
                                }
                            }
                            if (serverDone && !searching && allResults.isEmpty()) {
                                Text(
                                    t("search.empty"),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(vertical = 6.dp),
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(t("search.close")) }
        },
    )
}

/** One result row — calendar color dot + summary + time + (optional)
 *  location + calendar name. Clicking it jumps the calendar to the
 *  event's day and opens the event's detail. Layout echoes the calendar
 *  views' EventRow so search feels like part of the same app. */
@Composable
private fun SearchResultRow(result: SearchResultDTO, displayZone: ZoneId, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(rowShape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = Dimens.cardFillAlpha))
            .hoverHighlight(interaction, rowShape)
            .pointerHoverIcon(PointerIcon.Hand)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 4.dp)
                .size(Dimens.colorDot)
                .clip(CircleShape)
                .background(parseHex(result.calendarColor)),
        )
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                result.summary,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                // 重复事件显示下一次发生的时间，而不是可能已过去的系列开始。
                resultTimeLabel(result.nextStartsAt ?: result.startsAt, displayZone),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!result.location.isNullOrEmpty()) {
                Text(
                    result.location,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (!result.calendarName.isNullOrEmpty()) {
                Text(
                    result.calendarName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
        }
    }
}
