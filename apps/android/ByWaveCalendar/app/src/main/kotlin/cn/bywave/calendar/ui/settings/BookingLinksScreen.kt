// "预约链接" screen (v0.12).
//
// Owner-management UI for booking links — the public scheduling pages a
// user shares (`<base>/book/<slug>`) so visitors can book time against
// one of their calendars. Mirrors CalendarListScreen's share-link
// section structure: a list of links (title, duration, paused chip,
// public URL with copy / open), a create form (slug + title +
// description + calendar picker + duration + notice/horizon + buffers +
// notify switch), per-link enable/pause (PATCH enabled) and delete
// (confirm dialog).
//
// The server's GET/POST/PATCH/DELETE /booking-links endpoints supported
// all of this already; this is the missing native UI. weeklyAvailability
// is NOT edited here — the server defaults it on create.
//
// Reuses the CalendarViewModel from the calendar back-stack entry for
// its state.calendars (the calendar picker's options); booking links
// themselves are loaded ad-hoc in this screen since the calendar VM
// doesn't track them.

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.material3.Switch
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
import cn.bywave.calendar.data.model.BookingLink
import cn.bywave.calendar.data.model.BookingLinkCreateRequest
import cn.bywave.calendar.data.model.BookingLinkUpdateInput
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.ui.calendar.CalendarViewModel
import cn.bywave.calendar.ui.calendar.mutedTextColor
import kotlinx.coroutines.launch

// Server slug rule: ^[a-z0-9][a-z0-9-]{0,30}$ — lower-case alnum start,
// then up to 30 more of [a-z0-9-]. Validate locally so we never POST a
// slug the server would reject with a 400.
private val SLUG_REGEX = Regex("^[a-z0-9][a-z0-9-]{0,30}$")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookingLinksScreen(
    onBack: () -> Unit,
    vm: CalendarViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current

    val links = remember { mutableStateListOf<BookingLink>() }
    var loading by remember { mutableStateOf(true) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<BookingLink?>(null) }

    suspend fun reloadLinks() {
        try {
            val profile = BywaveApp.instance.profiles.active()
                ?: throw IllegalStateException("未登录")
            val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
            val list = client.api.bookingLinks()
            links.clear()
            links.addAll(list)
            error = null
        } catch (e: Exception) {
            error = serverErrorMessage(e)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reloadLinks() }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.booking_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    IconButton(onClick = { creating = true }) {
                        Icon(Icons.Default.Add, contentDescription = stringResource(R.string.booking_create))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Spacer(Modifier.size(4.dp))
            Text(
                text = stringResource(R.string.booking_desc),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )

            if (loading) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            } else if (links.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.booking_empty), color = mutedTextColor())
                        Spacer(Modifier.size(12.dp))
                        OutlinedButton(onClick = { creating = true }) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(6.dp))
                            Text(stringResource(R.string.booking_create))
                        }
                    }
                }
            } else {
                links.forEach { link ->
                    BookingLinkCard(
                        link = link,
                        working = working,
                        onCopy = {
                            clipboard.setText(AnnotatedString(link.publicUrl ?: link.slug))
                            scope.launch { snackbar.showSnackbar(context.getString(R.string.booking_copied)) }
                        },
                        onOpen = { openExternalUrl(context, link.publicUrl) },
                        onToggleEnabled = { wanted ->
                            scope.launch {
                                working = true
                                error = null
                                try {
                                    val profile = BywaveApp.instance.profiles.active()
                                        ?: throw IllegalStateException("未登录")
                                    val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                                    client.api.updateBookingLink(
                                        link.id,
                                        BookingLinkUpdateInput(enabled = wanted),
                                    )
                                    reloadLinks()
                                } catch (e: Exception) {
                                    error = serverErrorMessage(e)
                                        ?: context.getString(R.string.booking_update_failed)
                                } finally {
                                    working = false
                                }
                            }
                        },
                        onDelete = { deleting = link },
                    )
                }
            }

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Spacer(Modifier.size(24.dp))
        }
    }

    if (creating) {
        CreateBookingLinkSheet(
            calendars = state.calendars,
            onDismiss = { creating = false },
            onCreated = {
                creating = false
                scope.launch { reloadLinks() }
            },
            snackbar = snackbar,
        )
    }

    val toDelete = deleting
    if (toDelete != null) {
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(stringResource(R.string.booking_delete_title, toDelete.title)) },
            text = { Text(stringResource(R.string.booking_delete_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        deleting = null
                        scope.launch {
                            working = true
                            error = null
                            try {
                                val profile = BywaveApp.instance.profiles.active()
                                    ?: throw IllegalStateException("未登录")
                                val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                                client.api.deleteBookingLink(toDelete.id)
                                reloadLinks()
                                snackbar.showSnackbar(context.getString(R.string.booking_deleted))
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(R.string.booking_delete_failed)
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

// ---- One booking-link card in the list ----

@Composable
private fun BookingLinkCard(
    link: BookingLink,
    working: Boolean,
    onCopy: () -> Unit,
    onOpen: () -> Unit,
    onToggleEnabled: (Boolean) -> Unit,
    onDelete: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = link.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
            )
            if (!link.enabled) {
                AssistChip(
                    onClick = {},
                    enabled = false,
                    label = { Text(stringResource(R.string.booking_paused)) },
                )
            }
        }
        Text(
            text = stringResource(R.string.booking_duration_value, link.durationMinutes),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        Text(
            text = link.publicUrl ?: link.slug,
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCopy) {
                Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.size(4.dp))
                Text(stringResource(R.string.booking_copy_link))
            }
            TextButton(onClick = onOpen) {
                Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.size(4.dp))
                Text(stringResource(R.string.booking_open))
            }
            Spacer(Modifier.weight(1f))
            // Enable/pause toggle — PATCHes only `enabled`.
            Switch(
                checked = link.enabled,
                onCheckedChange = onToggleEnabled,
                enabled = !working,
            )
        }
        Row {
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onDelete, enabled = !working) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.size(4.dp))
                Text(
                    stringResource(R.string.booking_delete),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

// ---- Create form ----

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CreateBookingLinkSheet(
    calendars: List<CalendarMeta>,
    onDismiss: () -> Unit,
    onCreated: () -> Unit,
    snackbar: SnackbarHostState,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var slug by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var calendarId by remember { mutableStateOf(calendars.firstOrNull()?.id ?: "") }
    var duration by remember { mutableStateOf("30") }
    var minNotice by remember { mutableStateOf("4") }
    var maxDays by remember { mutableStateOf("60") }
    var bufferBefore by remember { mutableStateOf("0") }
    var bufferAfter by remember { mutableStateOf("0") }
    var notifyEmail by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val slugValid = slug.isNotBlank() && SLUG_REGEX.matches(slug)
    val durationInt = duration.toIntOrNull()
    val minNoticeInt = minNotice.toIntOrNull()
    val maxDaysInt = maxDays.toIntOrNull()
    val bufferBeforeInt = bufferBefore.toIntOrNull()
    val bufferAfterInt = bufferAfter.toIntOrNull()
    val canCreate = !busy &&
        slugValid &&
        title.isNotBlank() &&
        calendarId.isNotBlank() &&
        durationInt != null && durationInt > 0 &&
        minNoticeInt != null && minNoticeInt >= 0 &&
        maxDaysInt != null && maxDaysInt > 0 &&
        bufferBeforeInt != null && bufferBeforeInt >= 0 &&
        bufferAfterInt != null && bufferAfterInt >= 0

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.booking_create_title),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )

            OutlinedTextField(
                value = slug,
                onValueChange = { slug = it.lowercase() },
                label = { Text(stringResource(R.string.booking_slug)) },
                placeholder = { Text("intro-call") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                isError = slug.isNotBlank() && !slugValid,
                supportingText = {
                    if (slug.isNotBlank() && !slugValid) {
                        Text(stringResource(R.string.booking_slug_invalid), color = MaterialTheme.colorScheme.error)
                    } else {
                        Text(stringResource(R.string.booking_slug_hint), color = mutedTextColor())
                    }
                },
            )

            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text(stringResource(R.string.booking_link_title)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                isError = title.isBlank(),
            )

            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text(stringResource(R.string.booking_link_description)) },
                placeholder = { Text(stringResource(R.string.booking_link_description_hint)) },
                modifier = Modifier.fillMaxWidth(),
            )

            CalendarPicker(
                calendars = calendars,
                selectedId = calendarId,
                onSelect = { calendarId = it },
            )

            OutlinedTextField(
                value = duration,
                onValueChange = { duration = it.filter { c -> c.isDigit() } },
                label = { Text(stringResource(R.string.booking_duration)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                isError = durationInt == null || durationInt <= 0,
            )

            OutlinedTextField(
                value = minNotice,
                onValueChange = { minNotice = it.filter { c -> c.isDigit() } },
                label = { Text(stringResource(R.string.booking_min_notice)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                isError = minNoticeInt == null || minNoticeInt < 0,
            )

            OutlinedTextField(
                value = maxDays,
                onValueChange = { maxDays = it.filter { c -> c.isDigit() } },
                label = { Text(stringResource(R.string.booking_max_days)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                isError = maxDaysInt == null || maxDaysInt <= 0,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = bufferBefore,
                    onValueChange = { bufferBefore = it.filter { c -> c.isDigit() } },
                    label = { Text(stringResource(R.string.booking_buffer_before)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
                    modifier = Modifier.weight(1f),
                    isError = bufferBeforeInt == null || bufferBeforeInt < 0,
                )
                OutlinedTextField(
                    value = bufferAfter,
                    onValueChange = { bufferAfter = it.filter { c -> c.isDigit() } },
                    label = { Text(stringResource(R.string.booking_buffer_after)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
                    modifier = Modifier.weight(1f),
                    isError = bufferAfterInt == null || bufferAfterInt < 0,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.booking_notify_email), fontWeight = FontWeight.Medium)
                    Text(
                        text = stringResource(R.string.booking_notify_email_desc),
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                    )
                }
                Spacer(Modifier.size(8.dp))
                Switch(checked = notifyEmail, onCheckedChange = { notifyEmail = it })
            }

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
                                client.api.createBookingLink(
                                    BookingLinkCreateRequest(
                                        slug = slug.trim(),
                                        title = title.trim(),
                                        description = description.takeIf { it.isNotBlank() },
                                        calendarId = calendarId,
                                        durationMinutes = durationInt ?: 30,
                                        minNoticeHours = minNoticeInt ?: 0,
                                        maxDaysAhead = maxDaysInt ?: 60,
                                        bufferBeforeMin = bufferBeforeInt?.takeIf { it > 0 },
                                        bufferAfterMin = bufferAfterInt?.takeIf { it > 0 },
                                        notifyEmail = notifyEmail.takeIf { it },
                                    ),
                                )
                                snackbar.showSnackbar(context.getString(R.string.booking_created))
                                onCreated()
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(R.string.booking_create_failed)
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
                        Text(stringResource(R.string.booking_create))
                    }
                }
            }
        }
    }
}

// ---- Calendar picker (dropdown over the loaded calendars) ----

@Composable
private fun CalendarPicker(
    calendars: List<CalendarMeta>,
    selectedId: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = calendars.firstOrNull { it.id == selectedId }

    Column {
        Text(
            text = stringResource(R.string.booking_calendar),
            style = MaterialTheme.typography.bodyMedium,
            color = mutedTextColor(),
        )
        Spacer(Modifier.size(6.dp))
        Box(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .border(
                        0.5.dp,
                        MaterialTheme.colorScheme.outline,
                        RoundedCornerShape(8.dp),
                    )
                    .clickable { expanded = true }
                    .padding(horizontal = 14.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = selected?.name ?: stringResource(R.string.booking_calendar_none),
                    modifier = Modifier.weight(1f),
                    color = if (selected != null) MaterialTheme.colorScheme.onSurface else mutedTextColor(),
                )
                Icon(
                    Icons.Default.Check,
                    contentDescription = null,
                    tint = if (selected != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                    modifier = Modifier.size(18.dp),
                )
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
            ) {
                calendars.forEach { c ->
                    DropdownMenuItem(
                        text = { Text(c.name) },
                        onClick = {
                            onSelect(c.id)
                            expanded = false
                        },
                    )
                }
            }
        }
    }
}

private fun openExternalUrl(context: android.content.Context, url: String?) {
    if (url.isNullOrBlank()) return
    runCatching {
        val intent = android.content.Intent(
            android.content.Intent.ACTION_VIEW,
            android.net.Uri.parse(url),
        ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
