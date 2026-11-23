// Day view — simple vertical list of events for the anchored day.
// Mirror of iOS DayView.swift (List + EventRowView). Tap a row to open
// the event detail bottom sheet.

package cn.bywave.calendar.ui.calendar

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.EventNote
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.components.EmptyState
import cn.bywave.calendar.ui.theme.Radii
import cn.bywave.calendar.ui.theme.Sizing
import cn.bywave.calendar.ui.theme.Spacing
import java.time.LocalDate

@Composable
fun DayView(
    anchor: LocalDate,
    events: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onEventClick: (EventDTO) -> Unit,
    onEventLongPress: (EventDTO) -> Unit = {},
    onCreateEvent: () -> Unit = {},
) {
    if (events.isEmpty()) {
        EmptyState(
            icon = Icons.Outlined.EventNote,
            title = if (anchor == LocalDate.now()) stringResource(R.string.calendar_no_events_today)
                    else stringResource(R.string.calendar_no_events),
            subtitle = stringResource(R.string.day_empty_subtitle),
            // The subtitle tells the user to create an event — give
            // them the button right here instead of only pointing at
            // the FAB across the screen.
            action = {
                Button(onClick = onCreateEvent) {
                    Text(stringResource(R.string.event_new))
                }
            },
        )
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        items(items = events, key = { "${it.id}@${it.startsAt}" }) { ev ->
            EventRow(
                event = ev,
                calendars = calendars,
                onClick = { onEventClick(ev) },
                onLongClick = { onEventLongPress(ev) },
                // Smoothly animate rows in/out/reorder as events sync in or
                // get edited — the list is keyed, so this is safe + jank-free.
                modifier = Modifier.animateItem(),
            )
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EventRow(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val color = calendarColor(event, calendars)
    val cal = calendarName(event, calendars)
    val haptic = LocalHapticFeedback.current
    // Past treatment, aligned with the iOS row: title struck through
    // and the row's foreground dropped to 55% so a finished day scans
    // as finished. (The card fill is the shared row surface, not the
    // event's colour, so it stays — only the event's own marks fade.)
    val isPast = parseInstant(event.endsAt)?.isBefore(java.time.Instant.now()) ?: false

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(Radii.cardShape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .combinedClickable(
                onClick = onClick,
                onLongClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onLongClick()
                },
            )
            .heightIn(min = Sizing.minTouchTarget)
            .padding(Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(color.copy(alpha = if (isPast) 0.55f else 1f)),
        )
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            // maxLines 不配 overflow 的话 Compose 默认是 Clip——长标题会被
            // 齐刷刷切断，看不出后面还有字。省略号才让人知道「这里被截了」。
            Text(
                text = event.summary,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (isPast) 0.55f else 1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textDecoration = if (isPast) TextDecoration.LineThrough else TextDecoration.None,
            )
            Text(
                text = eventTimeText(event),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )
            // Location line — iOS and desktop rows have always shown it;
            // its absence here was drift, not a design choice.
            if (!event.location.isNullOrBlank()) {
                Text(
                    text = event.location!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = mutedTextColor(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (event.pendingSync) {
                Text(
                    text = stringResource(cn.bywave.calendar.R.string.offline_block_badge),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.tertiary,
                    maxLines = 1,
                )
            }
            if (cal != null) {
                Text(
                    text = cal,
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
