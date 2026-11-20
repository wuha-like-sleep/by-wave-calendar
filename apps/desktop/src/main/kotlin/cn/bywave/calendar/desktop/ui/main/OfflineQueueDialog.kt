// OfflineQueueDialog — 离线队列的主界面指示条 + 队列弹窗。
//
// 队列里两种条目：
//   · 待同步——还没送到服务端，网络恢复自动重放，这里只展示；
//   · 待处理——被服务端明确拒绝（版本冲突 / 校验失败之类），自动
//     重试没意义，用户逐条裁决：保留我的修改（重新入队再打一次）/
//     采用服务端版本 / 放弃。

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.offline.AttentionResolution
import cn.bywave.calendar.desktop.i18n.I18n
import cn.bywave.calendar.sync.PendingOp
import cn.bywave.calendar.sync.PendingOpKind
import cn.bywave.calendar.sync.PendingOpState

/** 主界面上的指示条：有待处理时优先报待处理（要用户动手），
 *  否则报待同步数量。点开队列弹窗。队列空了整条不出现。 */
@Composable
fun PendingSyncBanner(
    pendingCount: Int,
    attentionCount: Int,
    onClick: () -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val needsAttention = attentionCount > 0
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (needsAttention) MaterialTheme.colorScheme.errorContainer
                else MaterialTheme.colorScheme.secondaryContainer,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Text(
            text = remember(locale, pendingCount, attentionCount) {
                if (needsAttention) {
                    I18n.t("offline.bar.attention", mapOf("count" to attentionCount))
                } else {
                    I18n.t("offline.bar.pending", mapOf("count" to pendingCount))
                }
            },
            style = MaterialTheme.typography.bodyMedium,
            color = if (needsAttention) MaterialTheme.colorScheme.onErrorContainer
            else MaterialTheme.colorScheme.onSecondaryContainer,
        )
    }
}

@Composable
fun OfflineQueueDialog(
    ops: List<PendingOp>,
    onResolve: (String, AttentionResolution) -> Unit,
    onDismiss: () -> Unit,
) {
    val locale by I18n.current.collectAsState()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(remember(locale) { I18n.t("offline.title") }) },
        text = {
            if (ops.isEmpty()) {
                Text(remember(locale) { I18n.t("offline.empty") })
            } else {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    ops.forEach { op ->
                        PendingOpRow(op = op, onResolve = onResolve)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(remember(locale) { I18n.t("offline.close") })
            }
        },
    )
}

@Composable
private fun PendingOpRow(
    op: PendingOp,
    onResolve: (String, AttentionResolution) -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val kindLabel = remember(locale, op.kind) {
        I18n.t(
            when (op.kind) {
                PendingOpKind.CREATE -> "offline.kind.create"
                PendingOpKind.UPDATE -> "offline.kind.update"
                PendingOpKind.DELETE -> "offline.kind.delete"
            },
        )
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = op.summary.ifBlank { kindLabel },
            style = MaterialTheme.typography.titleSmall,
        )
        Text(
            text = kindLabel,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (op.state == PendingOpState.ATTENTION) {
            Text(
                text = op.errorMessage?.takeIf { it.isNotBlank() }
                    ?: remember(locale) { I18n.t("offline.attention.defaultReason") },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { onResolve(op.id, AttentionResolution.KEEP_MINE) }) {
                    Text(remember(locale) { I18n.t("offline.action.keepMine") })
                }
                TextButton(onClick = { onResolve(op.id, AttentionResolution.USE_SERVER) }) {
                    Text(remember(locale) { I18n.t("offline.action.useServer") })
                }
                TextButton(onClick = { onResolve(op.id, AttentionResolution.DISCARD) }) {
                    Text(remember(locale) { I18n.t("offline.action.discard") })
                }
            }
        } else {
            Text(
                text = remember(locale) { I18n.t("offline.state.pending") },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
