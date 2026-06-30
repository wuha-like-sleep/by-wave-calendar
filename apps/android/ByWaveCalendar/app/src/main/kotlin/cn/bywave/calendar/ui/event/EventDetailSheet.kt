// Read-only event detail, presented as a ModalBottomSheet from
// CalendarScreen. Mirrors iOS EventDetailView's sections:
//   title + calendar color
//   time (start / end / duration or "全天")
//   location
//   link (tappable, opens system browser)
//   attendees (count + first 3)
//   description
//   recurrence rule
//   delete (placeholder, wired in v0.3)
//
// We don't ship an "edit" button yet — v0.3 adds it.

package cn.bywave.calendar.ui.event

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.calendar.calendarColor
import cn.bywave.calendar.ui.calendar.calendarName
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.calendar.parseInstant
import cn.bywave.calendar.ui.theme.Radii
import cn.bywave.calendar.ui.theme.Sizing
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventDetailSheet(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    onDismiss: () -> Unit,
    onEdit: () -> Unit,
    onOpenAttendees: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        EventDetailContent(
            event = event,
            calendars = calendars,
            onEdit = onEdit,
            onOpenAttendees = onOpenAttendees,
        )
    }
}

@Composable
private fun EventDetailContent(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    onEdit: () -> Unit,
    onOpenAttendees: () -> Unit,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val color = calendarColor(event, calendars)
    val cal = calendarName(event, calendars)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Title + calendar dot
        Row(verticalAlignment = Alignment.Top) {
            Box(
                modifier = Modifier
                    .size(12.dp)
                    .clip(CircleShape)
                    .background(color)
                    .padding(top = 6.dp),
            )
            Spacer(Modifier.size(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = event.summary,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (cal != null) {
                    Text(
                        text = cal,
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                    )
                }
            }
            if (event.rrule != null) {
                Icon(
                    Icons.Default.Repeat,
                    contentDescription = stringResource(R.string.event_detail_recurring_badge),
                    tint = MaterialTheme.colorScheme.tertiary,
                )
            }
        }

        DetailRow(
            icon = Icons.Default.Schedule,
            label = stringResource(R.string.event_detail_time),
            value = formatTimeBlock(event, stringResource(R.string.event_allday)),
        )

        if (!event.location.isNullOrBlank()) {
            DetailRow(
                icon = Icons.Default.LocationOn,
                label = stringResource(R.string.event_location),
                value = event.location,
            )
        }

        if (!event.extra?.url.isNullOrBlank()) {
            val url = event.extra!!.url!!
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(Radii.fieldShape)
                    .clickable {
                        runCatching {
                            val intent = Intent(Intent.ACTION_VIEW, url.toUri())
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            context.startActivity(intent)
                        }
                    }
                    .heightIn(min = Sizing.minTouchTarget)
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(
                    Icons.Default.Link,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.size(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.event_link),
                        style = MaterialTheme.typography.labelSmall,
                        color = mutedTextColor(),
                    )
                    Text(
                        text = url,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary,
                        maxLines = 2,
                    )
                }
                Icon(
                    Icons.Default.OpenInNew,
                    contentDescription = null,
                    tint = mutedTextColor(),
                    modifier = Modifier.size(16.dp),
                )
            }
        }

        if (!event.extra?.meetingPassword.isNullOrBlank()) {
            val passcode = event.extra!!.meetingPassword!!
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(Radii.fieldShape)
                    .clickable {
                        clipboard.setText(AnnotatedString(passcode))
                        android.widget.Toast.makeText(
                            context,
                            context.getString(R.string.copied_to_clipboard),
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                    }
                    .heightIn(min = Sizing.minTouchTarget)
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(Icons.Default.Lock, contentDescription = null, tint = mutedTextColor())
                Spacer(Modifier.size(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.event_meeting_password),
                        style = MaterialTheme.typography.labelSmall,
                        color = mutedTextColor(),
                    )
                    Text(text = passcode, style = MaterialTheme.typography.bodyMedium)
                }
                Icon(
                    Icons.Default.ContentCopy,
                    contentDescription = null,
                    tint = mutedTextColor(),
                    modifier = Modifier.size(16.dp),
                )
            }
        }

        val attendees = event.extra?.attendees.orEmpty()
        // Always show the attendees row in edit-mode hosts so users can
        // add the first invitee. Read-mode (from CalendarScreen) only
        // shows it if there's already at least one invitee.
        if (attendees.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(Radii.fieldShape)
                    .clickable(onClick = onOpenAttendees)
                    .heightIn(min = Sizing.minTouchTarget)
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(Icons.Default.People, contentDescription = null, tint = mutedTextColor())
                Spacer(Modifier.size(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.event_detail_attendees_count, attendees.size),
                        style = MaterialTheme.typography.labelSmall,
                        color = mutedTextColor(),
                    )
                    for (email in attendees.take(3)) {
                        Text(text = email, style = MaterialTheme.typography.bodySmall)
                    }
                    if (attendees.size > 3) {
                        Text(
                            text = stringResource(R.string.event_detail_attendees_more, attendees.size - 3),
                            style = MaterialTheme.typography.labelSmall,
                            color = mutedTextColor(),
                        )
                    }
                }
                Icon(
                    Icons.Default.OpenInNew,
                    contentDescription = null,
                    tint = mutedTextColor(),
                    modifier = Modifier.size(16.dp),
                )
            }
        } else {
            // Empty state — still tappable so users can add the first.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(Radii.fieldShape)
                    .clickable(onClick = onOpenAttendees)
                    .heightIn(min = Sizing.minTouchTarget)
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.People, contentDescription = null, tint = mutedTextColor())
                Spacer(Modifier.size(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.event_detail_attendees),
                        style = MaterialTheme.typography.labelSmall,
                        color = mutedTextColor(),
                    )
                    Text(
                        text = stringResource(R.string.event_detail_attendees_empty),
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                    )
                }
                Icon(
                    Icons.Default.OpenInNew,
                    contentDescription = null,
                    tint = mutedTextColor(),
                    modifier = Modifier.size(16.dp),
                )
            }
        }

        if (!event.description.isNullOrBlank()) {
            Column {
                Text(
                    text = stringResource(R.string.event_description),
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                )
                Text(
                    text = event.description,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }

        if (!event.rrule.isNullOrBlank()) {
            Column {
                Text(
                    text = stringResource(R.string.event_detail_rrule),
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedTextColor(),
                )
                Text(
                    text = event.rrule,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                    color = mutedTextColor(),
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }

        // Edit button — full-width, leads into EventEditScreen which
        // ALSO contains the delete action (mirrors iOS — single screen
        // for the edit + delete flow).
        Button(
            onClick = onEdit,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(androidx.compose.material.icons.Icons.Default.Edit, contentDescription = null)
            Spacer(Modifier.size(8.dp))
            Text(stringResource(R.string.event_detail_edit))
        }

        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun DetailRow(icon: ImageVector, label: String, value: String) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(icon, contentDescription = null, tint = mutedTextColor())
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = mutedTextColor(),
            )
            Text(text = value, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

private val FULL_FMT = DateTimeFormatter.ofPattern("yyyy 年 M 月 d 日 HH:mm")
    .withZone(ZoneId.systemDefault())
private val DAY_FMT = DateTimeFormatter.ofPattern("yyyy 年 M 月 d 日")
    .withZone(ZoneId.systemDefault())

private fun formatTimeBlock(event: EventDTO, allDayLabel: String): String {
    val s = parseInstant(event.startsAt)
    val e = parseInstant(event.endsAt)
    if (s == null || e == null) return "—"
    if (event.allDay) return "${DAY_FMT.format(s)}（$allDayLabel）"
    return "${FULL_FMT.format(s)}\n至 ${FULL_FMT.format(e)}"
}
