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

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.outlined.CalendarMonth
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.CalendarCreateRequest
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.CalendarSubscription
import cn.bywave.calendar.data.model.CalendarUpdateInput
import cn.bywave.calendar.data.model.ShareToken
import cn.bywave.calendar.data.model.ShareTokenCreateRequest
import cn.bywave.calendar.data.model.SubscriptionCreateRequest
import cn.bywave.calendar.ui.calendar.CalendarViewModel
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.calendar.parseHex
import cn.bywave.calendar.ui.components.EmptyState
import kotlinx.coroutines.launch

// Shared swatch palette — the same 17 colors, in the same order, as
// the web app's COLOR_PALETTE (calendar-app.js), so a color offered on
// one platform can be picked identically on every other. (This used to
// be a divergent 8-color set whose comment claimed parity with an iOS
// list that was itself a third, different set.) Keep them as valid
// 6-hex so the server's color regex accepts the value verbatim.
private val CALENDAR_COLOR_SWATCHES = listOf(
    "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
    "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
    "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
    "#ec4899", "#64748b",
)

// New-calendar default color — the web create dialog's default
// (#6366f1 indigo), NOT the first palette entry (which is red). The
// brand purple #6640E9 remains only as the parse fallback in
// CalendarHelpers / SystemCalendarMirror, not as a creation default.
private const val DEFAULT_CALENDAR_COLOR = "#6366f1"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarListScreen(
    onBack: () -> Unit,
    // In-app ICS import entry: hands the picked file's Uri up to the
    // activity, which feeds it into the same pending-import pipeline
    // the system "open with / share" intents use. Import used to be
    // reachable ONLY from outside the app — a user holding a .ics file
    // had no way to start an import from inside.
    onImportFile: (Uri) -> Unit = {},
    // Deep-link flag from Settings' "new calendar" row: open with the
    // create sheet already up instead of making the user find the
    // top-bar "+" after landing here.
    startCreating: Boolean = false,
    vm: CalendarViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val pickIcs = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri -> if (uri != null) onImportFile(uri) }
    var editing by remember { mutableStateOf<CalendarMeta?>(null) }
    var creating by remember { mutableStateOf(startCreating) }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.callist_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.nav_back))
                    }
                },
                actions = {
                    IconButton(onClick = {
                        pickIcs.launch(arrayOf("text/calendar", "text/x-vcalendar", "text/plain", "application/octet-stream"))
                    }) {
                        Icon(
                            androidx.compose.material.icons.Icons.Outlined.FileUpload,
                            contentDescription = stringResource(R.string.importics_title),
                        )
                    }
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
                EmptyState(
                    icon = Icons.Outlined.CalendarMonth,
                    title = stringResource(R.string.callist_empty),
                    action = {
                        OutlinedButton(onClick = { creating = true }) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(6.dp))
                            Text(stringResource(R.string.calendars_new))
                        }
                    },
                )
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
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
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
                        Text(text = stringResource(R.string.callist_edit), style = MaterialTheme.typography.labelMedium, color = mutedTextColor())
                    }
                    if (i < state.calendars.size - 1) HorizontalDivider()
                }
            }

            // In-app .ics import entry (button form of the top-bar
            // action). Until now the import screen was only reachable
            // when another app handed a file over via intent; picking
            // a file from inside the app reuses the same screen and
            // flow (the host parks the Uri and navigates).
            OutlinedButton(
                onClick = {
                    pickIcs.launch(arrayOf("text/calendar", "text/x-vcalendar", "text/plain", "application/octet-stream"))
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 16.dp),
            ) {
                Text(stringResource(R.string.callist_import_file))
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
    var color by remember { mutableStateOf(DEFAULT_CALENDAR_COLOR) }
    // Prefill the device zone like desktop / iOS do — a blank field used
    // to fall through to the server's hardcoded Asia/Shanghai default,
    // which is wrong for anyone outside that zone who doesn't notice
    // the placeholder and type over it.
    var timezone by remember { mutableStateOf(java.util.TimeZone.getDefault().id) }
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
                                    ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
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
    // Description was create-only until now: the create sheet collected
    // it but this edit sheet never rendered the field, so a description
    // set at creation (or on web / iOS) could never be changed here.
    var description by remember(calendar.id) { mutableStateOf(calendar.description.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showDeleteConfirm by remember { mutableStateOf(false) }

    // Export (.ics) — fetch the raw snapshot first, then hand it to the
    // system document picker; the picked URI is written in the launcher
    // callback, so the fetched text + filename wait here meanwhile.
    var exporting by remember { mutableStateOf(false) }
    var pendingExport by remember { mutableStateOf<Pair<String, String>?>(null) }
    val createDocumentLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/calendar"),
    ) { uri ->
        val pending = pendingExport
        pendingExport = null
        if (uri != null && pending != null) {
            scope.launch {
                val written = runCatching {
                    context.contentResolver.openOutputStream(uri)?.use { out ->
                        out.write(pending.second.toByteArray(Charsets.UTF_8))
                    } ?: throw java.io.IOException("openOutputStream returned null")
                }
                if (written.isSuccess) {
                    snackbar.showSnackbar(context.getString(R.string.export_done, pending.first))
                } else {
                    snackbar.showSnackbar(context.getString(R.string.export_failed))
                }
            }
        }
    }

    // Dirty-check — disable Save when nothing changed, or name went
    // blank (server requires min length 1).
    val canSave = !busy &&
        name.isNotBlank() &&
        (name != calendar.name ||
            !color.equals(calendar.color, ignoreCase = true) ||
            timezone != calendar.timezone.orEmpty() ||
            description != calendar.description.orEmpty())

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
                    text = stringResource(R.string.callist_edit_title),
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

            // Same field + strings as the create sheet. Clearing the
            // text sends "" (not null), which the server stores as an
            // empty description — so unlike web/desktop, clearing here
            // actually clears.
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
                                    ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
                                val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                                val body = CalendarUpdateInput(
                                    // Only send fields that actually changed — the server's
                                    // partial schema accepts the smaller payload happily and
                                    // it makes log lines easier to read.
                                    name = name.takeIf { it != calendar.name },
                                    color = color.takeIf { !it.equals(calendar.color, ignoreCase = true) },
                                    timezone = timezone.takeIf { it != calendar.timezone.orEmpty() }
                                        ?.takeIf { it.isNotBlank() },
                                    description = description.takeIf { it != calendar.description.orEmpty() },
                                )
                                client.api.updateCalendar(calendar.id, body)
                                snackbar.showSnackbar(context.getString(R.string.callist_saved))
                                onSaved()
                            } catch (e: Exception) {
                                error = serverErrorMessage(e) ?: context.getString(R.string.callist_save_failed)
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

            // Incoming .ics subscriptions feeding this calendar.
            SubscriptionsSection(calendarId = calendar.id, snackbar = snackbar)

            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

            // One-shot .ics export — owner-authenticated snapshot from
            // GET /calendars/{id}/export.ics (NOT the public share link:
            // exporting must not mint a permanent public URL). The file
            // lands wherever the user picks in the document picker.
            OutlinedButton(
                onClick = {
                    scope.launch {
                        exporting = true
                        try {
                            val profile = BywaveApp.instance.profiles.active()
                                ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
                            val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                            val resp = client.api.exportCalendarIcs(calendar.id)
                            if (!resp.isSuccessful) throw retrofit2.HttpException(resp)
                            val text = resp.body()?.string()
                                ?: throw IllegalStateException(context.getString(R.string.export_failed))
                            val filename = exportFilenameFromDisposition(
                                resp.headers()["Content-Disposition"],
                            ) ?: (sanitizeIcsFilename(calendar.name) + ".ics")
                            pendingExport = filename to text
                            createDocumentLauncher.launch(filename)
                        } catch (e: Exception) {
                            snackbar.showSnackbar(
                                serverErrorMessage(e) ?: context.getString(R.string.export_failed),
                            )
                        } finally {
                            exporting = false
                        }
                    }
                },
                enabled = !exporting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (exporting) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(6.dp))
                }
                Text(stringResource(R.string.export_ics))
            }

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
                                    ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
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
                ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
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
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
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
                            ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
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
                                    ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
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

// ---- Incoming .ics subscriptions ----

/** Filename from a Content-Disposition header (`attachment;
 *  filename="Work.ics"`), or null when absent/unparseable — the caller
 *  falls back to the calendar name. */
private fun exportFilenameFromDisposition(disposition: String?): String? {
    if (disposition.isNullOrBlank()) return null
    val quoted = Regex("""filename="([^"]+)"""").find(disposition)?.groupValues?.get(1)
    val bare = quoted ?: Regex("""filename=([^;]+)""").find(disposition)?.groupValues?.get(1)?.trim()
    return bare?.takeIf { it.isNotBlank() }
}

/** Keep a calendar name usable as a document-picker filename. */
private fun sanitizeIcsFilename(name: String): String {
    val cleaned = name.replace(Regex("""[\\/:*?"<>|]"""), "_").trim()
    return cleaned.ifBlank { "calendar" }
}

@Composable
private fun SubscriptionsSection(
    calendarId: String,
    snackbar: SnackbarHostState,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val subs = remember(calendarId) { mutableStateListOf<CalendarSubscription>() }
    var loading by remember(calendarId) { mutableStateOf(true) }
    var working by remember { mutableStateOf(false) }
    var refreshingId by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<CalendarSubscription?>(null) }
    var newUrl by remember(calendarId) { mutableStateOf("") }
    var newLabel by remember(calendarId) { mutableStateOf("") }

    fun api() = run {
        val profile = BywaveApp.instance.profiles.active()
            ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
        ApiClient.forProfile(profile, BywaveApp.instance.profiles).api
    }

    suspend fun reloadSubs() {
        try {
            val list = api().subscriptions(calendarId)
            subs.clear()
            subs.addAll(list)
            error = null
        } catch (e: Exception) {
            error = serverErrorMessage(e) ?: context.getString(R.string.subs_load_failed)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(calendarId) { reloadSubs() }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = stringResource(R.string.subs_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = stringResource(R.string.subs_desc),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )

        if (loading) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        } else if (subs.isEmpty()) {
            Text(
                text = stringResource(R.string.subs_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
            )
        } else {
            subs.forEach { s ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(MaterialTheme.shapes.medium)
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = s.label?.takeIf { it.isNotBlank() } ?: s.url,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                    if (!s.label.isNullOrBlank()) {
                        Text(
                            text = s.url,
                            style = MaterialTheme.typography.bodySmall,
                            color = mutedTextColor(),
                        )
                    }
                    // Status line: a stored lastError outranks everything —
                    // it is the reason the feed looks stale. Otherwise the
                    // last fetch result + how many events it produced.
                    when {
                        !s.lastError.isNullOrBlank() -> Text(
                            text = stringResource(R.string.subs_status_error) + "：" + s.lastError,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        s.lastFetchedAt != null -> Text(
                            text = buildString {
                                append(stringResource(R.string.subs_status_ok))
                                s.lastEventCount?.let {
                                    append(" · ")
                                    append(stringResource(R.string.subs_status_events, it))
                                }
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = mutedTextColor(),
                        )
                        else -> Text(
                            text = stringResource(R.string.subs_status_never),
                            style = MaterialTheme.typography.bodySmall,
                            color = mutedTextColor(),
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            onClick = {
                                scope.launch {
                                    refreshingId = s.id
                                    error = null
                                    try {
                                        api().refreshSubscription(calendarId, s.id)
                                        snackbar.showSnackbar(context.getString(R.string.subs_refreshed))
                                        reloadSubs()
                                    } catch (e: Exception) {
                                        error = serverErrorMessage(e)
                                            ?: context.getString(R.string.subs_refresh_failed)
                                    } finally {
                                        refreshingId = null
                                    }
                                }
                            },
                            enabled = refreshingId == null && !working,
                        ) {
                            if (refreshingId == s.id) {
                                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.size(4.dp))
                            }
                            Text(stringResource(R.string.subs_refresh))
                        }
                        TextButton(
                            onClick = { deleting = s },
                            enabled = !working && refreshingId == null,
                        ) {
                            Text(
                                stringResource(R.string.action_delete),
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
            value = newUrl,
            onValueChange = { newUrl = it },
            label = { Text(stringResource(R.string.subs_url_label)) },
            placeholder = { Text("https://example.com/feed.ics") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = newLabel,
            onValueChange = { newLabel = it },
            label = { Text(stringResource(R.string.subs_label_label)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedButton(
            onClick = {
                scope.launch {
                    working = true
                    error = null
                    try {
                        val resp = api().createSubscription(
                            calendarId,
                            SubscriptionCreateRequest(
                                url = newUrl.trim(),
                                label = newLabel.takeIf { it.isNotBlank() },
                            ),
                        )
                        newUrl = ""
                        newLabel = ""
                        reloadSubs()
                        // First-sync failure is NOT creation failure: the
                        // row is stored and retries on cadence. Say so,
                        // or the user creates a duplicate.
                        if (resp.refresh.ok) {
                            snackbar.showSnackbar(context.getString(R.string.subs_added))
                        } else {
                            snackbar.showSnackbar(
                                context.getString(
                                    R.string.subs_added_first_sync_failed,
                                    resp.refresh.error.orEmpty(),
                                ),
                            )
                        }
                    } catch (e: Exception) {
                        error = serverErrorMessage(e)
                            ?: context.getString(R.string.subs_add_failed)
                    } finally {
                        working = false
                    }
                }
            },
            enabled = !working && newUrl.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (working) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            } else {
                Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(6.dp))
                Text(stringResource(R.string.subs_add))
            }
        }
    }

    val toDelete = deleting
    if (toDelete != null) {
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(stringResource(R.string.subs_delete_title)) },
            text = { Text(stringResource(R.string.subs_delete_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        deleting = null
                        scope.launch {
                            working = true
                            error = null
                            try {
                                api().deleteSubscription(calendarId, toDelete.id)
                                reloadSubs()
                                snackbar.showSnackbar(context.getString(R.string.subs_deleted))
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(R.string.subs_delete_failed)
                            } finally {
                                working = false
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
                TextButton(onClick = { deleting = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}
