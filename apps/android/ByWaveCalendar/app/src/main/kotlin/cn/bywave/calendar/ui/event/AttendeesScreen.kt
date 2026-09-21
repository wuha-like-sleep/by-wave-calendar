// AttendeesScreen — dedicated full-screen page for inviting + revoking
// event attendees. Reached from EventDetailSheet ("邀请人 (N 人)" row)
// and EventEditScreen ("管理参与者"). Mirrors iOS AttendeesPage.swift.

package cn.bywave.calendar.ui.event

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PersonRemove
import androidx.compose.material.icons.outlined.GroupAdd
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.ui.components.EmptyState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttendeesScreen(
    eventId: String,
    eventTitle: String,
    onBack: () -> Unit,
    vm: AttendeesViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    LaunchedEffect(eventId) { vm.bootstrap(eventId) }
    // 撤销邀请原来是「点一下图标，人就没了」——图标就贴在邮箱右边，
    // 滑动列表时很容易误触，而且撤销之后没有任何撤回的路，只能重新邀请
    // 再让对方重新接受。加一步确认，并把是谁写进提示里。
    var pendingRevoke by remember { mutableStateOf<String?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = stringResource(R.string.event_detail_attendees),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        if (eventTitle.isNotBlank()) {
                            Text(
                                text = eventTitle,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.attendees_back))
                    }
                },
            )
        },
    ) { padding ->
        // 同 SetupScreen：edge-to-edge 下键盘不会自动把内容顶上去，
        // 邀请框下面的名单会被键盘整个盖住。
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .padding(horizontal = 16.dp),
        ) {
            Spacer(Modifier.size(8.dp))

            // Invite input row
            Text(
                text = stringResource(R.string.attendees_invite_section),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = state.emailInput,
                    onValueChange = vm::onEmailInput,
                    placeholder = { Text("name@example.com") },
                    singleLine = true,
                    enabled = !state.sending,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = vm::invite,
                    enabled = !state.sending && state.emailInput.isNotBlank(),
                ) {
                    if (state.sending) CircularProgressIndicator(
                        modifier = Modifier.size(18.dp), strokeWidth = 2.dp,
                    )
                    else Text(stringResource(R.string.attendees_invite_button))
                }
            }
            val errMsg = state.errorMessage  // delegated state doesn't smart-cast
            if (errMsg != null) {
                Text(
                    text = errMsg,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }

            Spacer(Modifier.size(16.dp))
            HorizontalDivider()

            // Current attendees list
            Text(
                text = stringResource(R.string.attendees_current_count, state.attendees.size),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp),
            )

            if (state.loading && state.attendees.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else if (state.attendees.isEmpty()) {
                EmptyState(
                    icon = Icons.Outlined.GroupAdd,
                    title = stringResource(R.string.attendees_empty_title),
                    subtitle = stringResource(R.string.attendees_empty_subtitle),
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(items = state.attendees, key = { it }) { email ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = email,
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            IconButton(onClick = { pendingRevoke = email }) {
                                Icon(
                                    Icons.Default.PersonRemove,
                                    contentDescription = stringResource(R.string.attendees_revoke),
                                    tint = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                        HorizontalDivider()
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }

    val toRevoke = pendingRevoke
    if (toRevoke != null) {
        AlertDialog(
            onDismissRequest = { pendingRevoke = null },
            title = { Text(stringResource(R.string.attendees_revoke_title)) },
            text = { Text(stringResource(R.string.attendees_revoke_message, toRevoke)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingRevoke = null
                    vm.revoke(toRevoke)
                }) { Text(stringResource(R.string.attendees_revoke)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingRevoke = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}
