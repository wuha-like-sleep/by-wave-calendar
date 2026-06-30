// EventActionsSheet — long-press menu for an event row / chip. Lists
// the same four actions iOS surfaces via context menu:
//   编辑 / 删除 / 复制为新事件 / 邀请人
//
// Tap → CalendarScreen's bottom sheet detail (unchanged). Long-press
// → this. Both close on action select.

package cn.bywave.calendar.ui.event

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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.People
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.calendar.calendarColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventActionsSheet(
    event: EventDTO,
    calendars: List<CalendarMeta>,
    onEdit: () -> Unit,
    onDuplicate: () -> Unit,
    onDelete: () -> Unit,
    onOpenAttendees: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(modifier = Modifier.padding(bottom = 8.dp)) {
            // Tiny header that confirms which event the actions apply
            // to — important when the user opens it from a busy week
            // grid and might have grabbed the wrong row.
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(calendarColor(event, calendars)),
                )
                Spacer(Modifier.size(10.dp))
                Text(
                    text = event.summary,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                )
            }
            HorizontalDivider()

            ActionItem(icon = Icons.Default.Edit, label = stringResource(R.string.event_detail_edit), onClick = onEdit)
            ActionItem(icon = Icons.Default.ContentCopy, label = stringResource(R.string.eventactions_duplicate), onClick = onDuplicate)
            ActionItem(icon = Icons.Default.People, label = stringResource(R.string.event_detail_attendees), onClick = onOpenAttendees)
            HorizontalDivider()
            ActionItem(
                icon = Icons.Default.Delete,
                label = stringResource(R.string.action_delete),
                danger = true,
                onClick = onDelete,
            )
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun ActionItem(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    danger: Boolean = false,
) {
    val color = if (danger) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurface
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(icon, contentDescription = null, tint = color)
        Text(label, color = color, fontWeight = FontWeight.Medium)
    }
}
