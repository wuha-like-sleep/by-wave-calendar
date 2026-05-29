// "管理日历" screen.
//
// v0.8.2 — first shipped as edit-only (rename + timezone) because the
// platform had no way to rename a calendar after creation; imported
// calendars were stuck with the auto-generated name.
//
// v0.11 — feature parity with web/iOS: calendar CREATE (name + color +
// timezone + description), calendar DELETE (cascade-warning confirm),
// color picker on both create + edit, and per-calendar SUBSCRIBE-LINK
// management (list / generate / copy / revoke) mirroring web
// app/calendar.ejs. The server's POST/DELETE /calendars and the three
// share-token endpoints supported all of this already; this is the
// missing native UI.
//
// Lists every calendar the active profile owns. Tap a row → bottom
// sheet with name + color + timezone + description + share links +
// delete. Saving / creating / deleting triggers CalendarViewModel.reload
// so the calendar drop-downs in event-edit, the sidebar, and elsewhere
// immediately reflect the change without an app restart.

package cn.bywave.calendar.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.CalendarCreateRequest
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.CalendarUpdateInput
import cn.bywave.calendar.data.model.ShareToken
import cn.bywave.calendar.data.model.ShareTokenCreateRequest
import cn.bywave.calendar.ui.calendar.CalendarViewModel
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.calendar.parseHex
import kotlinx.coroutines.launch

// iOS-parity swatch palette. Same 8 presets the iOS calendar editor
// offers; keep them as valid 6-hex so the server's color regex accepts
// the value verbatim. First entry doubles as the new-calendar default.
private val CALENDAR_COLOR_SWATCHES = listOf(
    "#6640E9", // brand purple (FALLBACK_COLOR)
    "#2F6FED", // blue
    "#16A34A", // green
    "#EA580C", // orange
    "#DC2626", // red
    "#DB2777", // pink
    "#0891B2", // teal
    "#737373", // gray
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarListScreen(
    onBack: () -> Unit,
    vm: CalendarViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    var editing by remember { mutableStateOf<CalendarMeta?>(null) }
    var creating by remember { mutableStateOf(false) }

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
                actions = {
                    IconButton(onClick = { creating = true }) {
                        Icon(Icons.Default.Add, contentDescription = stringResource(R.string.calendars_new))
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
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("还没有日历", color = mutedTextColor())
                        Spacer(Modifier.size(12.dp))
                        OutlinedButton(onClick = { creating = true }) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(6.dp))
                            Text(stringResource(R.string.calendars_new))
                        }
                    }
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
            },
            snackbar = snackbar,
        )
    }

    if (creating) {
        CreateCalendarSheet(
            onDismiss = { creating = false },
            onCreated = {
                creating = false
                vm.reload()
            },
            snackbar = snackbar,
        )
    }
}

// ---- Shared swatch picker ----

@Composable
private fun ColorSwatchRow(
    selected: String,
    onPick: (String) -> Unit,
) {
    Column {
        Text(
            text = stringResource(R.string.calendars_color),
            style = MaterialTheme.typography.bodyMedium,
            color = mutedTextColor(),
        )
        Spacer(Modifier.size(6.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(CALENDAR_COLOR_SWATCHES) { hex ->
                val isSel = hex.equals(selected, ignoreCase = true)
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(CircleShape)
                        .background(parseHex(hex))
                        .border(
                            width = if (isSel) 3.dp else 0.dp,
                            color = if (isSel) MaterialTheme.colorScheme.onSurface else Color.Transparent,
                            shape = CircleShape,
                        )
                        .clickable { onPick(hex) },
                    contentAlignment = Alignment.Center,
                ) {
                    if (isSel) {
                        Icon(
                            Icons.Default.Check,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
    }
}

// ---- Create ----

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CreateCalendarSheet(
    onDismiss: () -> Unit,
    onCreated: () -> Unit,
    snackbar: SnackbarHostState,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var name by remember { mutableStateOf("") }
    var color by remember { mutableStateOf(CALENDAR_COLOR_SWATCHES.first()) }
    var timezone by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val canCreate = !busy && name.isNotBlank()

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
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
                        .background(parseHex(color)),
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    text = stringResource(R.string.calendars_new_title),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.calendars_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                isError = name.isBlank(),
                supportingText = if (name.isBlank()) {
                    { Text(stringResource(R.string.calendars_name_empty), color = MaterialTheme.colorScheme.error) }
                } else null,
            )

            ColorSwatchRow(selected = color, onPick = { color = it })

            OutlinedTextField(
                value = timezone,
                onValueChange = { timezone = it.trim() },
                label = { Text(stringResource(R.string.calendars_timezone)) },
                singleLine = true,
                placeholder = { Text("Asia/Shanghai") },
                keyboardOptions = KeyboardOptions.Default,
                modifier = Modifier.fillMaxWidth(),
                supportingText = {
                    Text(stringResource(R.string.calendars_timezone_hint), color = mutedTextColor())
                },
            )

            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text(stringResource(R.string.calendars_description)) },
                placeholder = { Text(stringResource(R.string.calendars_description_hint)) },
                modifier = Modifier.fillMaxWidth(),
            )

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
                    colors = ButtonDefaults.outlinedButtonColors(),
                ) { Text(stringResource(R.string.action_cancel)) }
                Button(
                    enabled = canCreate,
                    onClick = {
                        scope.launch {
                            busy = true
                            error = null
                            try {
                                val profile = BywaveApp.instance.profiles.active()
                                    ?: throw IllegalStateException("未登录")
                                val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                                client.api.createCalendar(
                                    CalendarCreateRequest(
                                        name = name.trim(),
                                        color = color,
                                        timezone = timezone.takeIf { it.isNotBlank() },
                                        description = description.takeIf { it.isNotBlank() },
                                    ),
                                )
                                snackbar.showSnackbar(context.getString(R.string.calendars_created))
                                onCreated()
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(R.string.calendars_create_failed)
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
                        Text(stringResource(R.string.calendars_create))
                    }
                }
            }
        }
    }
}

// ---- Edit (rename / color / timezone / share links / delete) ----

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
    val context = LocalContext.current
    var name by remember(calendar.id) { mutableStateOf(calendar.name) }
    var color by remember(calendar.id) { mutableStateOf(calendar.color) }
    var timezone by remember(calendar.id) { mutableStateOf(calendar.timezone.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showDeleteConfirm by remember { mutableStateOf(false) }

    // Dirty-check — disable Save when nothing changed, or name went
    // blank (server requires min length 1).
    val canSave = !busy &&
        name.isNotBlank() &&
        (name != calendar.name ||
            !color.equals(calendar.color, ignoreCase = true) ||
            timezone != calendar.timezone.orEmpty())

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
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
                        .background(parseHex(color)),
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
                label = { Text(stringResource(R.string.calendars_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                isError = name.isBlank(),
                supportingText = if (name.isBlank()) {
                    { Text(stringResource(R.string.calendars_name_empty), color = MaterialTheme.colorScheme.error) }
                } else null,
            )

            ColorSwatchRow(selected = color, onPick = { color = it })

            OutlinedTextField(
                value = timezone,
                onValueChange = { timezone = it.trim() },
                label = { Text(stringResource(R.string.calendars_timezone)) },
                singleLine = true,
                placeholder = { Text("Asia/Shanghai") },
                keyboardOptions = KeyboardOptions.Default,
                modifier = Modifier.fillMaxWidth(),
                supportingText = {
                    Text(stringResource(R.string.calendars_timezone_hint), color = mutedTextColor())
                },
            )

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = onDismiss,
                    enabled = !busy,
                    colors = ButtonDefaults.outlinedButtonColors(),
                ) { Text(stringResource(R.string.action_cancel)) }
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
                                    color = color.takeIf { !it.equals(calendar.color, ignoreCase = true) },
                                    timezone = timezone.takeIf { it != calendar.timezone.orEmpty() }
                                        ?.takeIf { it.isNotBlank() },
                                )
                                client.api.updateCalendar(calendar.id, body)
                                snackbar.showSnackbar("已保存")
                                onSaved()
                            } catch (e: Exception) {
                                error = serverErrorMessage(e) ?: "保存失败"
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
                        Text(stringResource(R.string.action_save))
                    }
                }
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

            // Subscribe-link (.ics) management — mirrors web app/calendar.ejs.
            ShareLinksSection(calendarId = calendar.id, snackbar = snackbar)

            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

            // Destructive — delete the whole calendar (cascades to events).
            OutlinedButton(
                onClick = { showDeleteConfirm = true },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) {
                Icon(Icons.Default.Delete, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(6.dp))
                Text(stringResource(R.string.calendars_delete))
            }
        }
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text(stringResource(R.string.calendars_delete_title, calendar.name)) },
            text = { Text(stringResource(R.string.calendars_delete_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDeleteConfirm = false
                        scope.launch {
                            busy = true
                            error = null
                            try {
                                val profile = BywaveApp.instance.profiles.active()
                                    ?: throw IllegalStateException("未登录")
                                val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                                client.api.deleteCalendar(calendar.id)
                                snackbar.showSnackbar(context.getString(R.string.calendars_deleted))
                                onSaved()
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(R.string.calendars_delete_failed)
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) {
                    Text(
                        stringResource(R.string.action_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

// ---- Share / subscribe links ----

@Composable
private fun ShareLinksSection(
    calendarId: String,
    snackbar: SnackbarHostState,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val tokens = remember(calendarId) { mutableStateListOf<ShareToken>() }
    var loading by remember(calendarId) { mutableStateOf(true) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var revoking by remember { mutableStateOf<ShareToken?>(null) }
    var newLabel by remember(calendarId) { mutableStateOf("") }

    suspend fun reloadTokens() {
        try {
            val profile = BywaveApp.instance.profiles.active()
                ?: throw IllegalStateException("未登录")
            val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
            val list = client.api.shareTokens(calendarId)
            tokens.clear()
            tokens.addAll(list)
            error = null
        } catch (e: Exception) {
            error = serverErrorMessage(e)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(calendarId) { reloadTokens() }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = stringResource(R.string.share_links_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = stringResource(R.string.share_links_desc),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )

        if (loading) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        } else if (tokens.isEmpty()) {
            Text(
                text = stringResource(R.string.share_links_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
            )
        } else {
            tokens.forEach { t ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(MaterialTheme.shapes.medium)
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = t.label?.takeIf { it.isNotBlank() }
                            ?: stringResource(R.string.share_links_no_label),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        text = t.url ?: t.token,
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            onClick = {
                                clipboard.setText(AnnotatedString(t.url ?: t.token))
                                scope.launch { snackbar.showSnackbar(context.getString(R.string.share_links_copied)) }
                            },
                        ) {
                            Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.size(4.dp))
                            Text(stringResource(R.string.share_links_copy))
                        }
                        TextButton(
                            onClick = { revoking = t },
                            enabled = !working,
                        ) {
                            Text(
                                stringResource(R.string.share_links_revoke),
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }
        }

        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        OutlinedTextField(
            value = newLabel,
            onValueChange = { newLabel = it },
            label = { Text(stringResource(R.string.share_links_label)) },
            placeholder = { Text(stringResource(R.string.share_links_label_hint)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedButton(
            onClick = {
                scope.launch {
                    working = true
                    error = null
                    try {
                        val profile = BywaveApp.instance.profiles.active()
                            ?: throw IllegalStateException("未登录")
                        val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                        client.api.createShareToken(
                            calendarId,
                            ShareTokenCreateRequest(label = newLabel.takeIf { it.isNotBlank() }),
                        )
                        newLabel = ""
                        reloadTokens()
                        snackbar.showSnackbar(context.getString(R.string.share_links_generated))
                    } catch (e: Exception) {
                        error = serverErrorMessage(e)
                            ?: context.getString(R.string.share_links_generate_failed)
                    } finally {
                        working = false
                    }
                }
            },
            enabled = !working,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (working) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            } else {
                Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(6.dp))
                Text(stringResource(R.string.share_links_generate))
            }
        }
    }

    val toRevoke = revoking
    if (toRevoke != null) {
        AlertDialog(
            onDismissRequest = { revoking = null },
            title = { Text(stringResource(R.string.share_links_revoke_title)) },
            text = { Text(stringResource(R.string.share_links_revoke_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        revoking = null
                        scope.launch {
                            working = true
                            error = null
                            try {
                                val profile = BywaveApp.instance.profiles.active()
                                    ?: throw IllegalStateException("未登录")
                                val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                                client.api.revokeShareToken(calendarId, toRevoke.token)
                                reloadTokens()
                                snackbar.showSnackbar(context.getString(R.string.share_links_revoked))
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(R.string.share_links_revoke_failed)
                            } finally {
                                working = false
                            }
                        }
                    },
                ) {
                    Text(
                        stringResource(R.string.share_links_revoke),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { revoking = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}
