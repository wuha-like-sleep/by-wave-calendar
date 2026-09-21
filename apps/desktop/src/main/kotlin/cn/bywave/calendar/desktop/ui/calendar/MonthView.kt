// Month view — 6 rows × 7 columns Mon-Sun grid. Each cell shows day
// number + up to 2 colored event chips (truncated) + "+N more"
// indicator on overflow. Click a date → switch to Day view at that
// date; click a chip → fire onEventClick for detail.
//
// Ported from Android MonthView.kt. Multi-day events render only on
// their start day (matches iOS/Android) — overlap rendering would make
// cells unreadable.

package cn.bywave.calendar.desktop.ui.calendar

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.onClick
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerButton
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.ui.event.EventContextMenu
import cn.bywave.calendar.desktop.ui.theme.Dimens
import cn.bywave.calendar.desktop.ui.theme.hoverHighlight
import java.time.LocalDate
import java.time.YearMonth

@Composable
fun MonthView(
    anchor: LocalDate,
    events: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onDayClick: (LocalDate) -> Unit,
    onEventClick: (EventDTO) -> Unit,
    onEventEdit: (EventDTO) -> Unit = {},
    onEventDuplicate: (EventDTO) -> Unit = {},
    onEventDelete: (EventDTO) -> Unit = {},
) {
    val month = remember(anchor) { YearMonth.from(anchor) }
    val cells = remember(month) { monthGridDays(month) }

    // Pre-bucket by start day. Sort within each day by startsAt so the
    // chip order is deterministic and matches the time grid.
    val byDay = remember(events) {
        val m = mutableMapOf<LocalDate, MutableList<EventDTO>>()
        for (e in events) {
            val d = toLocalDate(parseInstant(e.startsAt)) ?: continue
            m.getOrPut(d) { mutableListOf() }.add(e)
        }
        for ((_, list) in m) list.sortBy { it.startsAt }
        m
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        // 一格里能放几条事件块,按格子实际高度算,不再写死 2 条。
        //
        // 写死 2 条的后果是两头都不对:窗口拉高到全屏时每格有 140dp 高,
        // 下面 100dp 全是空的,而当天第 3、4 件事只能显示成「+2」——
        // 屏幕明明够用却在折叠;窗口压矮时又反过来,2 条根本塞不下,
        // 事件块被格子边缘切掉一半。
        //
        // 34dp = 日期圆点(24) + 上下内边距;17dp = 一条事件块 + 行距。
        // 折叠提示「+N」自己也要占一行,所以按能放 n 条算出来之后,
        // 真的有折叠时会少显示一条给它腾位置。
        val rowHeight = ((maxHeight - 32.dp) / 6).coerceAtLeast(0.dp)
        val maxChips = (((rowHeight - 34.dp) / 17.dp).toInt()).coerceIn(1, 8)

        Column(modifier = Modifier.fillMaxSize()) {
            WeekdayHeader()
            HorizontalDivider()

            for (row in 0 until 6) {
                Row(modifier = Modifier.fillMaxWidth().weight(1f)) {
                    for (col in 0 until 7) {
                        val idx = row * 7 + col
                        val day = cells[idx]
                        DayCell(
                            day = day,
                            monthAnchor = month,
                            eventsOnDay = byDay[day].orEmpty(),
                            calendars = calendars,
                            maxChips = maxChips,
                            onDayClick = { onDayClick(day) },
                            onEventClick = onEventClick,
                            onEventEdit = onEventEdit,
                            onEventDuplicate = onEventDuplicate,
                            onEventDelete = onEventDelete,
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun WeekdayHeader() {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    // Mon-anchored single-char weekday labels, localized.
    val labels = remember(locale) {
        (1..7).map { cn.bywave.calendar.desktop.i18n.I18n.t("weekday.short.$it") }
    }
    Row(
        modifier = Modifier.fillMaxWidth().height(32.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (label in labels) {
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                    color = mutedTextColor(),
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DayCell(
    day: LocalDate,
    monthAnchor: YearMonth,
    eventsOnDay: List<EventDTO>,
    calendars: List<CalendarMeta>,
    /** 这一格放得下几条事件块,由 MonthView 按窗口高度算出来。 */
    maxChips: Int,
    onDayClick: () -> Unit,
    onEventClick: (EventDTO) -> Unit,
    onEventEdit: (EventDTO) -> Unit,
    onEventDuplicate: (EventDTO) -> Unit,
    onEventDelete: (EventDTO) -> Unit,
    modifier: Modifier = Modifier,
) {
    val isToday = day == LocalDate.now()
    val isInMonth = YearMonth.from(day) == monthAnchor
    var menuFor by remember { mutableStateOf<EventDTO?>(null) }
    val interaction = remember { MutableInteractionSource() }

    Column(
        modifier = modifier
            // Hover wash on the whole day cell so the grid feels alive
            // under the mouse (no rounded shape — cells tile edge-to-edge).
            .hoverHighlight(interaction)
            .pointerHoverIcon(PointerIcon.Hand)
            .clickable(interactionSource = interaction, indication = null, onClick = onDayClick)
            .padding(top = 4.dp, start = 4.dp, end = 4.dp, bottom = 2.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // Date number
        Box(
            modifier = Modifier
                .size(width = 26.dp, height = 24.dp)
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

        // 彩色事件块。右键任意一块出该事件的上下文菜单(弹层锚在块上)。
        // 只有真的放不下时才折叠,并且给「+N」自己留一行。
        val overflow = eventsOnDay.size > maxChips
        val shown = if (overflow) (maxChips - 1).coerceAtLeast(1) else maxChips
        val visible = eventsOnDay.take(shown)
        for (ev in visible) {
            val color = calendarColor(ev, calendars)
            Box {
                Text(
                    text = ev.summary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(Dimens.chipRadius))
                        .background(color.copy(alpha = 0.9f))
                        .pointerHoverIcon(PointerIcon.Hand)
                        .onClick(
                            matcher = androidx.compose.foundation.PointerMatcher.mouse(PointerButton.Secondary),
                            onClick = { menuFor = ev },
                        )
                        .clickable { onEventClick(ev) }
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (menuFor?.id == ev.id && menuFor?.startsAt == ev.startsAt) {
                    EventContextMenu(
                        expanded = true,
                        event = ev,
                        onDismiss = { menuFor = null },
                        onView = onEventClick,
                        onEdit = onEventEdit,
                        onDuplicate = onEventDuplicate,
                        onDelete = onEventDelete,
                    )
                }
            }
        }
        if (eventsOnDay.size > visible.size) {
            Text(
                text = "+${eventsOnDay.size - visible.size}",
                style = MaterialTheme.typography.labelSmall,
                color = mutedTextColor(),
                modifier = Modifier.padding(start = 4.dp),
            )
        }
    }
}
