// Week view — Mon-Sun 7-column × 24-hour time grid. Ported from
// Android WeekView.kt with two desktop tweaks:
//
//   1. Auto-scroll uses LocalDensity so the px conversion is exact on
//      any DPI (Android side hardcoded a 3x factor assuming phone DPI).
//   2. combinedClickable replaced with plain `clickable` — desktop has
//      no native long-press gesture; we'll surface a right-click menu
//      in v0.4 instead.
//
// Layout strategy mirrors Android / iOS: a BoxWithConstraints provides
// columnWidth (maxWidth - TIME_GUTTER)/7, the parent Box is sized
// exactly columnWidth*7 × HOUR_HEIGHT*24, every chip is positioned via
// Modifier.offset() inside that bounded frame.

package cn.bywave.calendar.desktop.ui.calendar

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.onClick
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerButton
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.ui.event.EventContextMenu
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

private val HOUR_HEIGHT = 56.dp
private val TIME_GUTTER = 56.dp

@Composable
fun WeekView(
    weekStart: LocalDate,
    events: List<EventDTO>,
    calendars: List<CalendarMeta>,
    onEventClick: (EventDTO) -> Unit = {},
    onEventEdit: (EventDTO) -> Unit = {},
    onEventDuplicate: (EventDTO) -> Unit = {},
    onEventDelete: (EventDTO) -> Unit = {},
    /** Drag-released: shift event by (deltaMinutes, deltaDays). Caller
     *  is responsible for the PATCH + scope picker plumbing. */
    onEventMove: (EventDTO, Int, Int) -> Unit = { _, _, _ -> },
    /** Bottom-edge drag-released: stretch event end by deltaMinutes. */
    onEventResize: (EventDTO, Int) -> Unit = { _, _ -> },
    /** Tap on an empty time slot → caller opens the create dialog
     *  pre-filled with this start time. */
    onEmptySlotClick: (LocalDateTime) -> Unit = {},
) {
    val dayStarts = remember(weekStart) { (0L..6L).map { weekStart.plusDays(it) } }
    val timedEvents = remember(events) { events.filter { !it.allDay } }

    Column(modifier = Modifier.fillMaxSize()) {
        HeaderRow(dayStarts = dayStarts)
        HorizontalDivider()

        val scroll = rememberScrollState()
        val density = LocalDensity.current
        LaunchedEffect(weekStart) {
            // Land at current hour - 1, like iOS / Android WeekView.
            val now = LocalTime.now()
            val targetDp = HOUR_HEIGHT * (now.hour - 1).coerceAtLeast(0)
            val px = with(density) { targetDp.toPx() }
            scroll.scrollTo(px.toInt())
        }

        Column(modifier = Modifier.fillMaxSize().verticalScroll(scroll)) {
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(HOUR_HEIGHT * 24),
            ) {
                val available = maxWidth - TIME_GUTTER
                val columnWidth = available / 7

                HourLines()
                ColumnSeparators(columnWidth = columnWidth)
                NowLine(dayStarts = dayStarts, columnWidth = columnWidth)

                // Tap layer for empty time-slot clicks. Placed BEFORE
                // chips in the draw order so chips intercept their own
                // taps first (Compose hit-testing is top-down). The
                // layer fills the gridded area only — the gutter stays
                // tap-inert so users don't accidentally trigger create
                // by clicking the hour labels.
                EmptySlotTapLayer(
                    dayStarts = dayStarts,
                    columnWidth = columnWidth,
                    onTap = onEmptySlotClick,
                )

                for ((dayIdx, day) in dayStarts.withIndex()) {
                    val onDay = remember(timedEvents, day) {
                        timedEvents.filter { eventOnDay(it, day) }
                                   .sortedBy { it.startsAt }
                    }
                    val clusters = remember(onDay) { clusterOverlaps(onDay) }

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
                                onView = onEventClick,
                                onEdit = onEventEdit,
                                onDuplicate = onEventDuplicate,
                                onDelete = onEventDelete,
                                onMove = onEventMove,
                                onResize = onEventResize,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun HeaderRow(dayStarts: List<LocalDate>) {
    Row(
        modifier = Modifier.fillMaxWidth().height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.width(TIME_GUTTER))
        for (day in dayStarts) {
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val isToday = day == LocalDate.now()
                Text(
                    text = weekdayShort(day),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (isToday) MaterialTheme.colorScheme.primary else mutedTextColor(),
                )
                Spacer(Modifier.height(2.dp))
                Box(
                    modifier = Modifier.size(32.dp)
                        .clip(CircleShape)
                        .background(if (isToday) MaterialTheme.colorScheme.primary else Color.Transparent),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = day.dayOfMonth.toString(),
                        style = MaterialTheme.typography.titleMedium,
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
private fun HourLines() {
    val gridColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)
    Column(modifier = Modifier.fillMaxSize()) {
        for (hour in 0 until 24) {
            Row(modifier = Modifier.fillMaxWidth().height(HOUR_HEIGHT)) {
                Text(
                    text = "%02d:00".format(hour),
                    modifier = Modifier
                        .width(TIME_GUTTER - 6.dp)
                        .padding(end = 6.dp)
                        .offset(y = (-6).dp),
                    textAlign = TextAlign.End,
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                )
                Box(modifier = Modifier.weight(1f).height(HOUR_HEIGHT)) {
                    Box(modifier = Modifier.fillMaxWidth().height(0.5.dp).background(gridColor))
                }
            }
        }
    }
}

@Composable
private fun ColumnSeparators(columnWidth: Dp) {
    val gridColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
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
private fun EmptySlotTapLayer(
    dayStarts: List<LocalDate>,
    columnWidth: Dp,
    onTap: (LocalDateTime) -> Unit,
) {
    val density = LocalDensity.current
    val gutterPx = with(density) { TIME_GUTTER.toPx() }
    val colPx = with(density) { columnWidth.toPx() }
    val hourPx = with(density) { HOUR_HEIGHT.toPx() }

    // Offset by TIME_GUTTER so taps in the hour-label column don't
    // count. We size the layer to match the data area (cols * 7 wide,
    // hourHeight * 24 tall) so we can't tap outside the grid.
    Box(
        modifier = Modifier
            .offset(x = TIME_GUTTER, y = 0.dp)
            .width(columnWidth * 7)
            .height(HOUR_HEIGHT * 24)
            .pointerInput(dayStarts) {
                detectTapGestures { offset ->
                    val col = (offset.x / colPx).toInt().coerceIn(0, 6)
                    val minutes = (offset.y / hourPx * 60f).toInt()
                    // Snap to 15-min grid so the seed time is tidy.
                    val snapped = (minutes / 15) * 15
                    val day = dayStarts[col]
                    val time = LocalTime.of(
                        (snapped / 60).coerceIn(0, 23),
                        (snapped % 60).coerceIn(0, 59),
                    )
                    onTap(LocalDateTime.of(day, time))
                }
            },
    )
}

@Composable
private fun NowLine(dayStarts: List<LocalDate>, columnWidth: Dp) {
    val today = LocalDate.now()
    val todayIdx = dayStarts.indexOf(today)
    if (todayIdx < 0) return

    val now = LocalTime.now()
    val y = HOUR_HEIGHT * (now.hour + now.minute / 60f)
    val x = TIME_GUTTER + columnWidth * todayIdx

    Box(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .offset(x = x - 4.dp, y = y - 4.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(Color.Red),
        )
        Box(
            modifier = Modifier
                .offset(x = x, y = y - 0.75.dp)
                .width(columnWidth)
                .height(1.5.dp)
                .background(Color.Red),
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
    onView: (EventDTO) -> Unit,
    onEdit: (EventDTO) -> Unit,
    onDuplicate: (EventDTO) -> Unit,
    onDelete: (EventDTO) -> Unit,
    onMove: (EventDTO, Int, Int) -> Unit,
    onResize: (EventDTO, Int) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    // Live drag offsets in px. We keep px because detectDragGestures
    // gives px deltas — converting to dp every tick is wasteful. We
    // only round to minutes/days once on drag-end.
    var dragOffsetX by remember(event.id, event.startsAt) { mutableStateOf(0f) }
    var dragOffsetY by remember(event.id, event.startsAt) { mutableStateOf(0f) }
    var resizeOffsetY by remember(event.id, event.startsAt) { mutableStateOf(0f) }
    val density = LocalDensity.current
    val zone = ZoneId.systemDefault()
    val dayStart = day.atStartOfDay(zone)
    val dayEnd = day.plusDays(1).atStartOfDay(zone)
    val startInstant = parseInstant(event.startsAt) ?: return
    val endInstant = parseInstant(event.endsAt) ?: return

    // Clip to the day's bounds — multi-day events span multiple chips.
    val s = if (startInstant.atZone(zone).isBefore(dayStart)) dayStart else startInstant.atZone(zone)
    val e = if (endInstant.atZone(zone).isAfter(dayEnd)) dayEnd else endInstant.atZone(zone)
    val sLocal: LocalDateTime = s.toLocalDateTime()
    val eLocal: LocalDateTime = e.toLocalDateTime()

    val startMin = sLocal.hour * 60 + sLocal.minute
    // When event spans past midnight into the next day, eLocal is on
    // day+1 (typically 00:00 next day after dayEnd clipping). Naive
    // `(eLocal.hour*60+eLocal.minute) - startMin` would give a huge
    // negative number → coerceAtLeast(15) collapses the chip to 15min.
    // Real fix: detect day overflow and use end-of-day (1440 min) as
    // the effective end. Events fully inside today: same-day math.
    val endMin = if (eLocal.toLocalDate().isAfter(day)) 24 * 60
                 else eLocal.hour * 60 + eLocal.minute
    val durMin = (endMin - startMin).coerceAtLeast(15)
    val y = HOUR_HEIGHT * (startMin / 60f)
    // Visual chip must be tall enough to render at least one line of
    // text. 15-min events compute to 12dp height; after 6dp vertical
    // padding the inner content gets 6dp which can't fit a 13dp text.
    // Floor at 26dp so the title is always legible (will overlap the
    // next hour's grid lines slightly — acceptable trade-off vs
    // truncated text on every short event).
    val h = (HOUR_HEIGHT * (durMin / 60f) - 2.dp).coerceAtLeast(26.dp)
    val x = TIME_GUTTER + columnWidth * dayIdx + slotWidth * idxInCluster
    val w = slotWidth - 2.dp

    val color = calendarColor(event, calendars)
    val isDragging = dragOffsetX != 0f || dragOffsetY != 0f
    val isResizing = resizeOffsetY != 0f
    val livePxToDp: (Float) -> Dp = { with(density) { it.toDp() } }

    // Drag visualisation: the chip's offset includes the live drag/resize
    // delta. height too, so a resize stretches it visibly. We don't grid-
    // snap during the gesture — feels jankier than continuous follow.
    val liveX = x + livePxToDp(dragOffsetX)
    val liveY = y + livePxToDp(dragOffsetY)
    val liveH = (h + livePxToDp(resizeOffsetY)).coerceAtLeast(12.dp)

    Box(
        modifier = Modifier
            .offset(x = liveX, y = liveY)
            .width(w)
            .height(liveH)
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = if (isDragging || isResizing) 0.7f else 0.95f))
            .onClick(
                matcher = androidx.compose.foundation.PointerMatcher.mouse(PointerButton.Secondary),
                onClick = { menuOpen = true },
            )
            .clickable(onClick = onClick)
            // Primary-button drag moves the event. Compose's
            // detectDragGestures has a touch-slop on the first move
            // (~3dp) so a plain click doesn't trigger it — both
            // gestures coexist cleanly.
            .pointerInput(event.id, event.startsAt) {
                detectDragGestures(
                    onDrag = { _, drag ->
                        dragOffsetX += drag.x
                        dragOffsetY += drag.y
                    },
                    onDragEnd = {
                        val hourPx = with(density) { HOUR_HEIGHT.toPx() }
                        val colPx = with(density) { columnWidth.toPx() }
                        // Snap minute delta to 15-min grid.
                        val rawMin = (dragOffsetY / hourPx) * 60f
                        val minuteDelta = ((rawMin / 15f).toInt()) * 15
                        // Day delta: round to nearest whole column.
                        val dayDelta = (dragOffsetX / colPx)
                            .let { if (it >= 0f) (it + 0.5f).toInt() else (it - 0.5f).toInt() }
                        dragOffsetX = 0f
                        dragOffsetY = 0f
                        // Ignore micro-drags (< ~5 minutes, same day) so a
                        // missed click doesn't quietly nudge time.
                        if (kotlin.math.abs(minuteDelta) < 5 && dayDelta == 0) return@detectDragGestures
                        onMove(event, minuteDelta, dayDelta)
                    },
                    onDragCancel = {
                        dragOffsetX = 0f
                        dragOffsetY = 0f
                    },
                )
            }
            // Smaller vertical padding on short chips so 26dp floor
            // still leaves room for 13dp text. Standard chips keep 3dp
            // breathing room.
            .padding(horizontal = 5.dp, vertical = if (h < 36.dp) 1.dp else 3.dp),
    ) {
        // Show as many lines as the chip can fit. Previously capped at
        // 2 even when the chip was 200dp tall — left events showing
        // "INFO & COMM TECHNOLOGY ..." and forced users to click to
        // read. lineCountHint uses the actual available interior (minus
        // padding) so the 26dp-floored short chip still fits one line.
        val vPad = if (h < 36.dp) 2.dp else 6.dp
        val lineCountHint = ((h - vPad).value / 14f).toInt().coerceIn(1, 6)
        Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(1.dp)) {
            Text(
                text = event.summary,
                style = MaterialTheme.typography.labelSmall,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                maxLines = lineCountHint,
                overflow = TextOverflow.Ellipsis,
            )
            // Time range — only render when chip is tall enough that
            // the title + a second line fits without truncation pressure.
            // Bumped to 44dp so 30-min events show title only (cleaner
            // than crammed 「title 13:00 – 13:30」).
            if (h > 44.dp) {
                Text(
                    text = formatTimeRange(event),
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White.copy(alpha = 0.85f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        EventContextMenu(
            expanded = menuOpen,
            event = event,
            onDismiss = { menuOpen = false },
            onView = onView,
            onEdit = onEdit,
            onDuplicate = onDuplicate,
            onDelete = onDelete,
        )
    }

    // Bottom-edge resize handle — a thin strip across the chip's
    // bottom that picks up vertical drags. We render it in a sibling
    // Box positioned at the chip's bottom edge so its pointerInput
    // doesn't fight the chip's drag handler. Only shown when the chip
    // is tall enough to host it comfortably.
    if (liveH > 24.dp) {
        Box(
            modifier = Modifier
                .offset(x = liveX, y = liveY + liveH - 6.dp)
                .width(w)
                .height(8.dp)
                .pointerInput(event.id, event.startsAt) {
                    detectDragGestures(
                        onDrag = { _, drag -> resizeOffsetY += drag.y },
                        onDragEnd = {
                            val hourPx = with(density) { HOUR_HEIGHT.toPx() }
                            val rawMin = (resizeOffsetY / hourPx) * 60f
                            val minuteDelta = ((rawMin / 15f).toInt()) * 15
                            resizeOffsetY = 0f
                            if (kotlin.math.abs(minuteDelta) < 5) return@detectDragGestures
                            onResize(event, minuteDelta)
                        },
                        onDragCancel = { resizeOffsetY = 0f },
                    )
                },
        )
    }
}

// ---- Helpers ----

private fun weekdayShort(d: LocalDate): String = when (d.dayOfWeek.value) {
    1 -> "周一"; 2 -> "周二"; 3 -> "周三"; 4 -> "周四"
    5 -> "周五"; 6 -> "周六"; 7 -> "周日"
    else -> ""
}

/** Cluster overlapping events so we can split column width N ways.
 *  A new event whose start is BEFORE the current cluster's frontier
 *  end-time joins that cluster. */
private fun clusterOverlaps(onDay: List<EventDTO>): List<List<EventDTO>> {
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
