package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.model.InvitationEvent
import cn.bywave.calendar.desktop.data.model.MyInvitation
import cn.bywave.calendar.desktop.i18n.I18n
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.launch

/**
 * 我收到的邀请 — the invitee side of event invitations, mirroring the
 * web /event-invite page: event summary in the event's own timezone,
 * organizer + full invitee list with per-person status, Accept /
 * Maybe / Decline, and propose-a-new-time with my proposal history.
 *
 * Every mutation goes to the server first and the list is re-fetched
 * afterwards — nothing is updated optimistically, so a failed call
 * shows an error instead of a fake success.
 */
@Composable
fun InvitationsDialog(
    client: ApiClient,
    onDismiss: () -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var invitations by remember { mutableStateOf<List<MyInvitation>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var selectedToken by remember { mutableStateOf<String?>(null) }
    var acting by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        loading = true
        try {
            invitations = client.invitations().invitations
            loadError = null
        } catch (e: Exception) {
            loadError = t("invitations.errorLoad")
        } finally {
            loading = false
        }
    }

    LaunchedEffect(client) { load() }

    fun mutate(errorKey: String, block: suspend () -> Unit) {
        if (acting) return
        acting = true
        actionError = null
        scope.launch {
            try {
                block()
                load()
            } catch (e: Exception) {
                actionError = t(errorKey)
            } finally {
                acting = false
            }
        }
    }

    val selected = invitations.firstOrNull { it.token == selectedToken }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(t("invitations.title")) },
        text = {
            Box(Modifier.width(580.dp)) {
                when {
                    loading && invitations.isEmpty() -> {
                        Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    }
                    selected != null -> InvitationDetail(
                        inv = selected,
                        t = t,
                        acting = acting,
                        actionError = actionError,
                        onRespond = { status ->
                            mutate("invitations.errorRespond") {
                                client.respondInvitation(selected.token, status)
                            }
                        },
                        onPropose = { startIso, endIso, note ->
                            mutate("invitations.errorPropose") {
                                client.proposeInvitation(selected.token, startIso, endIso, note)
                            }
                        },
                    )
                    invitations.isEmpty() -> {
                        Column(Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
                            Text(loadError ?: t("invitations.empty"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (loadError != null) {
                                Spacer(Modifier.height(8.dp))
                                OutlinedButton(onClick = { scope.launch { load() } }) { Text(t("invitations.retry")) }
                            }
                        }
                    }
                    else -> {
                        LazyColumn(Modifier.heightIn(max = 520.dp)) {
                            items(invitations, key = { it.token }) { inv ->
                                InvitationRow(inv = inv, t = t, onClick = { selectedToken = inv.token; actionError = null })
                                HorizontalDivider()
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = { if (selected != null) selectedToken = null else onDismiss() }) {
                Text(t(if (selected != null) "common.back" else "common.close"))
            }
        },
    )
}

@Composable
private fun InvitationRow(
    inv: MyInvitation,
    t: (String) -> String,
    onClick: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                inv.event.summary,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
            )
            Text(
                t("attendees.status.${inv.responseStatus}"),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        Text(
            formatRange(inv.event),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        inv.organizer?.let { org ->
            Text(
                "${t("invitations.organizer")}: ${org.name}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (inv.event.cancelled) {
            Text(t("invitations.cancelled"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun InvitationDetail(
    inv: MyInvitation,
    t: (String) -> String,
    acting: Boolean,
    actionError: String?,
    onRespond: (String) -> Unit,
    onPropose: (String, String, String?) -> Unit,
) {
    val zone = remember(inv.event.timeZone) {
        runCatching { ZoneId.of(inv.event.timeZone) }.getOrDefault(ZoneId.systemDefault())
    }
    val expired = remember(inv.expiresAt) {
        runCatching { Instant.parse(inv.expiresAt) }.getOrNull()?.isBefore(Instant.now()) ?: false
    }
    val canAct = !inv.event.cancelled && !expired && !acting

    var showPropose by remember(inv.token) { mutableStateOf(false) }
    var propStart by remember(inv.token) {
        mutableStateOf(parseInstant(inv.event.startsAt)?.atZone(zone)?.toLocalDateTime() ?: LocalDateTime.now(zone))
    }
    var propEnd by remember(inv.token) {
        mutableStateOf(parseInstant(inv.event.endsAt)?.atZone(zone)?.toLocalDateTime() ?: LocalDateTime.now(zone).plusHours(1))
    }
    var propNote by remember(inv.token) { mutableStateOf("") }
    var badRange by remember(inv.token) { mutableStateOf(false) }

    Column(
        Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(inv.event.summary, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(formatRange(inv.event), style = MaterialTheme.typography.bodyMedium)
        Text(
            "${t("invitations.timeInTz")}: ${inv.event.timeZone}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        inv.event.location?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        inv.event.description?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (inv.event.cancelled) {
            Text(t("invitations.cancelled"), color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.SemiBold)
        } else if (expired) {
            Text(t("invitations.expired"), color = MaterialTheme.colorScheme.error)
        }

        Spacer(Modifier.height(6.dp))
        Text(
            "${t("invitations.invitees")} (${inv.invitees.size})",
            style = MaterialTheme.typography.labelLarge,
        )
        inv.organizer?.let { org ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(org.name, style = MaterialTheme.typography.bodyMedium)
                    Text(org.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(t("invitations.organizer"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        inv.invitees.forEach { person ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(person.name ?: person.email, style = MaterialTheme.typography.bodyMedium)
                        if (person.isMe) {
                            Spacer(Modifier.width(6.dp))
                            Text(t("invitations.you"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                    if (person.name != null) {
                        Text(person.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Text(
                    t("attendees.status.${person.status}"),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (!inv.event.cancelled) {
            Spacer(Modifier.height(6.dp))
            Text(t("invitations.rsvpHeading"), style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(
                    "accepted" to t("invitations.accept"),
                    "tentative" to t("attendees.status.tentative"),
                    "declined" to t("attendees.status.declined"),
                ).forEach { (status, label) ->
                    if (inv.responseStatus == status) {
                        Button(onClick = { onRespond(status) }, enabled = canAct) { Text(label) }
                    } else {
                        OutlinedButton(onClick = { onRespond(status) }, enabled = canAct) { Text(label) }
                    }
                }
                if (acting) CircularProgressIndicator(Modifier.height(20.dp))
            }
            if (actionError != null) {
                Text(actionError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }

            Spacer(Modifier.height(6.dp))
            Text(t("invitations.myProposals"), style = MaterialTheme.typography.labelLarge)
            inv.myProposals.forEach { p ->
                Column {
                    Text(
                        formatRange(p.proposedStartsAt, p.proposedEndsAt, inv.event.allDay, zone),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    p.note?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(
                        when (p.status) {
                            "accepted" -> t("invitations.proposalAccepted")
                            "declined" -> t("invitations.proposalDeclined")
                            "superseded" -> t("attendees.proposal.superseded")
                            else -> t("invitations.proposalPending")
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (showPropose) {
                ProposalTimeRow(t("invitations.proposeStart"), propStart, inv.event.allDay) { propStart = it }
                ProposalTimeRow(t("invitations.proposeEnd"), propEnd, inv.event.allDay) { propEnd = it }
                OutlinedTextField(
                    value = propNote,
                    onValueChange = { propNote = it },
                    label = { Text(t("invitations.proposeNote")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (badRange) {
                    Text(t("invitations.proposeBadRange"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            val startInstant = propStart.atZone(zone).toInstant()
                            val endInstant = propEnd.atZone(zone).toInstant()
                            if (!endInstant.isAfter(startInstant)) {
                                badRange = true
                            } else {
                                badRange = false
                                onPropose(startInstant.toString(), endInstant.toString(), propNote.ifBlank { null })
                                showPropose = false
                                propNote = ""
                            }
                        },
                        enabled = canAct,
                    ) { Text(t("invitations.proposeSubmit")) }
                    OutlinedButton(onClick = { showPropose = false }) { Text(t("common.cancel")) }
                }
            } else {
                OutlinedButton(onClick = { showPropose = true }, enabled = canAct) {
                    Text(t("invitations.propose"))
                }
            }
        }
    }
}

/** Date (+ time unless all-day) picker row. The wall time it edits is
 *  in the event's timezone — the caller converts with that zone when
 *  submitting. Same Material3 pickers the event editor uses, without
 *  its occurrence-anchoring machinery. */
@Composable
private fun ProposalTimeRow(
    label: String,
    value: LocalDateTime,
    allDay: Boolean,
    onChange: (LocalDateTime) -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> I18n.t(key) } }
    var showDate by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            modifier = Modifier.width(64.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        OutlinedButton(onClick = { showDate = true }, modifier = Modifier.weight(1f)) {
            Text(value.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)))
        }
        if (!allDay) {
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = { showTime = true }, modifier = Modifier.width(110.dp)) {
                Text(value.format(DateTimeFormatter.ofPattern("HH:mm")))
            }
        }
    }

    if (showDate) {
        val dpState = rememberDatePickerState(
            initialSelectedDateMillis = value.toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        )
        DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                TextButton(onClick = {
                    dpState.selectedDateMillis?.let { millis ->
                        val date = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()
                        onChange(LocalDateTime.of(date, value.toLocalTime()))
                    }
                    showDate = false
                }) { Text(t("event.edit.confirm")) }
            },
            dismissButton = {
                TextButton(onClick = { showDate = false }) { Text(t("event.edit.cancel")) }
            },
        ) {
            DatePicker(state = dpState)
        }
    }
    if (showTime) {
        val tpState = rememberTimePickerState(initialHour = value.hour, initialMinute = value.minute, is24Hour = true)
        AlertDialog(
            onDismissRequest = { showTime = false },
            title = { Text(t("event.edit.pickTime")) },
            text = {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    TimePicker(state = tpState)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    onChange(value.withHour(tpState.hour).withMinute(tpState.minute))
                    showTime = false
                }) { Text(t("event.edit.confirm")) }
            },
            dismissButton = {
                TextButton(onClick = { showTime = false }) { Text(t("event.edit.cancel")) }
            },
        )
    }
}

private fun parseInstant(iso: String): Instant? = runCatching { Instant.parse(iso) }.getOrNull()

private fun formatRange(event: InvitationEvent): String {
    val zone = runCatching { ZoneId.of(event.timeZone) }.getOrDefault(ZoneId.systemDefault())
    return formatRange(event.startsAt, event.endsAt, event.allDay, zone)
}

private fun formatRange(startIso: String, endIso: String, allDay: Boolean, zone: ZoneId): String {
    val start = parseInstant(startIso) ?: return startIso
    val end = parseInstant(endIso) ?: return endIso
    return if (allDay) {
        val fmt = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(zone)
        val s = fmt.format(start)
        val e = fmt.format(end)
        if (s == e) s else "$s – $e"
    } else {
        val fmt = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(zone)
        "${fmt.format(start)} – ${fmt.format(end)}"
    }
}
