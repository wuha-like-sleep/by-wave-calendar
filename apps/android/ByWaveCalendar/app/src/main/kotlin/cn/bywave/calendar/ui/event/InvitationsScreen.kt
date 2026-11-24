// InvitationsScreen — invitee side of event invitations (I am the
// guest, not the organizer). Reached from the calendar top bar's
// invitations button (with a pending-count badge) and from
// bywave://invitations/<token> deep links.
//
// Mirrors the web /event-invite/:token page: event summary in the
// event's own timezone, organizer row, full invitee list with
// per-person status, Accept / Maybe / Decline, and propose-a-new-time
// with my proposal history. All data comes from GET /api/v1/invitations
// (one fetch carries list + detail); respond / propose POST through
// the invite token and the screen reloads from the server afterwards —
// nothing is faked locally, so a failed call can never look successful.

package cn.bywave.calendar.ui.event

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.Invitation
import cn.bywave.calendar.ui.components.EmptyState
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InvitationsScreen(
    openToken: String?,
    onBack: () -> Unit,
    vm: InvitationsViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    LaunchedEffect(openToken) { vm.bootstrap(openToken) }

    // RSVP 提交成功给一下轻震（触觉定版口径，与 iOS 的
    // .success 一一对应；沿用仓内 LongPress 一档）。只认成功
    // 计数的新增：lastBuzzedSeq 在进入组合时以当前计数起步，
    // 失败不涨、离开再回来不重放。
    val haptic = LocalHapticFeedback.current
    var lastBuzzedSeq by remember { mutableStateOf(state.respondSuccessSeq) }
    LaunchedEffect(state.respondSuccessSeq) {
        if (state.respondSuccessSeq > lastBuzzedSeq) {
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        }
        lastBuzzedSeq = state.respondSuccessSeq
    }

    val selected = state.invitations.firstOrNull { it.token == state.selectedToken }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.invitations_title)) },
                navigationIcon = {
                    IconButton(onClick = {
                        // Detail → back to the list first; list → leave.
                        if (selected != null) vm.select(null) else onBack()
                    }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.attendees_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
        ) {
            when {
                state.loading && state.invitations.isEmpty() -> {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                }
                selected != null -> {
                    InvitationDetail(
                        inv = selected,
                        acting = state.acting,
                        actionError = state.actionError,
                        onRespond = { vm.respond(it) },
                        onPropose = { s, e, n -> vm.propose(s, e, n) },
                    )
                }
                state.errorMessage != null && state.invitations.isEmpty() -> {
                    EmptyState(
                        title = state.errorMessage!!,
                        icon = Icons.Outlined.Email,
                        action = {
                            TextButton(onClick = { vm.load() }) {
                                Text(stringResource(R.string.action_retry))
                            }
                        },
                    )
                }
                state.invitations.isEmpty() -> {
                    EmptyState(
                        title = stringResource(R.string.invitations_empty_title),
                        subtitle = stringResource(R.string.invitations_empty_subtitle),
                        icon = Icons.Outlined.Email,
                    )
                }
                else -> {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        items(state.invitations, key = { it.token }) { inv ->
                            InvitationRow(inv = inv, onClick = { vm.select(inv.token) })
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InvitationRow(inv: Invitation, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = inv.event.summary,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.size(8.dp))
            StatusChip(inv.responseStatus)
        }
        Text(
            text = invitationTimeText(inv),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        inv.organizer?.let { org ->
            Text(
                text = "${stringResource(R.string.invitations_organizer)}: ${org.name}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (inv.event.cancelled) {
            Text(
                text = stringResource(R.string.invitations_cancelled),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun InvitationDetail(
    inv: Invitation,
    acting: Boolean,
    actionError: String?,
    onRespond: (String) -> Unit,
    onPropose: (String, String, String?) -> Unit,
) {
    val zone = zoneOf(inv.event.timeZone)
    val expired = remember(inv.expiresAt) {
        runCatching { Instant.parse(inv.expiresAt).isBefore(Instant.now()) }.getOrDefault(false)
    }
    val canAct = !inv.event.cancelled && !expired && !acting

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Event summary
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = inv.event.summary,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = invitationTimeText(inv),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = stringResource(R.string.invitations_time_in_tz, inv.event.timeZone),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            inv.event.location?.takeIf { it.isNotBlank() }?.let {
                Text(text = it, style = MaterialTheme.typography.bodyMedium)
            }
            inv.event.description?.takeIf { it.isNotBlank() }?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (inv.event.cancelled) {
                Text(
                    text = stringResource(R.string.invitations_cancelled),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.SemiBold,
                )
            } else if (expired) {
                Text(
                    text = stringResource(R.string.invitations_expired),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        HorizontalDivider()

        // Organizer + invitee list — same information architecture as
        // the web invite page: organizer first (badged), then everyone
        // with their current status.
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = stringResource(R.string.event_detail_attendees_count, inv.invitees.size),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            inv.organizer?.let { org ->
                InviteeRow(
                    primary = org.name,
                    secondary = org.email,
                    badge = stringResource(R.string.invitations_organizer),
                    status = null,
                )
            }
            inv.invitees.forEach { person ->
                InviteeRow(
                    primary = person.name ?: person.email,
                    secondary = if (person.name != null) person.email else null,
                    badge = if (person.isMe) stringResource(R.string.invitations_you) else null,
                    status = person.status,
                )
            }
        }

        if (!inv.event.cancelled) {
            HorizontalDivider()

            // RSVP — the current reply is the filled button; tapping
            // another one changes the reply (the server allows changing
            // your mind, same as the web page).
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = stringResource(R.string.invitations_rsvp_heading),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RsvpButton(
                        label = stringResource(R.string.invitations_accept),
                        selected = inv.responseStatus == "accepted",
                        enabled = canAct,
                        modifier = Modifier.weight(1f),
                    ) { onRespond("accepted") }
                    RsvpButton(
                        label = stringResource(R.string.attendees_status_tentative),
                        selected = inv.responseStatus == "tentative",
                        enabled = canAct,
                        modifier = Modifier.weight(1f),
                    ) { onRespond("tentative") }
                    RsvpButton(
                        label = stringResource(R.string.attendees_proposal_decline),
                        selected = inv.responseStatus == "declined",
                        enabled = canAct,
                        modifier = Modifier.weight(1f),
                    ) { onRespond("declined") }
                }
                if (acting) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                }
                if (actionError != null) {
                    Text(
                        text = actionError,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            HorizontalDivider()

            ProposeSection(inv = inv, zone = zone, canAct = canAct, onPropose = onPropose)
        }
    }
}

@Composable
private fun InviteeRow(
    primary: String,
    secondary: String?,
    badge: String?,
    status: String?,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = primary,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (badge != null) {
                    Spacer(Modifier.size(6.dp))
                    Text(
                        text = badge,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier
                            .clip(RoundedCornerShape(50))
                            .background(MaterialTheme.colorScheme.secondaryContainer)
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            if (secondary != null) {
                Text(
                    text = secondary,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (status != null) {
            Spacer(Modifier.size(8.dp))
            StatusChip(status)
        }
    }
}

@Composable
private fun RsvpButton(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    if (selected) {
        Button(onClick = onClick, enabled = enabled, modifier = modifier) { Text(label, maxLines = 1) }
    } else {
        OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier) { Text(label, maxLines = 1) }
    }
}

@Composable
private fun StatusChip(status: String) {
    val (labelRes, bg, fg) = when (status) {
        "accepted" -> Triple(
            R.string.attendees_status_accepted,
            MaterialTheme.colorScheme.primaryContainer,
            MaterialTheme.colorScheme.onPrimaryContainer,
        )
        "declined" -> Triple(
            R.string.attendees_status_declined,
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
        )
        "tentative" -> Triple(
            R.string.attendees_status_tentative,
            MaterialTheme.colorScheme.tertiaryContainer,
            MaterialTheme.colorScheme.onTertiaryContainer,
        )
        else -> Triple(
            R.string.attendees_status_pending,
            MaterialTheme.colorScheme.surfaceVariant,
            MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    Text(
        text = stringResource(labelRes),
        style = MaterialTheme.typography.labelSmall,
        color = fg,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(bg)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
private fun ProposeSection(
    inv: Invitation,
    zone: ZoneId,
    canAct: Boolean,
    onPropose: (String, String, String?) -> Unit,
) {
    var showForm by remember(inv.token) { mutableStateOf(false) }
    val startInstant = remember(inv.token) { instantOf(inv.event.startsAt) }
    val endInstant = remember(inv.token) { instantOf(inv.event.endsAt) }
    var pStart by remember(inv.token) {
        mutableStateOf(startInstant?.atZone(zone)?.toLocalDateTime() ?: LocalDateTime.now(zone))
    }
    var pEnd by remember(inv.token) {
        mutableStateOf(endInstant?.atZone(zone)?.toLocalDateTime() ?: LocalDateTime.now(zone).plusHours(1))
    }
    var note by remember(inv.token) { mutableStateOf("") }
    var badRange by remember(inv.token) { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = stringResource(R.string.invitations_propose_title),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )

        if (inv.myProposals.isNotEmpty()) {
            Text(
                text = stringResource(R.string.invitations_my_proposals),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            inv.myProposals.forEach { p ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = proposalTimeText(p.proposedStartsAt, p.proposedEndsAt, zone, inv.event.allDay),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        p.note?.takeIf { it.isNotBlank() }?.let {
                            Text(
                                text = it,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Spacer(Modifier.size(8.dp))
                    ProposalStatusChip(p.status)
                }
            }
        }

        if (!showForm) {
            OutlinedButton(onClick = { showForm = true }, enabled = canAct) {
                Text(stringResource(R.string.invitations_propose_title))
            }
        } else {
            ProposalDateTimeRow(
                label = stringResource(R.string.invitations_propose_start),
                value = pStart,
                allDay = inv.event.allDay,
                onChange = { pStart = it },
            )
            ProposalDateTimeRow(
                label = stringResource(R.string.invitations_propose_end),
                value = pEnd,
                allDay = inv.event.allDay,
                onChange = { pEnd = it },
            )
            OutlinedTextField(
                value = note,
                onValueChange = { note = it },
                label = { Text(stringResource(R.string.invitations_propose_note)) },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 3,
            )
            if (badRange) {
                Text(
                    text = stringResource(R.string.invitations_propose_bad_range),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    enabled = canAct,
                    onClick = {
                        if (!pEnd.isAfter(pStart)) {
                            badRange = true
                            return@Button
                        }
                        badRange = false
                        val s = pStart.atZone(zone).toInstant().toString()
                        val e = pEnd.atZone(zone).toInstant().toString()
                        onPropose(s, e, note)
                        showForm = false
                    },
                ) { Text(stringResource(R.string.invitations_propose_submit)) }
                TextButton(onClick = { showForm = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
        }
    }
}

@Composable
private fun ProposalStatusChip(status: String) {
    val labelRes = when (status) {
        "accepted" -> R.string.attendees_status_accepted
        "declined" -> R.string.attendees_status_declined
        "superseded" -> R.string.attendees_proposal_superseded
        else -> R.string.invitations_proposal_pending
    }
    Text(
        text = stringResource(labelRes),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** Date + time row for the proposal form — same interaction shape as
 *  the event editor's rows (date button + time button, Material 3
 *  dialogs), values interpreted in the EVENT's timezone. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProposalDateTimeRow(
    label: String,
    value: LocalDateTime,
    allDay: Boolean,
    onChange: (LocalDateTime) -> Unit,
) {
    var showDate by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }
    val dateFmt = remember { DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM) }
    val timeFmt = remember { DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT) }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        TextButton(onClick = { showDate = true }) {
            Text(dateFmt.format(value.toLocalDate()), maxLines = 1)
        }
        if (!allDay) {
            TextButton(onClick = { showTime = true }) {
                Text(timeFmt.format(value.toLocalTime()), maxLines = 1)
            }
        }
    }

    if (showDate) {
        val initMillis = value.toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val pickerState = rememberDatePickerState(initialSelectedDateMillis = initMillis)
        DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                TextButton(onClick = {
                    val ms = pickerState.selectedDateMillis ?: initMillis
                    val picked: LocalDate = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()
                    onChange(LocalDateTime.of(picked, value.toLocalTime()))
                    showDate = false
                }) { Text(stringResource(R.string.eventedit_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showDate = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        ) { DatePicker(state = pickerState) }
    }

    if (showTime) {
        val pickerState = rememberTimePickerState(
            initialHour = value.hour,
            initialMinute = value.minute,
            is24Hour = true,
        )
        AlertDialog(
            onDismissRequest = { showTime = false },
            title = { Text(label) },
            text = { TimePicker(state = pickerState) },
            confirmButton = {
                TextButton(onClick = {
                    onChange(LocalDateTime.of(value.toLocalDate(), LocalTime.of(pickerState.hour, pickerState.minute)))
                    showTime = false
                }) { Text(stringResource(R.string.eventedit_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showTime = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
}

// ---- Time formatting (always in the event's display timezone) ----

private fun zoneOf(id: String): ZoneId =
    runCatching { ZoneId.of(id) }.getOrDefault(ZoneId.systemDefault())

private fun instantOf(iso: String): Instant? =
    runCatching { Instant.parse(iso) }.getOrNull()

private fun invitationTimeText(inv: Invitation): String =
    rangeText(inv.event.startsAt, inv.event.endsAt, zoneOf(inv.event.timeZone), inv.event.allDay)

private fun proposalTimeText(startsAt: String, endsAt: String, zone: ZoneId, allDay: Boolean): String =
    rangeText(startsAt, endsAt, zone, allDay)

private fun rangeText(startsAt: String, endsAt: String, zone: ZoneId, allDay: Boolean): String {
    val start = instantOf(startsAt) ?: return startsAt
    val end = instantOf(endsAt) ?: return endsAt
    val dateFmt = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(zone)
    val timeFmt = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(zone)
    val sDate = dateFmt.format(start)
    val eDate = dateFmt.format(end)
    return if (allDay) {
        if (sDate == eDate) sDate else "$sDate – $eDate"
    } else if (sDate == eDate) {
        "$sDate ${timeFmt.format(start)} – ${timeFmt.format(end)}"
    } else {
        "$sDate ${timeFmt.format(start)} – $eDate ${timeFmt.format(end)}"
    }
}
