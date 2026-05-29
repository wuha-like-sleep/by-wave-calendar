// Global event search dialog. Reachable from the toolbar magnifier icon
// or Cmd/Ctrl+F. Mirrors the web Cmd+K palette and iOS SearchView:
//
//   - Calls GET /api/v1/search?q=…&limit=100 on a short debounce (300ms),
//     so we don't fire a request per keystroke.
//   - Search is SERVER-SIDE (not a client filter over a wide fetch): the
//     server matches the needle against summary / description / location
//     across every calendar the user can see, recency-first. Same approach
//     iOS takes — its SearchView hits the same endpoint.
//   - Renders matches in a scrollable results list (calendar dot + title +
//     time + location + calendar name), reusing the visual motif of the
//     calendar views' event rows. Clicking a result jumps the calendar to
//     that event's local date via CalendarState.jumpToDay() and closes the
//     dialog.
//
// The search response is a lighter shape than EventDTO (no rrule / allDay /
// extra), which is fine here — we only need the date to jump to. Tapping a
// result navigates; the user opens the event from the day view if they want
// detail (same as the calendar's own click behaviour).

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.model.SearchResultDTO
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Local time formatter for a result row — shows the event's start in the
 *  user's local zone (the server returns ISO8601 with offset). Falls back
 *  to the raw string if parsing fails (defensive, never crash a row). */
private val RESULT_TIME_FMT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault())

private fun resultTimeLabel(iso: String): String =
    runCatching { RESULT_TIME_FMT.format(Instant.parse(iso)) }.getOrDefault(iso)

/**
 * Search dialog.
 *
 * @param serverUrl active profile's server (for a short-lived ApiClient,
 *   same one-shot pattern the Settings dialogs use).
 * @param onJumpToDate called with the chosen result's local date — the
 *   caller wires this to CalendarState.jumpToDay() then closes the dialog.
 * @param onDismiss close without navigating.
 */
@Composable
fun SearchDialog(
    serverUrl: String,
    onJumpToDate: (java.time.LocalDate) -> Unit,
    onDismiss: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<SearchResultDTO>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    // True once a query has actually run + returned — so we only show the
    // "no matches" empty state after a real search, not before the user
    // has typed anything.
    var hasSearched by remember { mutableStateOf(false) }

    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } }

    // Debounced server search. Re-runs whenever the (trimmed) query changes.
    // A fresh keystroke cancels the previous in-flight LaunchedEffect, so
    // only the last query wins — same debounce iOS does (250ms there; 300
    // here is plenty responsive for a desktop typist).
    LaunchedEffect(query) {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) {
            results = emptyList()
            errorMsg = null
            hasSearched = false
            searching = false
            return@LaunchedEffect
        }
        searching = true
        errorMsg = null
        kotlinx.coroutines.delay(300)
        val api = ApiClient(serverUrl)
        runCatching { api.search(trimmed, limit = 100) }
            .onSuccess {
                api.close()
                results = it.events
                searching = false
                hasSearched = true
            }
            .onFailure {
                api.close()
                // CancellationException means a newer keystroke superseded
                // this run — leave state alone so the newer run owns it.
                if (it is kotlinx.coroutines.CancellationException) throw it
                errorMsg = it.localizedMessage ?: t("search.failed")
                searching = false
                hasSearched = true
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
                        .focusRequester(focusRequester),
                )

                when {
                    errorMsg != null -> {
                        Text(
                            errorMsg!!,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    searching && results.isEmpty() -> {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(t("search.searching"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    hasSearched && results.isEmpty() -> {
                        Text(
                            t("search.empty"),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 12.dp),
                        )
                    }
                    !hasSearched && query.isBlank() -> {
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
                            results.forEach { r ->
                                SearchResultRow(
                                    result = r,
                                    onClick = {
                                        val day = runCatching {
                                            Instant.parse(r.startsAt)
                                                .atZone(ZoneId.systemDefault())
                                                .toLocalDate()
                                        }.getOrNull()
                                        if (day != null) onJumpToDate(day)
                                    },
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
 *  location + calendar name. Clicking it navigates the calendar to the
 *  event's day. Layout echoes the calendar views' EventRow so search feels
 *  like part of the same app. */
@Composable
private fun SearchResultRow(result: SearchResultDTO, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .clickable(onClick = onClick)
            .padding(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 4.dp)
                .size(10.dp)
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
            )
            Text(
                resultTimeLabel(result.startsAt),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!result.location.isNullOrEmpty()) {
                Text(
                    result.location,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
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
