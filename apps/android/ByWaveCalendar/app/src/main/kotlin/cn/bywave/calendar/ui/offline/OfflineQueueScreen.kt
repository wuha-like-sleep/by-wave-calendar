// 离线队列页 + 日历页顶上的待同步指示条。
//
// 队列里两种条目：
//   · 待同步（PENDING）——还没送到服务端，网络恢复会自动重放，
//     这里只展示，不用管；
//   · 待处理（ATTENTION）——被服务端明确拒绝（版本冲突 / 校验
//     失败之类），自动重试没意义，必须用户逐条裁决：保留我的
//     修改（重新入队再打一次）/ 采用服务端版本 / 放弃。

package cn.bywave.calendar.ui.offline

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.SyncProblem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.data.store.AttentionResolution
import cn.bywave.calendar.sync.PendingOp
import cn.bywave.calendar.sync.PendingOpKind
import cn.bywave.calendar.sync.PendingOpState
import cn.bywave.calendar.ui.calendar.CalendarViewModel

/** 日历页顶上的指示条：有待处理时优先报待处理（要用户动手），
 *  否则报待同步数量。点进队列页。队列空了整条消失。 */
@Composable
fun PendingSyncBar(
    pendingCount: Int,
    attentionCount: Int,
    onClick: () -> Unit,
) {
    val needsAttention = attentionCount > 0
    Surface(
        color = if (needsAttention) MaterialTheme.colorScheme.errorContainer
        else MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = if (needsAttention) Icons.Default.SyncProblem else Icons.Default.CloudOff,
                contentDescription = null,
                tint = if (needsAttention) MaterialTheme.colorScheme.onErrorContainer
                else MaterialTheme.colorScheme.onSecondaryContainer,
            )
            Text(
                text = if (needsAttention) {
                    stringResource(R.string.offline_bar_attention, attentionCount)
                } else {
                    stringResource(R.string.offline_bar_pending, pendingCount)
                },
                style = MaterialTheme.typography.bodyMedium,
                color = if (needsAttention) MaterialTheme.colorScheme.onErrorContainer
                else MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OfflineQueueScreen(
    onBack: () -> Unit,
    vm: CalendarViewModel = viewModel(),
) {
    val ops by vm.pendingOps.collectAsState()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.offline_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.offline_back),
                        )
                    }
                },
            )
        },
    ) { innerPadding ->
        if (ops.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(innerPadding).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = stringResource(R.string.offline_empty_title),
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    text = stringResource(R.string.offline_empty_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(innerPadding),
            ) {
                items(ops, key = { it.id }) { op ->
                    PendingOpRow(
                        op = op,
                        onResolve = { vm.resolveAttention(op.id, it) },
                    )
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun PendingOpRow(
    op: PendingOp,
    onResolve: (AttentionResolution) -> Unit,
) {
    val kindLabel = stringResource(
        when (op.kind) {
            PendingOpKind.CREATE -> R.string.offline_kind_create
            PendingOpKind.UPDATE -> R.string.offline_kind_update
            PendingOpKind.DELETE -> R.string.offline_kind_delete
        },
    )
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
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
                    ?: stringResource(R.string.offline_attention_default_reason),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { onResolve(AttentionResolution.KEEP_MINE) }) {
                    Text(stringResource(R.string.offline_action_keep_mine))
                }
                TextButton(onClick = { onResolve(AttentionResolution.USE_SERVER) }) {
                    Text(stringResource(R.string.offline_action_use_server))
                }
                TextButton(onClick = { onResolve(AttentionResolution.DISCARD) }) {
                    Text(stringResource(R.string.offline_action_discard))
                }
            }
        } else {
            Text(
                text = stringResource(R.string.offline_state_pending),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
