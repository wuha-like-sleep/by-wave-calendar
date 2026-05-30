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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
    // Observe locale so menu item labels re-render on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(
            text = { Text(t("event.menu.view")) },
            onClick = { onDismiss(); onView(event) },
        )
        DropdownMenuItem(
            text = { Text(t("event.detail.edit")) },
            onClick = { onDismiss(); onEdit(event) },
        )
        DropdownMenuItem(
            text = { Text(t("event.menu.duplicate")) },
            onClick = { onDismiss(); onDuplicate(event) },
        )
        DropdownMenuItem(
            text = { Text(t("event.detail.delete"), color = MaterialTheme.colorScheme.error) },
            onClick = { onDismiss(); onDelete(event) },
        )
    }
}
