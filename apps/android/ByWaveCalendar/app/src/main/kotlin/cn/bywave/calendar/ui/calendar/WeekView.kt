// Week view — Mon-Sun 7-column × 24-hour time grid.
//
// Layout strategy: use a Box with EXPLICIT size = columnWidth × 7 wide
// × hourHeight × 24 tall as the positioning container, then place each
// event with Modifier.offset() inside it. The Box's `.size()` modifier
// means every child's offset target stays within the parent's layout
// frame — sidestepping the SwiftUI iOS bug we just fixed where
// `.offset()` outside a small parent frame got silently culled.
//
// Mirrors iOS WeekView.swift behavior:
//   - dayStarts derived from Monday-anchored startOfWeek
//   - Per-day filter (startsAt < dayEnd && endsAt > dayStart)
//   - Cluster overlapping events → split column width
//   - All-day strip above the grid (iOS allDayRow): per-day pills,
//     max 3 rows + "+N", absent entirely when the week has none
//   - Auto-scroll to current_hour - 1 on appear

package cn.bywave.calendar.ui.calendar

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.components.rememberReduceMotion
import cn.bywave.calendar.ui.theme.NowLineRed
import cn.bywave.calendar.ui.theme.Radii
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

private val HOUR_HEIGHT = 56.dp
private val TIME_GUTTER = 44.dp

// 全天行口径与 iOS WeekView 的 allDayRow 对齐：一列最多 3 条药丸，
// 再多折成「+N」；每条药丸占一个 24dp 的行槽（字号缩放时按比例放大，
// 见 AllDayRow 里的说明）。行槽高常量与 AllDayPill 是 internal：日视图
// 的全天区共用同一套口径（见 DayView.kt），不要各写一份漂移出去。
private val ALL_DAY_MAX_ROWS = 3
internal val ALL_DAY_ROW_HEIGHT = 24.dp

@Composable
fun WeekView(
    weekStart: LocalDate,
    events: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onEventClick: (EventDTO) -> Unit,
    onEventLongPress: (EventDTO) -> Unit = {},
) {
    val dayStarts = remember(weekStart) { (0L..6L).map { weekStart.plusDays(it) } }
    val timedEvents = remember(events) { events.filter { !it.allDay } }
    // 全天事件以前在这里被 !allDay 滤掉之后就没有下文了：时间网格按
    // 小时定位，全天事件没有小时可言，于是它们在周视图里彻底不渲染
    //（数据其实一直在 state.events 里，月视图用同一份数据画得好好的）。
    // 现在分流给下面的 AllDayRow，和 iOS / 桌面端一样在网格上方成行。
    val allDayEvents = remember(events) { events.filter { it.allDay } }

    Column(modifier = Modifier.fillMaxSize()) {
        // Header — weekday + date
        HeaderRow(dayStarts = dayStarts)
        HorizontalDivider()

        // All-day strip — pinned between the header and the scrolling
        // time grid (outside the scroll column, like the header), so
        // scrolling the hours never carries it away. Renders nothing —
        // not even the divider — when no all-day event lands this week.
        AllDayRow(
            dayStarts = dayStarts,
            events = allDayEvents,
            calendars = calendars,
            onEventClick = onEventClick,
        )

        // Scrollable time grid
        val scroll = rememberScrollState()
        // dp→px 必须用真实的屏幕密度。这里原来写死了 ×3，理由是
        // 「composable 里拿不到 LocalDensity」——其实拿得到。后果是密度不等于
        // 3 的机器全都落错位置：2.0（多数千元机 / 平板）少滚三分之一，早上
        // 打开周视图停在凌晨；3.5（部分高分屏）多滚，直接甩到下午。
        val density = LocalDensity.current
        LaunchedEffect(weekStart, density) {
            // 对齐 iOS WeekView.onAppear：停在「当前小时 - 1」。
            val now = LocalTime.now()
            val targetDp = ((now.hour - 1).coerceAtLeast(0)) * HOUR_HEIGHT.value
            scroll.scrollTo(with(density) { targetDp.dp.roundToPx() })
        }

        Column(modifier = Modifier.fillMaxSize().verticalScroll(scroll)) {
            // BoxWithConstraints gives us pixel width — divide by 7 to
            // get columnWidth for event positioning. Inside, the
            // positioning Box has fixed size so children offset to grid
            // coordinates stay inside the parent's layout frame.
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(HOUR_HEIGHT * 24),
            ) {
                val available = maxWidth - TIME_GUTTER
                val columnWidth = available / 7

                // Hour-line + time-label backdrop
                HourLines()

                // Vertical column separators
                ColumnSeparators(columnWidth = columnWidth)

                // Event chips
                for ((dayIdx, day) in dayStarts.withIndex()) {
                    val onDay = remember(timedEvents, day) {
                        timedEvents.filter { eventOnDay(it, day) }
                                   .sortedBy { it.startsAt }
                    }
                    val clusters = remember(onDay) { clusterOverlaps(onDay, day) }

                    for (cluster in clusters) {
                        val count = cluster.size
                        val slotW = columnWidth / count
                        cluster.forEachIndexed { idxInCluster, ev ->
                            EventChip(
                                event = ev,
                                calendars = calendars,
                                day = day,
                                dayIdx = dayIdx,
                                idxInCluster = idxInCluster,
                                slotWidth = slotW,
                                columnWidth = columnWidth,
                                onClick = { onEventClick(ev) },
                                onLongClick = { onEventLongPress(ev) },
                            )
                        }
                    }
                }

                // Now-line LAST in the draw order so event chips can
                // never cover it — the line must stay on top of the
                // events it crosses (only drawn when today is in this
                // week). It carries no pointer input, so sitting on
                // top does not change tap/long-press behaviour.
                NowLine(
                    dayStarts = dayStarts,
                    columnWidth = columnWidth,
                )
            }
        }
    }
}

@Composable
private fun HeaderRow(dayStarts: List<LocalDate>) {
    Row(
        modifier = Modifier.fillMaxWidth().height(56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.width(TIME_GUTTER))
        val locale = LocalConfiguration.current.locales[0]
        for (day in dayStarts) {
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val isToday = day == LocalDate.now()
                Text(
                    text = weekdayShort(day, locale),
                    maxLines = 1,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (isToday) MaterialTheme.colorScheme.primary else mutedTextColor(),
                )
                Box(
                    modifier = Modifier.size(28.dp)
                        .clip(CircleShape)
                        .background(if (isToday) MaterialTheme.colorScheme.primary else Color.Transparent),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = day.dayOfMonth.toString(),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal,
                        color = if (isToday) MaterialTheme.colorScheme.onPrimary
                                else MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

@Composable
private fun AllDayRow(
    dayStarts: List<LocalDate>,
    events: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onEventClick: (EventDTO) -> Unit,
) {
    // 分桶走 eventOnDay：它对全天事件调 eventAllDayDates()，直接读存储里
    // 的 UTC 午夜日历日期（起止两端、含旧版排他结束日），不按设备时区
    // 平移——全天事件写着 11 月 16 日，在墨尔本和洛杉矶都必须落在 16 日。
    // 月视图用的是同一条路径，两边不会漂移。
    val perDay = remember(events, dayStarts) {
        dayStarts.map { day ->
            events.filter { eventOnDay(it, day) }.sortedBy { it.startsAt }
        }
    }
    val maxRows = minOf(ALL_DAY_MAX_ROWS, perDay.maxOfOrNull { it.size } ?: 0)
    if (maxRows == 0) return

    // 行槽高随系统字号缩放，和月视图的 chipRow 同一条规则。写死 24dp 的话，
    // 字号调到 1.3 倍以上药丸里的文字行就比槽高，上下两条会叠到一起——
    // iOS 当年就是把每行 allowance 从 20pt 低估成这样才出的重叠问题。
    val fontScale = LocalDensity.current.fontScale.coerceIn(1f, 2f)
    val pillHeight = ALL_DAY_ROW_HEIGHT * fontScale - 2.dp

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            verticalAlignment = Alignment.Top,
        ) {
            // 左侧说明栏和小时刻度同宽、同为右对齐；列从 TIME_GUTTER 处
            // 起、按 weight 7 等分，与 HeaderRow 完全同构——表头、全天行、
            // 时间网格（columnWidth = (全宽 − TIME_GUTTER) / 7）共用同一套
            // 宽度模型，列对齐是构造出来的，不靠数值凑。
            Text(
                text = stringResource(R.string.event_allday),
                modifier = Modifier
                    .width(TIME_GUTTER - 4.dp)
                    .padding(end = 4.dp)
                    .padding(top = 3.dp),
                textAlign = TextAlign.End,
                style = MaterialTheme.typography.labelSmall,
                color = mutedTextColor(),
                maxLines = 1,
            )
            for (dayEvents in perDay) {
                Column(
                    modifier = Modifier.weight(1f).padding(horizontal = 2.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    for (ev in dayEvents.take(maxRows)) {
                        AllDayPill(
                            event = ev,
                            calendars = calendars,
                            height = pillHeight,
                            onClick = { onEventClick(ev) },
                        )
                    }
                    if (dayEvents.size > maxRows) {
                        Text(
                            text = "+${dayEvents.size - maxRows}",
                            style = MaterialTheme.typography.labelSmall,
                            color = mutedTextColor(),
                            modifier = Modifier.padding(start = 6.dp),
                        )
                    }
                }
            }
        }
        HorizontalDivider()
    }
}

@Composable
internal fun AllDayPill(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    height: Dp,
    onClick: () -> Unit,
) {
    // 样式走四端刚统一的口径（与月视图条带、iOS / 桌面端全天药丸一致）：
    // 圆角 Radii.chip（4dp）、填充不透明度 0.9、字色由 onCalendarColor
    // 的 WCAG 明度公式决定，不再无条件白字。
    val color = calendarColor(event, calendars)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(height)
            .clip(Radii.chipShape)
            .background(color.copy(alpha = 0.9f))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = event.summary,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = onCalendarColor(color),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun HourLines() {
    val gridColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.8f)
    // 左侧刻度原本写死成 "%02d:00"，把手机设成 12 小时制也还是 00:00–23:00。
    // 走同一套格式器，和事件详情页、日视图里的时间保持一致。
    val formats = rememberCalendarFormats()
    val hourLabels = remember(formats) {
        (0 until 24).map { formats.time.format(LocalTime.of(it, 0).atDate(LocalDate.now())) }
    }
    Column(modifier = Modifier.fillMaxSize()) {
        for (hour in 0 until 24) {
            Row(modifier = Modifier.fillMaxWidth().height(HOUR_HEIGHT)) {
                Text(
                    text = hourLabels[hour],
                    modifier = Modifier
                        .width(TIME_GUTTER - 4.dp)
                        .padding(end = 4.dp)
                        .offset(y = (-6).dp),
                    textAlign = TextAlign.End,
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                    maxLines = 1,
                )
                Box(modifier = Modifier.weight(1f).height(HOUR_HEIGHT)) {
                    // Top divider line for the hour
                    Box(modifier = Modifier.fillMaxWidth().height(0.5.dp).background(gridColor))
                }
            }
        }
    }
}

@Composable
private fun ColumnSeparators(columnWidth: Dp) {
    val gridColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.75f)
    Row(modifier = Modifier.fillMaxSize()) {
        Spacer(Modifier.width(TIME_GUTTER))
        for (i in 0 until 7) {
            Box(modifier = Modifier.width(columnWidth).fillMaxHeight()) {
                Box(modifier = Modifier.width(0.5.dp).fillMaxHeight().background(gridColor))
            }
        }
    }
}

@Composable
private fun NowLine(dayStarts: List<LocalDate>, columnWidth: Dp) {
    // 定版口径（三端一致）：线连续走，不再每分钟跳一格。秒级
    // ticker 的生命周期跟着组合与 RESUMED 走：切走视图（离开
    // 组合）自动取消，退后台 repeatOnLifecycle 自动暂停；状态
    // 只挂在这条线自己的组合作用域里，每秒重组的只有它自己，
    // 网格与事件块不跟着动。系统动画缩放为 0（减少动态）时
    // 回退到每分钟跳一格，位置只算到分钟。
    val reduceMotion = rememberReduceMotion()
    var now by remember { mutableStateOf(LocalTime.now()) }
    val todayInWeek = dayStarts.contains(LocalDate.now())
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(reduceMotion, lifecycleOwner, todayInWeek) {
        if (!todayInWeek) return@LaunchedEffect
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            val stepMs = if (reduceMotion) 60_000L else 1_000L
            while (true) {
                now = LocalTime.now()
                // 对齐到下一个整秒/整分边界，步进不漂移。
                delay(stepMs - (System.currentTimeMillis() % stepMs))
            }
        }
    }

    val todayIdx = dayStarts.indexOf(LocalDate.now())
    if (todayIdx < 0) return

    val y = if (reduceMotion) {
        HOUR_HEIGHT * (now.hour + now.minute / 60f)
    } else {
        // 秒也算进位置：56dp 一小时，秒步进约 0.016dp，肉眼平滑。
        HOUR_HEIGHT * (now.hour + now.minute / 60f + now.second / 3600f)
    }
    val x = TIME_GUTTER + columnWidth * todayIdx

    Box(modifier = Modifier.fillMaxSize()) {
        // Dot at the column's left edge
        Box(
            modifier = Modifier
                .offset(x = x - 4.dp, y = y - 4.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(NowLineRed),
        )
        // Line across the column
        Box(
            modifier = Modifier
                .offset(x = x, y = y - 0.75.dp)
                .width(columnWidth)
                .height(1.5.dp)
                .background(NowLineRed),
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EventChip(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    day: LocalDate,
    dayIdx: Int,
    idxInCluster: Int,
    slotWidth: Dp,
    columnWidth: Dp,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val zone = ZoneId.systemDefault()
    val dayStart = day.atStartOfDay(zone)
    val dayEnd = day.plusDays(1).atStartOfDay(zone)
    val startInstant = parseInstant(event.startsAt) ?: return
    val endInstant = parseInstant(event.endsAt) ?: return

    // Clip to the day's bounds — multi-day events split across days.
    val s = if (startInstant.atZone(zone).isBefore(dayStart)) dayStart else startInstant.atZone(zone)
    val e = if (endInstant.atZone(zone).isAfter(dayEnd)) dayEnd else endInstant.atZone(zone)
    val sLocal: LocalDateTime = s.toLocalDateTime()
    val eLocal: LocalDateTime = e.toLocalDateTime()

    val startMin = sLocal.hour * 60 + sLocal.minute
    val durMin = ((eLocal.hour * 60 + eLocal.minute) - startMin).coerceAtLeast(15)
    val y = HOUR_HEIGHT * (startMin / 60f)
    // Floor the chip height at one full text line + its vertical padding:
    // at the raw duration height a 15-minute event gets 12dp, of which the
    // padding eats 6dp, so the title was always clipped away. The floor
    // lets short chips overlap the next hour line slightly — the same
    // tradeoff the desktop week view documents.
    val h = (HOUR_HEIGHT * (durMin / 60f) - 2.dp).coerceAtLeast(22.dp)
    val x = TIME_GUTTER + columnWidth * dayIdx + slotWidth * idxInCluster
    val w = slotWidth - 2.dp

    val color = calendarColor(event, calendars)
    val onText = onCalendarColor(color)
    val haptic = LocalHapticFeedback.current
    // Past treatment, aligned with iOS and the web: the block keeps its
    // calendar colour at reduced strength (0.55) and the title is
    // struck through, instead of staying indistinguishable from an
    // upcoming event.
    val isPast = endInstant.isBefore(java.time.Instant.now())
    // Cross-day continuation: square off the corners on any side where
    // the event runs on into the neighbouring day, so the per-day
    // segments read as one continuous bar. Shape only — x/y/w/h above
    // are unchanged.
    val continuesFrom = startInstant.isBefore(dayStart.toInstant())
    val continuesTo = endInstant.isAfter(dayEnd.toInstant())
    val r = Radii.chip
    val shape = RoundedCornerShape(
        topStart = if (continuesFrom) 0.dp else r,
        bottomStart = if (continuesFrom) 0.dp else r,
        bottomEnd = if (continuesTo) 0.dp else r,
        topEnd = if (continuesTo) 0.dp else r,
    )
    val formats = rememberCalendarFormats()
    val allDayLabel = stringResource(R.string.event_allday)

    Box(
        modifier = Modifier
            .offset(x = x, y = y)
            .width(w)
            .height(h)
            .clip(shape)
            .background(color.copy(alpha = if (isPast) 0.55f else 0.95f))
            .combinedClickable(
                onClick = onClick,
                onLongClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onLongClick()
                },
            )
            .padding(horizontal = 4.dp, vertical = 3.dp),
    ) {
        Column {
            Text(
                text = event.summary,
                style = MaterialTheme.typography.labelSmall,
                color = onText,
                fontWeight = FontWeight.SemiBold,
                maxLines = if (h > 36.dp) 2 else 1,
                overflow = TextOverflow.Ellipsis,
                textDecoration = if (isPast) TextDecoration.LineThrough else TextDecoration.None,
            )
            // Time-range subline once the chip is tall enough for a
            // second line — the same 44dp threshold the desktop week
            // view uses (its subline has always been the time range).
            if (h > 44.dp) {
                Text(
                    text = formatTimeRange(event, formats, allDayLabel),
                    style = MaterialTheme.typography.labelSmall,
                    color = onText.copy(alpha = 0.85f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// ---- Helpers ----

// 周几短名（Mon / 周一 / 月）。locale 由调用方从 Configuration 取，
// 不用 Locale.getDefault()：Android 13 以下 APP 内语言只改 Configuration，
// 进程默认 Locale 还是系统语言，用后者会让表头和正文语言对不上。
private fun weekdayShort(d: LocalDate, locale: Locale): String =
    d.dayOfWeek.getDisplayName(TextStyle.SHORT, locale)

/** Cluster events that overlap in time so we can split column width.
 *  A new event whose start is BEFORE the cluster's current end becomes
 *  part of the same cluster (column gets split N ways). */
private fun clusterOverlaps(onDay: List<EventDTO>, day: LocalDate): List<List<EventDTO>> {
    if (onDay.isEmpty()) return emptyList()
    val clusters = mutableListOf<MutableList<EventDTO>>()
    var current = mutableListOf<EventDTO>()
    var frontier: java.time.Instant? = null

    for (ev in onDay) {
        val s = parseInstant(ev.startsAt) ?: continue
        val e = parseInstant(ev.endsAt) ?: continue
        if (frontier == null || !s.isBefore(frontier)) {
            if (current.isNotEmpty()) clusters.add(current)
            current = mutableListOf(ev)
            frontier = e
        } else {
            current.add(ev)
            if (e.isAfter(frontier)) frontier = e
        }
    }
    if (current.isNotEmpty()) clusters.add(current)
    return clusters
}
