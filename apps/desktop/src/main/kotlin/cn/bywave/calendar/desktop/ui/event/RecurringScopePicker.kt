// RecurringScopePicker — "三选一" for editing / deleting a recurring
// event. Mirrors iOS / Android equivalents but uses a centered Dialog
// instead of a BottomSheet (sheets feel awkward on desktop).
//
// Why this exists: without an explicit scope, server defaults to "series"
// which silently rewrites/deletes the whole repeating set when the user
// only meant a single occurrence. The picker forces the choice.

package cn.bywave.calendar.desktop.ui.event

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.LooksOne
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.ui.theme.Dimens
import cn.bywave.calendar.desktop.ui.theme.hoverHighlight
import cn.bywave.calendar.desktop.ui.theme.rowShape

/** Server's scope enum, sent as ?scope=instance|future|series on
 *  PATCH/DELETE. Matches src/routes/events.ts. */
enum class RecurringScope(val wire: String) {
    Instance("instance"),
    Future("future"),
    Series("series"),
}

enum class RecurringAction { Edit, Delete }

@Composable
fun RecurringScopePicker(
    action: RecurringAction,
    onPick: (RecurringScope) -> Unit,
    onDismiss: () -> Unit,
) {
    // Observe locale so dialog copy re-renders on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val isEdit = action == RecurringAction.Edit
    val title = if (isEdit) t("recur.editTitle") else t("recur.deleteTitle")
    val subtitle = if (isEdit) t("recur.editSubtitle") else t("recur.deleteSubtitle")

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.size(4.dp))
                ScopeRow(
                    icon = Icons.Outlined.LooksOne,
                    title = t("recur.thisEvent"),
                    detail = if (isEdit) t("recur.thisEvent.edit") else t("recur.thisEvent.delete"),
                    onClick = { onPick(RecurringScope.Instance) },
                )
                ScopeRow(
                    icon = Icons.AutoMirrored.Filled.ArrowForward,
                    title = t("recur.thisAndFuture"),
                    detail = if (isEdit) t("recur.future.edit") else t("recur.future.delete"),
                    onClick = { onPick(RecurringScope.Future) },
                )
                ScopeRow(
                    icon = Icons.Filled.Refresh,
                    title = t("recur.series"),
                    detail = if (isEdit) t("recur.series.edit") else t("recur.series.delete"),
                    tint = if (action == RecurringAction.Delete) MaterialTheme.colorScheme.error else null,
                    onClick = { onPick(RecurringScope.Series) },
                )
            }
        },
        confirmButton = { /* picker has its own buttons */ Box {} },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(t("recur.cancel")) }
        },
    )
}

@Composable
private fun ScopeRow(
    icon: ImageVector,
    title: String,
    detail: String,
    tint: Color? = null,
    onClick: () -> Unit,
) {
    val tintColor = tint ?: MaterialTheme.colorScheme.primary
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(rowShape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = Dimens.cardFillAlpha))
            .hoverHighlight(interaction, rowShape)
            .pointerHoverIcon(PointerIcon.Hand)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tintColor, modifier = Modifier.size(22.dp))
        Spacer(Modifier.size(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
