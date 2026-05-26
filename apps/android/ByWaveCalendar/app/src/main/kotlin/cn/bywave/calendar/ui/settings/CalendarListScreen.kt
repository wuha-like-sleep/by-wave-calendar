// "管理日历" screen — added in v0.8.2 because the platform had no way
// to rename a calendar after creation. Imported calendars were stuck
// with the auto-generated "导入的日历" name forever, and the default
// timezone was likewise immutable.
//
// Lists every calendar the active profile owns. Tap a row → bottom
// sheet with name + color + timezone fields. Save calls PATCH and
// triggers a CalendarViewModel.reload so the calendar drop-downs in
// event-edit, the sidebar, and elsewhere immediately reflect the new
// name without an app restart.
//
// We deliberately keep this view-only-for-editing — calendar create
// and delete remain in v0.9+ scope (server supports both, but the
// matching UI flows for color picker + "are you sure?" delete confirm
// + timezone search aren't here yet).

package cn.bywave.calendar.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.CalendarUpdateInput
import cn.bywave.calendar.ui.calendar.CalendarViewModel
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.calendar.parseHex
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarListScreen(
    onBack: () -> Unit,
    vm: CalendarViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    var editing by remember { mutableStateOf<CalendarMeta?>(null) }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("管理日历") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            if (state.calendars.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("还没有日历", color = mutedTextColor())
                }
            } else {
                state.calendars.forEachIndexed { i, c ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { editing = c }
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(12.dp)
                                .clip(CircleShape)
                                .background(parseHex(c.color)),
                        )
                        Spacer(Modifier.size(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = c.name,
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.Medium,
                            )
                            val sub = listOfNotNull(c.timezone).joinToString(" · ")
                            if (sub.isNotBlank()) {
                                Text(
                                    text = sub,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = mutedTextColor(),
                                )
                            }
                        }
                        Text(text = "编辑", style = MaterialTheme.typography.labelMedium, color = mutedTextColor())
                    }
                    if (i < state.calendars.size - 1) HorizontalDivider()
                }
            }
        }
    }

    val target = editing
    if (target != null) {
        EditCalendarSheet(
            calendar = target,
            onDismiss = { editing = null },
            onSaved = {
                editing = null
                vm.reload()
                snackbar.let { /* scope it below */ }
            },
            snackbar = snackbar,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditCalendarSheet(
    calendar: CalendarMeta,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
    snackbar: SnackbarHostState,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var name by remember(calendar.id) { mutableStateOf(calendar.name) }
    var timezone by remember(calendar.id) { mutableStateOf(calendar.timezone.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Dirty-check — disable Save when nothing changed, or name went
    // blank (server requires min length 1).
    val canSave = !busy &&
        name.isNotBlank() &&
        (name != calendar.name || timezone != calendar.timezone.orEmpty())

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(14.dp)
                        .clip(CircleShape)
                        .background(parseHex(calendar.color)),
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    text = "编辑日历",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("名称") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                isError = name.isBlank(),
                supportingText = if (name.isBlank()) {
                    { Text("名称不能为空", color = MaterialTheme.colorScheme.error) }
                } else null,
            )

            OutlinedTextField(
                value = timezone,
                onValueChange = { timezone = it.trim() },
                label = { Text("默认时区") },
                singleLine = true,
                placeholder = { Text("Asia/Shanghai") },
                keyboardOptions = KeyboardOptions.Default,
                modifier = Modifier.fillMaxWidth(),
                supportingText = {
                    Text(
                        text = "IANA 时区 id，新建事件时的默认时区；已有事件保留各自的时区",
                        color = mutedTextColor(),
                    )
                },
            )

            // We deliberately don't expose color editing here yet —
            // a proper swatch picker matching iOS is its own task.
            // Users wanting to change color can do it from web (which
            // is fully wired in v1.3.6).

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = onDismiss,
                    enabled = !busy,
                    colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(),
                ) { Text("取消") }
                Button(
                    enabled = canSave,
                    onClick = {
                        scope.launch {
                            busy = true
                            error = null
                            try {
                                val profile = BywaveApp.instance.profiles.active()
                                    ?: throw IllegalStateException("未登录")
                                val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                                val body = CalendarUpdateInput(
                                    // Only send fields that actually changed — the server's
                                    // partial schema accepts the smaller payload happily and
                                    // it makes log lines easier to read.
                                    name = name.takeIf { it != calendar.name },
                                    timezone = timezone.takeIf { it != calendar.timezone.orEmpty() }
                                        ?.takeIf { it.isNotBlank() },
                                )
                                client.api.updateCalendar(calendar.id, body)
                                snackbar.showSnackbar("已保存")
                                onSaved()
                            } catch (e: Exception) {
                                error = e.localizedMessage ?: "保存失败"
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) {
                    if (busy) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Text("保存")
                    }
                }
            }
        }
    }
}
