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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

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
    val title = if (action == RecurringAction.Edit) "保存重复事件" else "删除重复事件"
    val subtitle = if (action == RecurringAction.Edit)
        "这是一个重复事件，请选择保存范围："
    else
        "这是一个重复事件，请选择删除范围："

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
                    title = "仅此事件",
                    detail = if (action == RecurringAction.Edit) "只修改这一次" else "只删除这一次",
                    onClick = { onPick(RecurringScope.Instance) },
                )
                ScopeRow(
                    icon = Icons.AutoMirrored.Filled.ArrowForward,
                    title = "此事件及后续",
                    detail = if (action == RecurringAction.Edit) "修改此次及之后" else "删除此次及之后",
                    onClick = { onPick(RecurringScope.Future) },
                )
                ScopeRow(
                    icon = Icons.Filled.Refresh,
                    title = "整个系列",
                    detail = if (action == RecurringAction.Edit) "修改整个系列" else "删除整个系列",
                    tint = if (action == RecurringAction.Delete) MaterialTheme.colorScheme.error else null,
                    onClick = { onPick(RecurringScope.Series) },
                )
            }
        },
        confirmButton = { /* picker has its own buttons */ Box {} },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
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
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .clickable(onClick = onClick)
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
