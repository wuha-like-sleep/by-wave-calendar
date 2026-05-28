// Right-click context menu for an event chip. Desktop replaces Android's
// long-press gesture with secondary-button click — same actions, more
// natural for mouse + keyboard users.
//
// Position: anchored to the chip via Compose's DropdownMenu, which
// renders a popup at the cursor (we don't need manual offsets thanks
// to the box layout owning the chip).

package cn.bywave.calendar.desktop.ui.event

import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import cn.bywave.calendar.desktop.data.model.EventDTO

@Composable
fun EventContextMenu(
    expanded: Boolean,
    event: EventDTO,
    onDismiss: () -> Unit,
    onView: (EventDTO) -> Unit,
    onEdit: (EventDTO) -> Unit,
    onDuplicate: (EventDTO) -> Unit,
    onDelete: (EventDTO) -> Unit,
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(
            text = { Text("查看详情") },
            onClick = { onDismiss(); onView(event) },
        )
        DropdownMenuItem(
            text = { Text("编辑") },
            onClick = { onDismiss(); onEdit(event) },
        )
        DropdownMenuItem(
            text = { Text("复制为新建") },
            onClick = { onDismiss(); onDuplicate(event) },
        )
        DropdownMenuItem(
            text = { Text("删除", color = MaterialTheme.colorScheme.error) },
            onClick = { onDismiss(); onDelete(event) },
        )
    }
}
