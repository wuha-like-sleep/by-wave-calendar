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
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.TextStyle
import java.util.Locale

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

        // 6 行 × 7 列。每格能放几条事件条，必须按格子的真实高度算出来，
        // 不能写死 2 条：格子高度 = (可用高度 - 表头) / 6，在 5 英寸小屏 /
        // 横屏 / 系统字号调到最大时可能只有三十几 dp，而「日期数字 22dp +
        // 两条 16dp + 一行「+N」」要 80dp 往上。Compose 的 Column 不裁剪超出
        // 的子元素，它们会直接画到下一周那一行上——看起来是「事件跑到了错误
        // 的日期上」，而代码看起来完全正常。
        BoxWithConstraints(modifier = Modifier.fillMaxWidth().weight(1f)) {
            // 一格能放几条，按格子的真实高度算。fontScale 也要乘进去：
            // 系统字号调到 1.5 倍之后，一条事件条的实际高度是 16dp 而不是
            // 11dp，按固定 dp 算出来的条数会比真正放得下的多，又溢出了。
            val fontScale = LocalDensity.current.fontScale.coerceIn(1f, 2f)
            val chipRow = CHIP_ROW_HEIGHT * fontScale
            val overflowRow = CHIP_OVERFLOW_HEIGHT * fontScale
            val rowHeight = maxHeight / 6
            // 日期数字那一块 + 上下内边距 + 它和第一条之间的间距。
            val spaceForChips = rowHeight - CELL_HEADER_HEIGHT * fontScale
            val capacity = (spaceForChips / chipRow).toInt().coerceIn(0, 3)

            Column(modifier = Modifier.fillMaxSize()) {
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
                                capacity = capacity,
                                overflowFits = spaceForChips >= chipRow + overflowRow,
                                onClick = { onDayClick(day) },
                                modifier = Modifier.weight(1f).fillMaxHeight(),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 一条事件条的占位：labelSmall 的行高 + 上下 1dp 内边距 + 2dp 条间距。 */
private val CHIP_ROW_HEIGHT = 20.dp
/** 「+N」那一行的占位。 */
private val CHIP_OVERFLOW_HEIGHT = 18.dp
/** 日期数字那一块（上内边距 4 + 数字 22 + 间距 2 + 下内边距 2）。 */
private val CELL_HEADER_HEIGHT = 30.dp

@Composable
private fun WeekdayHeader() {
    Row(
        modifier = Modifier.fillMaxWidth().height(28.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Mon-anchored narrow weekday labels in the device's locale
        // (e.g. "M…S" / "一…日" / "月…日") — no hand-translated arrays.
        val locale = LocalConfiguration.current.locales[0]
        val labels = remember(locale) {
            val mondayFirst = listOf(
                DayOfWeek.MONDAY, DayOfWeek.TUESDAY, DayOfWeek.WEDNESDAY,
                DayOfWeek.THURSDAY, DayOfWeek.FRIDAY, DayOfWeek.SATURDAY, DayOfWeek.SUNDAY,
            )
            mondayFirst.map { it.getDisplayName(TextStyle.NARROW, locale) }
        }
        for (label in labels) {
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                    maxLines = 1,
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
    /** 这一格纵向能塞下几条事件条（已按字号缩放算过）。 */
    capacity: Int,
    /** 在放满之外还能不能多挤下一行「+N」。 */
    overflowFits: Boolean,
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
                // 用 defaultMinSize 而不是固定 size：系统字号调大之后，
                // 固定 22dp 高会把「28」这种两位数上下切掉。
                .defaultMinSize(minWidth = 24.dp, minHeight = 22.dp)
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

        // 能放几条由外面按格子高度算。放不下时要不要挪一行出来显示「+N」，
        // 取决于挪完还剩不剩得下事件条：格子只够一行的时候，显示一条事件
        // 比显示一个光秃秃的「+3」有用得多（点进去就是日视图）。
        val overflowing = eventsOnDay.size > capacity
        val chipCount = when {
            !overflowing -> capacity
            overflowFits -> capacity - 1
            else -> capacity
        }
        val visible = eventsOnDay.take(chipCount.coerceAtLeast(0))
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
        // 剩下多少条没显示。格子矮到一条事件条都放不下时（capacity = 0），
        // 这里就是唯一的线索——绝不能让有事件的日子看起来是空的。
        if (eventsOnDay.size > visible.size && (overflowFits || visible.isEmpty())) {
            Text(
                text = "+${eventsOnDay.size - visible.size}",
                style = MaterialTheme.typography.labelSmall,
                color = mutedTextColor(),
                modifier = Modifier.padding(start = 4.dp),
            )
        }
    }
}
