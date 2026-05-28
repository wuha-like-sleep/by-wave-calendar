// Centered modal showing a single event's details. v0.4 is read-only;
// v0.5 adds edit / delete buttons. Layout mirrors the iOS / Android
// EventDetailSheet (color dot + title; meta rows for time / calendar /
// location / description / url), tuned for desktop spacing.

package cn.bywave.calendar.desktop.ui.event

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.ui.calendar.calendarColor
import cn.bywave.calendar.desktop.ui.calendar.calendarName
import java.awt.Desktop
import java.net.URI
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun EventDetailDialog(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    onDismiss: () -> Unit,
    onEdit: (EventDTO) -> Unit = {},
    onDelete: (EventDTO) -> Unit = {},
) {
    val color = calendarColor(event, calendars)
    val cal = calendarName(event, calendars)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(12.dp)
                        .clip(CircleShape)
                        .background(color),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    event.summary,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                MetaRow(label = "时间", value = formatTimeBlock(event))
                if (cal != null) MetaRow(label = "日历", value = cal)
                event.location?.takeIf { it.isNotBlank() }?.let {
                    MetaRow(label = "地点", value = it)
                }
                event.extra?.timezone?.takeIf { it.isNotBlank() }?.let {
                    MetaRow(label = "时区", value = it)
                }
                event.description?.takeIf { it.isNotBlank() }?.let {
                    MetaRow(label = "描述", value = it)
                }
                event.extra?.url?.takeIf { it.isNotBlank() }?.let { url ->
                    UrlRow(label = "链接", url = url)
                }
                if (event.rrule != null) {
                    MetaRow(label = "重复", value = formatRrule(event.rrule))
                }
            }
        },
        // Three actions in the bottom bar: 编辑 (primary), 删除 (text/error
        // tint), 关闭 (text). AlertDialog only gives us confirm + dismiss
        // slots, so we render the primary action on the right and pack
        // delete/close into dismiss as a single Row.
        confirmButton = {
            TextButton(onClick = { onEdit(event) }) { Text("编辑") }
        },
        dismissButton = {
            Row {
                TextButton(
                    onClick = { onDelete(event) },
                ) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
                TextButton(onClick = onDismiss) { Text("关闭") }
            }
        },
    )
}

@Composable
private fun MetaRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(
            label,
            modifier = Modifier.width(56.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        Spacer(Modifier.width(12.dp))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun UrlRow(label: String, url: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(
            label,
            modifier = Modifier.width(56.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        Spacer(Modifier.width(12.dp))
        Text(
            url,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .weight(1f)
                .clickable {
                    runCatching {
                        if (Desktop.isDesktopSupported()) Desktop.getDesktop().browse(URI(url))
                    }
                },
        )
    }
}

private val DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd EEEE").withZone(ZoneId.systemDefault())
private val DATETIME_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault())
private val TIME_FMT = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

private fun formatTimeBlock(event: EventDTO): String {
    val s = runCatching { Instant.parse(event.startsAt) }.getOrNull()
    val e = runCatching { Instant.parse(event.endsAt) }.getOrNull()
    if (s == null || e == null) return "${event.startsAt} – ${event.endsAt}"

    if (event.allDay) {
        // For all-day events the end is exclusive (next-day 00:00).
        val displayEnd = e.atZone(ZoneId.systemDefault()).toLocalDate().minusDays(1)
        val displayStart = s.atZone(ZoneId.systemDefault()).toLocalDate()
        return if (displayStart == displayEnd) "全天 · ${DATE_FMT.format(s)}"
               else "全天 · ${DATE_FMT.format(s)} – ${DATE_FMT.format(displayEnd.atStartOfDay(ZoneId.systemDefault()))}"
    }
    val sameDay = s.atZone(ZoneId.systemDefault()).toLocalDate() ==
                  e.atZone(ZoneId.systemDefault()).toLocalDate()
    return if (sameDay) "${DATETIME_FMT.format(s)} – ${TIME_FMT.format(e)}"
           else "${DATETIME_FMT.format(s)} – ${DATETIME_FMT.format(e)}"
}

/** Tiny RRULE prettifier — we only handle the common cases (DAILY /
 *  WEEKLY / MONTHLY / YEARLY); anything else falls through to the raw
 *  string so the user at least sees there's recurrence. */
private fun formatRrule(rrule: String): String {
    val parts = rrule.split(";").associate {
        val (k, v) = it.split("=", limit = 2).let { p -> p[0] to p.getOrElse(1) { "" } }
        k.uppercase() to v
    }
    val freq = parts["FREQ"]?.uppercase() ?: return rrule
    val interval = parts["INTERVAL"]?.toIntOrNull() ?: 1
    val base = when (freq) {
        "DAILY" -> if (interval == 1) "每天" else "每 $interval 天"
        "WEEKLY" -> if (interval == 1) "每周" else "每 $interval 周"
        "MONTHLY" -> if (interval == 1) "每月" else "每 $interval 个月"
        "YEARLY" -> if (interval == 1) "每年" else "每 $interval 年"
        else -> return rrule
    }
    val until = parts["UNTIL"]
    val count = parts["COUNT"]?.toIntOrNull()
    return when {
        until != null -> "$base · 至 $until"
        count != null -> "$base · 共 $count 次"
        else -> base
    }
}
