// Agenda view — a single scrollable "what's coming up" list across the
// anchored window (Day/Week/Month switch to a fixed grid; Agenda is the
// linear, read-fast alternative). Events are grouped by local date with a
// lightweight relative header (今天 / 明天 / weekday), sorted by start
// time. Mirrors the iOS/Android upcoming-list feel.
//
// Reuses the package-internal helpers (parseInstant / toLocalDate /
// calendarColor / formatTimeRange) + the shared EventContextMenu so the
// right-click actions are identical to Day/Week/Month rows. Strings are
// hardcoded zh to match the surrounding calendar views (DayView etc.),
// which aren't wired to I18n yet.

package cn.bywave.calendar.desktop.ui.calendar

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.onClick
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerButton
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.ui.event.EventContextMenu
import cn.bywave.calendar.desktop.ui.theme.Dimens
import cn.bywave.calendar.desktop.ui.theme.hoverHighlight
import cn.bywave.calendar.desktop.ui.theme.rowShape
import java.time.LocalDate
import java.time.format.DateTimeFormatter

// Header date pattern is itself localized (CJK "M 月 d 日 EEEE" vs an
// en/es/fr/… equivalent). Resolved per call through i18n so it follows
// the chosen UI language; weekday/month names follow the same locale.
private fun agendaHeaderFmt(): DateTimeFormatter =
    DateTimeFormatter.ofPattern(
        cn.bywave.calendar.desktop.i18n.I18n.t("fmt.monthDayWeekday"),
        java.util.Locale.forLanguageTag(cn.bywave.calendar.desktop.i18n.I18n.current.value.code),
    )

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AgendaView(
    anchor: LocalDate,
    events: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onEventClick: (EventDTO) -> Unit,
    onEventEdit: (EventDTO) -> Unit,
    onEventDuplicate: (EventDTO) -> Unit,
    onEventDelete: (EventDTO) -> Unit,
) {
    // Observe locale so empty-state copy + date headers re-render on switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    // Parse + sort by start instant, then group by local date (sorted).
    // Events whose start timestamp won't parse are dropped (same defensive
    // stance as MonthView).
    val grouped: List<Pair<LocalDate, List<EventDTO>>> = remember(events) {
        events
            .mapNotNull { ev ->
                val ins = parseInstant(ev.startsAt) ?: return@mapNotNull null
                val date = toLocalDate(ins) ?: return@mapNotNull null
                Triple(ev, ins, date)
            }
            .sortedBy { it.second }
            .groupBy { it.third }
            .toSortedMap()
            .map { (date, rows) -> date to rows.map { it.first } }
    }

    if (grouped.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                text = remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("agenda.empty") },
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
            )
        }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        grouped.forEach { (date, dayEvents) ->
            item(key = "header-$date") {
                AgendaDayHeader(date = date, count = dayEvents.size)
            }
            items(dayEvents, key = { "${it.id}-${it.startsAt}" }) { ev ->
                AgendaRow(
                    event = ev,
                    calendars = calendars,
                    onClick = { onEventClick(ev) },
                    onView = onEventClick,
                    onEdit = onEventEdit,
                    onDuplicate = onEventDuplicate,
                    onDelete = onEventDelete,
                )
            }
        }
    }
}

@Composable
private fun AgendaDayHeader(date: LocalDate, count: Int) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val today = LocalDate.now()
    val headerText = remember(locale, date) {
        val prefix = when (date) {
            today -> cn.bywave.calendar.desktop.i18n.I18n.t("agenda.today") + " · "
            today.plusDays(1) -> cn.bywave.calendar.desktop.i18n.I18n.t("agenda.tomorrow") + " · "
            else -> ""
        }
        prefix + agendaHeaderFmt().format(date)
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = headerText,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (date == today) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        )
        Spacer(Modifier.size(8.dp))
        Text(
            text = "$count",
            style = MaterialTheme.typography.labelSmall,
            color = mutedTextColor(),
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AgendaRow(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    onClick: () -> Unit,
    onView: (EventDTO) -> Unit,
    onEdit: (EventDTO) -> Unit,
    onDuplicate: (EventDTO) -> Unit,
    onDelete: (EventDTO) -> Unit,
) {
    // Observe locale so the formatTimeRange() output re-renders on switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val color = calendarColor(event, calendars)
    val cal = calendarName(event, calendars)
    var menuOpen by remember { mutableStateOf(false) }
    val timeText = remember(locale, event) { formatTimeRange(event) }
    val interaction = remember { MutableInteractionSource() }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(rowShape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = Dimens.cardFillAlpha))
            .hoverHighlight(interaction, rowShape)
            .pointerHoverIcon(PointerIcon.Hand)
            .onClick(
                matcher = androidx.compose.foundation.PointerMatcher.mouse(PointerButton.Secondary),
                onClick = { menuOpen = true },
            )
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(Dimens.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        EventContextMenu(
            expanded = menuOpen,
            event = event,
            onDismiss = { menuOpen = false },
            onView = onView,
            onEdit = onEdit,
            onDuplicate = onDuplicate,
            onDelete = onDelete,
        )
        Box(
            modifier = Modifier.size(Dimens.colorDot).clip(CircleShape).background(color),
        )
        Spacer(Modifier.size(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = event.summary,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
            )
            Text(
                text = timeText,
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )
            if (cal != null) {
                Text(
                    text = cal,
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                )
            }
        }
    }
}
