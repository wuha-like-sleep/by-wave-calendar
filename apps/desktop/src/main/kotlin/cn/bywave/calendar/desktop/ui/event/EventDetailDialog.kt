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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
    // Observe locale so all labels + formatted strings re-render on switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val color = calendarColor(event, calendars)
    val cal = calendarName(event, calendars)
    val timeBlock = remember(locale, event) { formatTimeBlock(event) }

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
                MetaRow(label = t("event.detail.time"), value = timeBlock)
                if (cal != null) MetaRow(label = t("event.detail.calendar"), value = cal)
                event.location?.takeIf { it.isNotBlank() }?.let {
                    MetaRow(label = t("event.detail.location"), value = it)
                }
                event.extra?.timezone?.takeIf { it.isNotBlank() }?.let {
                    MetaRow(label = t("event.detail.timezone"), value = it)
                }
                event.description?.takeIf { it.isNotBlank() }?.let {
                    MetaRow(label = t("event.detail.description"), value = it)
                }
                event.extra?.url?.takeIf { it.isNotBlank() }?.let { url ->
                    UrlRow(label = t("event.detail.url"), url = url)
                }
                if (event.rrule != null) {
                    MetaRow(label = t("event.detail.recurrence"), value = formatRrule(event.rrule))
                }
            }
        },
        // Three actions in the bottom bar: 编辑 (primary), 删除 (text/error
        // tint), 关闭 (text). AlertDialog only gives us confirm + dismiss
        // slots, so we render the primary action on the right and pack
        // delete/close into dismiss as a single Row.
        confirmButton = {
            TextButton(onClick = { onEdit(event) }) { Text(t("event.detail.edit")) }
        },
        dismissButton = {
            Row {
                TextButton(
                    onClick = { onDelete(event) },
                ) {
                    Text(t("event.detail.delete"), color = MaterialTheme.colorScheme.error)
                }
                TextButton(onClick = onDismiss) { Text(t("event.detail.close")) }
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

// Weekday/month names inside these formatters follow the UI locale (the
// EEEE token). Rebuilt per call so a language switch is reflected; the
// numeric yyyy-MM-dd / HH:mm parts are locale-neutral. Display zone stays
// the device default.
private fun uiLocale(): java.util.Locale =
    java.util.Locale.forLanguageTag(cn.bywave.calendar.desktop.i18n.I18n.current.value.code)

private fun dateFmt() =
    DateTimeFormatter.ofPattern("yyyy-MM-dd EEEE", uiLocale()).withZone(ZoneId.systemDefault())
private val DATETIME_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault())
private val TIME_FMT = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

private fun t(key: String): String = cn.bywave.calendar.desktop.i18n.I18n.t(key)
private fun t(key: String, vars: Map<String, Any>): String =
    cn.bywave.calendar.desktop.i18n.I18n.t(key, vars)

private fun formatTimeBlock(event: EventDTO): String {
    val s = runCatching { Instant.parse(event.startsAt) }.getOrNull()
    val e = runCatching { Instant.parse(event.endsAt) }.getOrNull()
    if (s == null || e == null) return "${event.startsAt} – ${event.endsAt}"

    val dateFmt = dateFmt()
    if (event.allDay) {
        // For all-day events the end is exclusive (next-day 00:00).
        val displayEnd = e.atZone(ZoneId.systemDefault()).toLocalDate().minusDays(1)
        val displayStart = s.atZone(ZoneId.systemDefault()).toLocalDate()
        val allDay = t("event.allDay")
        return if (displayStart == displayEnd) "$allDay · ${dateFmt.format(s)}"
               else "$allDay · ${dateFmt.format(s)} – ${dateFmt.format(displayEnd.atStartOfDay(ZoneId.systemDefault()))}"
    }
    val sameDay = s.atZone(ZoneId.systemDefault()).toLocalDate() ==
                  e.atZone(ZoneId.systemDefault()).toLocalDate()
    return if (sameDay) "${DATETIME_FMT.format(s)} – ${TIME_FMT.format(e)}"
           else "${DATETIME_FMT.format(s)} – ${DATETIME_FMT.format(e)}"
}

/** Tiny RRULE prettifier — we only handle the common cases (DAILY /
 *  WEEKLY / MONTHLY / YEARLY); anything else falls through to the raw
 *  string so the user at least sees there's recurrence. Localized via
 *  i18n; resolved at call time so it follows the current UI language. */
private fun formatRrule(rrule: String): String {
    val parts = rrule.split(";").associate {
        val (k, v) = it.split("=", limit = 2).let { p -> p[0] to p.getOrElse(1) { "" } }
        k.uppercase() to v
    }
    val freq = parts["FREQ"]?.uppercase() ?: return rrule
    val interval = parts["INTERVAL"]?.toIntOrNull() ?: 1
    val base = when (freq) {
        "DAILY" -> if (interval == 1) t("event.rrule.daily") else t("event.rrule.dailyN", mapOf("n" to interval))
        "WEEKLY" -> if (interval == 1) t("event.rrule.weekly") else t("event.rrule.weeklyN", mapOf("n" to interval))
        "MONTHLY" -> if (interval == 1) t("event.rrule.monthly") else t("event.rrule.monthlyN", mapOf("n" to interval))
        "YEARLY" -> if (interval == 1) t("event.rrule.yearly") else t("event.rrule.yearlyN", mapOf("n" to interval))
        else -> return rrule
    }
    val until = parts["UNTIL"]
    val count = parts["COUNT"]?.toIntOrNull()
    return when {
        until != null -> t("event.rrule.until", mapOf("base" to base, "date" to until))
        count != null -> t("event.rrule.count", mapOf("base" to base, "n" to count))
        else -> base
    }
}
