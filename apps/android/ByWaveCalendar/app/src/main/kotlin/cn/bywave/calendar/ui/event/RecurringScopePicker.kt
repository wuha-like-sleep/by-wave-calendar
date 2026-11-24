// RecurringScopePicker — bottom-sheet "三选一" for editing/deleting a
// recurring event. Mirrors iOS RecurringScopePicker.swift + web's modal
// so users get the same mental model across all three clients.
//
// Why this exists: before v0.8.3 Android always sent edits/deletes
// without a `scope` query param, which the server interpreted as the
// whole series. Users who deleted one instance of a daily meeting
// found the entire series gone — silent data loss. The picker forces
// an explicit choice when the event is recurring.

package cn.bywave.calendar.ui.event

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.LooksOne
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.ui.theme.Radii
import cn.bywave.calendar.ui.theme.Sizing

/** Server's scope enum, sent as ?scope=instance|future|series on
 *  PATCH/DELETE. Mirrors src/routes/events.ts. */
enum class RecurringScope(val wire: String) {
    Instance("instance"),
    Future("future"),
    Series("series"),
}

/** Whether the picker is opened during an edit save or a delete. Drives
 *  the title + per-option subtitle copy. */
enum class RecurringAction { Edit, Delete }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecurringScopePicker(
    action: RecurringAction,
    onPick: (RecurringScope) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // 删除范围的选定不给触觉：触觉定版口径只给正向确认（保存
    // 成功、RSVP、清单勾选），删除一律不震。早先这里与普通
    // 删除弹窗都带震动，注释称对齐 iOS，但 iOS 删除路径从来
    // 不震，本次一并摘除。
    val pick: (RecurringScope) -> Unit = { scope ->
        onPick(scope)
    }
    val title = if (action == RecurringAction.Edit)
        stringResource(R.string.scope_save_title)
    else
        stringResource(R.string.scope_delete_title)
    val subtitle = if (action == RecurringAction.Edit)
        stringResource(R.string.scope_save_subtitle)
    else
        stringResource(R.string.scope_delete_subtitle)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.size(8.dp))

            ScopeRow(
                icon = Icons.Outlined.LooksOne,
                title = stringResource(R.string.scope_this_only),
                detail = if (action == RecurringAction.Edit)
                    stringResource(R.string.scope_this_only_edit)
                else
                    stringResource(R.string.scope_this_only_delete),
                onClick = { pick(RecurringScope.Instance) },
            )
            ScopeRow(
                icon = Icons.AutoMirrored.Filled.ArrowForward,
                title = stringResource(R.string.scope_this_future),
                detail = if (action == RecurringAction.Edit)
                    stringResource(R.string.scope_this_future_edit)
                else
                    stringResource(R.string.scope_this_future_delete),
                onClick = { pick(RecurringScope.Future) },
            )
            ScopeRow(
                icon = Icons.Filled.Refresh,
                title = stringResource(R.string.scope_series),
                detail = if (action == RecurringAction.Edit)
                    stringResource(R.string.scope_series_edit)
                else
                    stringResource(R.string.scope_series_delete),
                tint = if (action == RecurringAction.Delete) MaterialTheme.colorScheme.error else null,
                onClick = { pick(RecurringScope.Series) },
            )

            Spacer(Modifier.size(4.dp))
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.action_cancel)) }
        }
    }
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
            .clip(Radii.cardShape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .clickable(onClick = onClick)
            .heightIn(min = Sizing.minTouchTarget)
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
