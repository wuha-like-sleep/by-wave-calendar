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
// all of this already; this is the missing native UI. The create/edit
// sheet also edits weeklyAvailability (per-weekday windows, the server's
// matrix) and each card opens a bookings viewer (list / detail /
// owner-side cancel) — both used to be web-only on this platform.
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.Booking
import cn.bywave.calendar.data.model.BookingLink
import cn.bywave.calendar.data.model.BookingLinkCreateRequest
import cn.bywave.calendar.data.model.BookingLinkUpdateInput
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.ui.calendar.CalendarViewModel
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.components.EmptyState
import cn.bywave.calendar.ui.theme.Radii
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
    var editing by remember { mutableStateOf<BookingLink?>(null) }
    var deleting by remember { mutableStateOf<BookingLink?>(null) }
    var viewingBookings by remember { mutableStateOf<BookingLink?>(null) }

    suspend fun reloadLinks() {
        try {
            val profile = BywaveApp.instance.profiles.active()
                ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
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
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.nav_back))
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
                EmptyState(
                    modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                    icon = Icons.Outlined.Link,
                    title = stringResource(R.string.booking_empty),
                    action = {
                        OutlinedButton(onClick = { creating = true }) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(6.dp))
                            Text(stringResource(R.string.booking_create))
                        }
                    },
                )
            } else {
                links.forEach { link ->
                    BookingLinkCard(
                        link = link,
                        calendarTimezone = state.calendars.firstOrNull { it.id == link.calendarId }?.timezone,
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
                                        ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
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
                        onEdit = { editing = link },
                        onDelete = { deleting = link },
                        onViewBookings = { viewingBookings = link },
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
            onCreated = { created ->
                creating = false
                scope.launch {
                    reloadLinks()
                    // 创建成功的第一时间给「复制链接」：以前只有一句
                    // 「已创建」，用户还得回列表里找到那一行再点复制。
                    // snackbar 挂在父屏（sheet 关掉后它自己的作用域就
                    // 没了），复制走父屏的 clipboard。
                    if (created != null) {
                        val result = snackbar.showSnackbar(
                            message = context.getString(R.string.booking_created),
                            actionLabel = context.getString(R.string.booking_copy_link),
                            duration = SnackbarDuration.Short,
                        )
                        if (result == SnackbarResult.ActionPerformed) {
                            clipboard.setText(AnnotatedString(created.publicUrl ?: created.slug))
                            snackbar.showSnackbar(context.getString(R.string.booking_copied))
                        }
                    }
                }
            },
            snackbar = snackbar,
        )
    }

    editing?.let { link ->
        CreateBookingLinkSheet(
            calendars = state.calendars,
            existing = link,
            onDismiss = { editing = null },
            onCreated = {
                editing = null
                scope.launch { reloadLinks() }
            },
            snackbar = snackbar,
        )
    }

    viewingBookings?.let { link ->
        BookingsSheet(
            link = link,
            onDismiss = { viewingBookings = null },
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
                                    ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
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
    calendarTimezone: String?,
    working: Boolean,
    onCopy: () -> Unit,
    onOpen: () -> Unit,
    onToggleEnabled: (Boolean) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onViewBookings: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(Radii.cardShape)
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
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
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
            text = stringResource(R.string.booking_schedule_timezone, cn.bywave.calendar.event.bookingTimeZone(link.timezone, calendarTimezone)),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        Text(
            text = link.publicUrl ?: link.slug,
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
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
            TextButton(onClick = onViewBookings, enabled = !working) {
                Text(stringResource(R.string.booking_view_bookings))
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onEdit, enabled = !working) {
                Icon(
                    Icons.Default.Edit,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.size(4.dp))
                Text(stringResource(R.string.booking_edit))
            }
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
    existing: BookingLink? = null,
    onDismiss: () -> Unit,
    /** 创建成功时带回新建的那条（父屏据此给「复制链接」）；编辑保存
     *  成功时传 null（编辑的反馈仍是 sheet 内的「已保存」）。 */
    onCreated: (created: BookingLink?) -> Unit,
    snackbar: SnackbarHostState,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // With `existing` set the sheet edits that link instead of creating a
    // new one — updateBookingLink existed from the start but only the
    // enable/pause toggle ever called it.
    var slug by remember { mutableStateOf(existing?.slug ?: "") }
    var title by remember { mutableStateOf(existing?.title ?: "") }
    var description by remember { mutableStateOf(existing?.description ?: "") }
    var calendarId by remember { mutableStateOf(existing?.calendarId ?: calendars.firstOrNull()?.id ?: "") }
    var duration by remember { mutableStateOf(existing?.durationMinutes?.toString() ?: "30") }
    var minNotice by remember { mutableStateOf(existing?.minNoticeHours?.toString() ?: "4") }
    var maxDays by remember { mutableStateOf(existing?.maxDaysAhead?.toString() ?: "60") }
    var bufferBefore by remember { mutableStateOf(existing?.bufferBeforeMin?.toString() ?: "0") }
    var bufferAfter by remember { mutableStateOf(existing?.bufferAfterMin?.toString() ?: "0") }
    var notifyEmail by remember { mutableStateOf(existing?.notifyEmail ?: false) }
    // Per-weekday windows (dow 0=Sun..6=Sat → [start, end] text pairs).
    // Absent key = not bookable that day. Seeded from the link's stored
    // matrix; a fresh create starts from the server's default matrix.
    var availability by remember { mutableStateOf(seedAvailability(existing?.weeklyAvailability)) }
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
        bufferAfterInt != null && bufferAfterInt >= 0 &&
        availabilityValid(availability)

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
                text = stringResource(if (existing != null) R.string.booking_edit_title else R.string.booking_create_title),
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

            Text(
                text = stringResource(R.string.booking_schedule_timezone, cn.bywave.calendar.event.bookingTimeZone(null, calendars.firstOrNull { it.id == calendarId }?.timezone)),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
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

            AvailabilityEditorSection(
                availability = availability,
                onChange = { availability = it },
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
                                if (existing != null) {
                                    client.api.updateBookingLink(
                                        existing.id,
                                        BookingLinkUpdateInput(
                                            slug = slug.trim(),
                                            title = title.trim(),
                                            // 与原值不同才发：清空时照发空串。
                                            // 以前 takeIf{isNotBlank} 把清空吞成
                                            // null→字段省略，服务端当作不改，
                                            // 旧描述清不掉（服务端 PATCH 收 ""）。
                                            description = description.takeIf { it != existing.description.orEmpty() },
                                            calendarId = calendarId,
                                            durationMinutes = durationInt ?: 30,
                                            minNoticeHours = minNoticeInt ?: 0,
                                            maxDaysAhead = maxDaysInt ?: 60,
                                            bufferBeforeMin = bufferBeforeInt?.takeIf { it > 0 },
                                            bufferAfterMin = bufferAfterInt?.takeIf { it > 0 },
                                            notifyEmail = notifyEmail,
                                            weeklyAvailability = availabilityWire(availability),
                                        ),
                                    )
                                    snackbar.showSnackbar(context.getString(R.string.booking_saved))
                                    onCreated(null)
                                } else {
                                    val created = client.api.createBookingLink(
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
                                            weeklyAvailability = availabilityWire(availability),
                                        ),
                                    )
                                    // 「已创建 + 复制链接」的 snackbar 由父屏弹
                                    // （带回 created），这里不再自己弹一句纯文本。
                                    onCreated(created)
                                }
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(if (existing != null) R.string.booking_update_failed else R.string.booking_create_failed)
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
                        Text(stringResource(if (existing != null) R.string.booking_save else R.string.booking_create))
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
                    .clip(Radii.fieldShape)
                    .border(
                        0.5.dp,
                        MaterialTheme.colorScheme.outline,
                        Radii.fieldShape,
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

// ---- Weekly availability (shared by the create/edit sheet) ----
//
// The wire matrix is keyed by dow "0".."6" (0 = Sunday) with
// ["HH:MM", "HH:MM"] wall-clock pairs in the link's scheduling zone.
// The editor state keeps only bookable days: dow -> (start, end) pairs;
// an absent day is "off".

private val HHMM_REGEX = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

/** The server's DEFAULT_AVAILABILITY: Mon–Fri 09:00–18:00. */
private val DEFAULT_AVAILABILITY_DOWS: Map<Int, List<Pair<String, String>>> =
    (1..5).associateWith { listOf("09:00" to "18:00") }

private fun seedAvailability(wire: Map<String, List<List<String>>?>?): Map<Int, List<Pair<String, String>>> {
    if (wire == null) return DEFAULT_AVAILABILITY_DOWS
    val out = mutableMapOf<Int, List<Pair<String, String>>>()
    for ((key, windows) in wire) {
        val dow = key.toIntOrNull() ?: continue
        if (windows.isNullOrEmpty()) continue
        out[dow] = windows.mapNotNull { pair ->
            if (pair.size == 2) pair[0] to pair[1] else null
        }
    }
    return out
}

private fun availabilityValid(availability: Map<Int, List<Pair<String, String>>>): Boolean =
    availability.values.all { windows ->
        windows.all { (start, end) -> HHMM_REGEX.matches(start) && HHMM_REGEX.matches(end) && start < end }
    }

/** Editor state → wire matrix. Only bookable days are sent (absent day =
 *  not bookable), so no explicit nulls ride along. */
private fun availabilityWire(availability: Map<Int, List<Pair<String, String>>>): Map<String, List<List<String>>> =
    availability.filterValues { it.isNotEmpty() }
        .mapKeys { it.key.toString() }
        .mapValues { (_, windows) -> windows.map { listOf(it.first, it.second) } }

private fun weekdayShortLabel(dow: Int): String =
    java.time.DayOfWeek.of(if (dow == 0) 7 else dow)
        .getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.getDefault())

@Composable
private fun AvailabilityEditorSection(
    availability: Map<Int, List<Pair<String, String>>>,
    onChange: (Map<Int, List<Pair<String, String>>>) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = stringResource(R.string.booking_availability),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
        Text(
            text = stringResource(R.string.booking_availability_hint),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        // Monday-first rows, like the rest of the app.
        listOf(1, 2, 3, 4, 5, 6, 0).forEach { dow ->
            val windows = availability[dow]
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = weekdayShortLabel(dow),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.width(36.dp),
                )
                Switch(
                    checked = windows != null,
                    onCheckedChange = { on ->
                        onChange(
                            if (on) availability + (dow to listOf("09:00" to "18:00"))
                            else availability - dow,
                        )
                    },
                )
                if (windows == null) {
                    Text("—", style = MaterialTheme.typography.bodySmall, color = mutedTextColor())
                }
            }
            windows?.forEachIndexed { idx, window ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(start = 44.dp),
                ) {
                    OutlinedTextField(
                        value = window.first,
                        onValueChange = { raw ->
                            val v = raw.filter { c -> c.isDigit() || c == ':' }.take(5)
                            val next = windows.toMutableList()
                            next[idx] = v to window.second
                            onChange(availability + (dow to next))
                        },
                        singleLine = true,
                        isError = !HHMM_REGEX.matches(window.first),
                        modifier = Modifier.width(104.dp),
                    )
                    Text("–")
                    OutlinedTextField(
                        value = window.second,
                        onValueChange = { raw ->
                            val v = raw.filter { c -> c.isDigit() || c == ':' }.take(5)
                            val next = windows.toMutableList()
                            next[idx] = window.first to v
                            onChange(availability + (dow to next))
                        },
                        singleLine = true,
                        isError = !HHMM_REGEX.matches(window.second),
                        modifier = Modifier.width(104.dp),
                    )
                    IconButton(onClick = {
                        val next = windows.toMutableList()
                        next.removeAt(idx)
                        onChange(if (next.isEmpty()) availability - dow else availability + (dow to next))
                    }) {
                        Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(16.dp))
                    }
                }
            }
            if (windows != null) {
                TextButton(
                    onClick = {
                        val lastEnd = windows.lastOrNull()?.second ?: "09:00"
                        onChange(availability + (dow to (windows + (lastEnd to lastEnd))))
                    },
                    modifier = Modifier.padding(start = 36.dp),
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.size(4.dp))
                    Text(stringResource(R.string.booking_availability_add))
                }
            }
        }
        if (!availabilityValid(availability)) {
            Text(
                text = stringResource(R.string.booking_availability_invalid),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

// ---- Bookings viewer (per-link records: list / detail / owner cancel) ----

private val BOOKING_TIME_FMT: java.time.format.DateTimeFormatter =
    java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
        .withZone(java.time.ZoneId.systemDefault())

private fun formatBookingInstant(iso: String): String =
    runCatching { BOOKING_TIME_FMT.format(java.time.Instant.parse(iso)) }.getOrDefault(iso)

private fun bookingStatusRes(booking: Booking): Int = when {
    booking.cancelledAt != null -> R.string.booking_status_cancelled
    runCatching { java.time.Instant.parse(booking.endsAt) }.getOrNull()
        ?.isBefore(java.time.Instant.now()) == true -> R.string.booking_status_past
    else -> R.string.booking_status_confirmed
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BookingsSheet(
    link: BookingLink,
    onDismiss: () -> Unit,
    snackbar: SnackbarHostState,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var showAll by remember { mutableStateOf(false) }
    var bookings by remember { mutableStateOf<List<Booking>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<Booking?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(showAll, reloadKey) {
        bookings = null
        loadError = null
        try {
            val profile = BywaveApp.instance.profiles.active()
                ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
            val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
            bookings = client.api.bookings(link.id, if (showAll) 1 else null)
        } catch (e: Exception) {
            loadError = serverErrorMessage(e)
                ?: context.getString(R.string.booking_bookings_load_failed)
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp)
                .heightIn(max = 560.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = stringResource(R.string.booking_bookings_title, link.title),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = !showAll,
                    onClick = { showAll = false },
                    label = { Text(stringResource(R.string.booking_bookings_upcoming)) },
                )
                FilterChip(
                    selected = showAll,
                    onClick = { showAll = true },
                    label = { Text(stringResource(R.string.booking_bookings_all)) },
                )
            }
            when {
                loadError != null -> Text(loadError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                bookings == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(10.dp))
                    Text(stringResource(R.string.booking_loading), color = mutedTextColor())
                }
                bookings!!.isEmpty() -> Text(
                    stringResource(R.string.booking_bookings_empty),
                    color = mutedTextColor(),
                )
                else -> bookings!!.forEach { booking ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { selected = booking }
                            .padding(vertical = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                booking.guestName,
                                fontWeight = FontWeight.Medium,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                stringResource(bookingStatusRes(booking)),
                                style = MaterialTheme.typography.bodySmall,
                                color = if (booking.cancelledAt != null) MaterialTheme.colorScheme.error else mutedTextColor(),
                            )
                        }
                        Text(booking.guestEmail, style = MaterialTheme.typography.bodySmall, color = mutedTextColor(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            formatBookingInstant(booking.startsAt) + " – " + formatBookingInstant(booking.endsAt),
                            style = MaterialTheme.typography.bodySmall,
                            color = mutedTextColor(),
                        )
                    }
                    HorizontalDivider()
                }
            }
        }
    }

    selected?.let { booking ->
        BookingDetailDialog(
            link = link,
            booking = booking,
            onDismiss = { selected = null },
            onCancelled = {
                selected = null
                reloadKey++
                scope.launch { snackbar.showSnackbar(context.getString(R.string.booking_booking_cancelled)) }
            },
        )
    }
}

@Composable
private fun BookingDetailDialog(
    link: BookingLink,
    booking: Booking,
    onDismiss: () -> Unit,
    onCancelled: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var confirming by remember { mutableStateOf(false) }
    var cancelling by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (confirming) stringResource(R.string.booking_cancel_booking_title) else booking.guestName,
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (confirming) {
                    Text(
                        stringResource(
                            R.string.booking_cancel_booking_warning,
                            booking.guestName,
                            formatBookingInstant(booking.startsAt),
                        ),
                    )
                } else {
                    Text(stringResource(R.string.booking_guest_label) + ": " + booking.guestName)
                    Text(booking.guestEmail, style = MaterialTheme.typography.bodySmall, color = mutedTextColor())
                    Text(formatBookingInstant(booking.startsAt) + " – " + formatBookingInstant(booking.endsAt))
                    Text(
                        stringResource(bookingStatusRes(booking)),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (booking.cancelledAt != null) MaterialTheme.colorScheme.error else mutedTextColor(),
                    )
                    if (!booking.guestMessage.isNullOrBlank()) {
                        Text(stringResource(R.string.booking_message_label) + ": " + booking.guestMessage)
                    }
                }
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            if (confirming) {
                TextButton(
                    enabled = !cancelling,
                    onClick = {
                        scope.launch {
                            cancelling = true
                            error = null
                            try {
                                val profile = BywaveApp.instance.profiles.active()
                                    ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
                                val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                                client.api.cancelBooking(link.id, booking.id)
                                onCancelled()
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(R.string.booking_cancel_booking_failed)
                            } finally {
                                cancelling = false
                            }
                        }
                    },
                ) {
                    Text(
                        stringResource(R.string.booking_cancel_booking),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            } else if (booking.cancelledAt == null) {
                TextButton(onClick = { confirming = true }) {
                    Text(
                        stringResource(R.string.booking_cancel_booking),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        dismissButton = {
            TextButton(onClick = { if (confirming) confirming = false else onDismiss() }) {
                Text(stringResource(if (confirming) R.string.action_cancel else R.string.action_close))
            }
        },
    )
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
