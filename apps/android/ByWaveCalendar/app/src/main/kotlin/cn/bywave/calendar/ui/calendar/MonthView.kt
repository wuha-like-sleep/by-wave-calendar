// Month view — 6 rows × 7 columns Mon-Sun grid. Each cell shows day
// number + up to 2 colored event chips (truncated) + "+N more"
// indicator when overflow. Tap a date → switch to Day view at that
// date (handled by the parent via onDayClick).
//
// Mirrors iOS MonthView.swift.

package cn.bywave.calendar.ui.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import java.time.LocalDate
import java.time.YearMonth

@Composable
fun MonthView(
    anchor: LocalDate,
    events: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onDayClick: (LocalDate) -> Unit,
) {
    val month = remember(anchor) { YearMonth.from(anchor) }
    val cells = remember(month) { monthGridDays(month) }

    // Pre-bucket events by start-day. We bucket per the EVENT'S start
    // day (matches iOS MonthView eventsByDay) rather than per-cell
    // overlap — multi-day events show only on their first day in
    // month view to keep cells readable.
    val byDay = remember(events) {
        val m = mutableMapOf<LocalDate, MutableList<EventDTO>>()
        for (e in events) {
            val d = toLocalDate(parseInstant(e.startsAt)) ?: continue
            m.getOrPut(d) { mutableListOf() }.add(e)
        }
        for ((_, list) in m) list.sortBy { it.startsAt }
        m
    }

    Column(modifier = Modifier.fillMaxSize()) {
        WeekdayHeader()
        HorizontalDivider()

        // 6 rows, each row has 7 day cells of equal weight.
        for (row in 0 until 6) {
            Row(
                modifier = Modifier.fillMaxWidth().weight(1f),
            ) {
                for (col in 0 until 7) {
                    val idx = row * 7 + col
                    val day = cells[idx]
                    DayCell(
                        day = day,
                        monthAnchor = month,
                        eventsOnDay = byDay[day].orEmpty(),
                        calendars = calendars,
                        onClick = { onDayClick(day) },
                        modifier = Modifier.weight(1f).fillMaxHeight(),
                    )
                }
            }
        }
    }
}

@Composable
private fun WeekdayHeader() {
    Row(
        modifier = Modifier.fillMaxWidth().height(28.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (label in listOf("一", "二", "三", "四", "五", "六", "日")) {
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                )
            }
        }
    }
}

@Composable
private fun DayCell(
    day: LocalDate,
    monthAnchor: YearMonth,
    eventsOnDay: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val isToday = day == LocalDate.now()
    val isInMonth = YearMonth.from(day) == monthAnchor
    val gridColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f)

    Column(
        modifier = modifier
            .clickable(onClick = onClick)
            .padding(top = 4.dp, start = 4.dp, end = 4.dp, bottom = 2.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // Date number
        Box(
            modifier = Modifier
                .size(width = 24.dp, height = 22.dp)
                .clip(CircleShape)
                .background(if (isToday) MaterialTheme.colorScheme.primary else Color.Transparent),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = day.dayOfMonth.toString(),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal,
                color = when {
                    isToday -> MaterialTheme.colorScheme.onPrimary
                    !isInMonth -> mutedTextColor().copy(alpha = 0.4f)
                    else -> MaterialTheme.colorScheme.onSurface
                },
            )
        }

        // Up to 2 colored event chips
        val visible = eventsOnDay.take(2)
        for (ev in visible) {
            val color = calendarColor(ev, calendars)
            Text(
                text = ev.summary,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(3.dp))
                    .background(color.copy(alpha = 0.9f))
                    .padding(horizontal = 4.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelSmall,
                color = Color.White,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // "+N more" indicator for overflow
        if (eventsOnDay.size > 2) {
            Text(
                text = "+${eventsOnDay.size - 2}",
                style = MaterialTheme.typography.labelSmall,
                color = mutedTextColor(),
                modifier = Modifier.padding(start = 4.dp),
            )
        }
    }
}
