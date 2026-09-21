// Day view — vertical list of events for the anchored day. Ported from
// Android DayView.kt, no time grid (that's the Week view's job). Sort
// order is by startsAt, same as iOS.
//
// Empty state mirrors iOS: "今天没有事件" / "无事件" depending on
// whether anchor is today.

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
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
import cn.bywave.calendar.desktop.ui.event.EventContextMenu
import cn.bywave.calendar.desktop.ui.theme.Dimens
import cn.bywave.calendar.desktop.ui.theme.EventListSkeleton
import cn.bywave.calendar.desktop.ui.theme.hoverHighlight
import cn.bywave.calendar.desktop.ui.theme.rowShape
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import java.time.LocalDate

@Composable
fun DayView(
    anchor: LocalDate,
    events: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onEventClick: (EventDTO) -> Unit,
    onEventEdit: (EventDTO) -> Unit = {},
    onEventDuplicate: (EventDTO) -> Unit = {},
    onEventDelete: (EventDTO) -> Unit = {},
    /** 正在向服务器取这一天的数据。只有在「还一条都没有」时才影响画面:
     *  有缓存内容时照常显示内容,后台静默刷新。 */
    loading: Boolean = false,
) {
    // Observe locale so the empty-state copy re-renders on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    // Filter to the anchored day (parent passes the whole loaded window,
    // not a per-day slice, so we re-filter here).
    val onDay = remember(events, anchor) {
        events.filter { eventOnDay(it, anchor) }
              .sortedBy { it.startsAt }
    }

    // 超宽屏上把列表宽度收住。一行事件在 2560 的显示器上铺满,色点在最左、
    // 时间在最右,眼睛要横扫一整块屏幕才能把「什么事」和「几点」对上。
    // 940dp 是一行放得下长标题、又不至于散开的上限。
    // 这个 Box 在三个状态里都在,所以「没数据」时整块区域不会塌掉。
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        // 注意修饰符顺序:widthIn 必须排在 fillMaxSize 前面。反过来写的话
        // fillMaxSize 先把约束定死成「min=max=父容器宽度」,widthIn 再想把
        // 上限压到 940 就会被 coerce 回父容器宽度 —— 限宽静默失效,而且
        // 只有在足够宽的屏幕上才看得出来。
        val content = Modifier.widthIn(max = 940.dp).fillMaxSize()

        if (onDay.isEmpty()) {
            if (loading) {
                // 首次加载:画骨架,别宣布「今天没有事件」——那时候还不知道。
                EventListSkeleton(modifier = Modifier.widthIn(max = 940.dp))
            } else {
                Box(modifier = content, contentAlignment = Alignment.Center) {
                    val emptyText = remember(locale, anchor) {
                        cn.bywave.calendar.desktop.i18n.I18n.t(
                            if (anchor == LocalDate.now()) "day.emptyToday" else "day.empty"
                        )
                    }
                    Text(
                        text = emptyText,
                        color = mutedTextColor(),
                    )
                }
            }
            return@Box
        }

        LazyColumn(
            modifier = content.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(Dimens.rowGap),
        ) {
            items(items = onDay, key = { "${it.id}@${it.startsAt}" }) { ev ->
                EventRow(
                    event = ev,
                    calendars = calendars,
                    onClick = { onEventClick(ev) },
                    onView = onEventClick,
                    onEdit = onEventEdit,
                    onDuplicate = onEventDuplicate,
                    onDelete = onEventDelete,
                )
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EventRow(
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
            // Hover / press wash so the row under the cursor lights up —
            // standard desktop list affordance (also flips the cursor to
            // the hand pointer below).
            .hoverHighlight(interaction, rowShape)
            .pointerHoverIcon(PointerIcon.Hand)
            // Two-button click: primary opens detail, secondary opens
            // context menu. `Modifier.onClick` is the desktop-only
            // foundation helper that exposes the PointerButton.
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
            modifier = Modifier
                .size(Dimens.colorDot)
                .clip(CircleShape)
                .background(color),
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
