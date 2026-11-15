package cn.bywave.calendar.connect

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URI

/** All settings are native. Only Microsoft consent and Apple OS installation leave the app. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CalendarConnectionPanel(
    api: CalendarConnectionApi,
    locale: String,
    apple: Boolean,
    deviceLabel: String,
    openUrl: (String) -> Unit,
    copy: (String) -> Unit,
    installProfile: suspend (String) -> Unit,
    errorMessage: (Throwable) -> String,
    active: Boolean = true,
    displayTimeZone: java.time.ZoneId = java.time.ZoneId.systemDefault(),
) {
    key(api) {
        CalendarConnectionContent(api, locale, apple, deviceLabel, openUrl, copy, installProfile, errorMessage, active, displayTimeZone)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CalendarConnectionContent(
    api: CalendarConnectionApi,
    locale: String,
    apple: Boolean,
    deviceLabel: String,
    openUrl: (String) -> Unit,
    copy: (String) -> Unit,
    installProfile: suspend (String) -> Unit,
    errorMessage: (Throwable) -> String,
    active: Boolean,
    displayTimeZone: java.time.ZoneId,
) {
    val t: (String) -> String = { CalendarCopy.text(locale, it) }
    val scope = rememberCoroutineScope()
    val requests = remember(api) { CalendarConnectionState(api) }
    val data = requests.data
    val busy = requests.busy
    var notice by remember(api) { mutableStateOf<String?>(null) }
    var secret by remember(api) { mutableStateOf<IssuedCalendarPassword?>(null) }
    var copied by remember(api) { mutableStateOf(false) }
    var left by remember(api) { mutableStateOf("") }
    var right by remember(api) { mutableStateOf("") }
    var confirmation by remember(api) { mutableStateOf<CalendarCommand?>(null) }
    var appleChosen by remember(api) { mutableStateOf<Set<String>?>(null) }
    var editingPassword by remember(api) { mutableStateOf<CalendarPassword?>(null) }
    var editingCalendars by remember(api) { mutableStateOf(emptySet<String>()) }
    var details by remember { mutableStateOf(false) }
    LaunchedEffect(data) {
        val next = data ?: return@LaunchedEffect
        if (next.pairs.any { it.calendarId == left } || next.calendars.none { it.id == left }) left = ""
        if (next.pairs.any { it.remoteId == right } || (next.remote != null && next.remote.none { it.id == right })) right = ""
    }
    fun run(reload: Boolean = false, work: suspend () -> Unit) {
        scope.launch {
            requests.perform(reload) { notice = null; work() }
        }
    }
    fun command(value: CalendarCommand) = run(reload = true) {
        val result = api.command(value)
        if (result.password != null) { secret = result.password; copied = false }
        if (value.action == "revoke-password" && value.id == secret?.id) { secret = null; copied = false }
        notice = t(if (value.action in listOf("sync", "pair")) "queued" else "saved")
    }
    // Load once even if this window has not received focus yet. Focus changes
    // only control polling, and cannot cancel a save or clear its busy state.
    LaunchedEffect(api) { requests.refresh(remote = true) }
    LaunchedEffect(api, active) {
        if (!active) return@LaunchedEffect
        requests.refresh(remote = requests.data == null)
        while (true) {
            delay(if (requests.data?.pairs?.isNotEmpty() == true) 5_000 else 30_000)
            requests.refresh(remote = false, quiet = true)
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(20.dp), modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(t("title"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text("ByWave Connect", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 6.dp))
            }
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            TextButton(onClick = { run(reload = true) {} }, enabled = !busy) { Text(t("refresh")) }
        }
        requests.error?.let { failure ->
            val saved = failure is CalendarStatusRefreshFailed && notice != null
            ConnectionCard {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (saved) Icon(Icons.Default.CheckCircle, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
                    Text(
                        if (saved) t("savedRefreshFailed") else errorMessage(failure.cause.takeIf { failure is CalendarStatusRefreshFailed } ?: failure),
                        modifier = Modifier.weight(1f),
                        color = if (saved) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
        notice?.takeUnless { requests.error is CalendarStatusRefreshFailed }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
        val state = data
        if (state == null && requests.error == null) ConnectionCard {
            Text(t("loading"), style = MaterialTheme.typography.titleMedium)
            Text(t("intro"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        if (state != null) {
            ConnectionCard {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(if (state.account != null) Icons.Default.CheckCircle else Icons.Default.Sync, null, tint = MaterialTheme.colorScheme.primary)
                    Column {
                        Text("Outlook", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        Text(state.account?.label ?: t("connect"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Text(t("outlookIntro"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (!state.configured) Text(t("notConfigured"), style = MaterialTheme.typography.bodyMedium)
                else OutlinedButton(onClick = { command(CalendarCommand("connect")) }, enabled = !busy && state.login == null) { Text(t(if (state.account == null) "connect" else "reconnect")) }
                state.login?.let { login ->
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .45f))
                    Text(t("loginHelp"))
                    SelectionContainer { Text(login.userCode, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold) }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(enabled = !busy, onClick = { run {
                            val uri = URI(login.verificationUri)
                            require(uri.scheme == "https" && uri.userInfo == null && uri.host in setOf("microsoft.com", "www.microsoft.com", "login.microsoftonline.com"))
                            openUrl(login.verificationUri)
                        } }) { Text(t("loginOpen")) }
                        OutlinedButton(enabled = !busy, onClick = { command(CalendarCommand("finish")) }) { Text(t("finish")) }
                        TextButton(enabled = !busy, onClick = { command(CalendarCommand("cancel")) }) { Text(t("cancel")) }
                    }
                    Text(t("expires"), style = MaterialTheme.typography.bodySmall)
                }
                if (state.account != null) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .45f))
                    Text(t("pairTitle"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(t("pairHelp"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (state.remoteError) Text(t("remoteUnavailable"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    CalendarPicker("ByWave", left, state.calendars.filter { c -> state.pairs.none { it.calendarId == c.id } }, t("choose"), !busy) { left = it }
                    CalendarPicker("Outlook", right, state.remote.orEmpty().filter { c -> state.pairs.none { it.remoteId == c.id } }, t("choose"), !busy && !state.remoteError) { right = it }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { command(CalendarCommand("pair", calendarId = left, remoteId = right)) }, enabled = !busy && !state.remoteError && state.calendars.any { it.id == left } && state.remote.orEmpty().any { it.id == right } && state.pairs.none { it.calendarId == left || it.remoteId == right }) { Text(t("start")) }
                        TextButton(onClick = { command(CalendarCommand("create-calendar")) }, enabled = !busy) { Text(t("createCalendar")) }
                    }
                }
            }
            state.pairs.forEach { pair ->
                key(pair.id) { ConnectionCard {
                    Text((state.calendars.find { it.id == pair.calendarId }?.name ?: "ByWave") + "  ↔  " + pair.remoteName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(if (!pair.enabled) t("paused") else pair.lastSyncedAt?.let { t("lastSync") + " · " + formatSyncTime(it, displayTimeZone, locale) } ?: t("pending"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    pair.error?.let { Text(t("error." + if (it in setOf("invalid_grant", "microsoft_reconnect", "calendar_changed_retry")) it else "unavailable"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(enabled = !busy, onClick = { command(CalendarCommand(if (pair.enabled) "pause" else "resume", id = pair.id)) }) { Text(t(if (pair.enabled) "pause" else "resume")) }
                        if (pair.enabled) TextButton(enabled = !busy, onClick = { command(CalendarCommand("sync", id = pair.id)) }) { Text(t("syncNow")) }
                    }
                    pair.conflicts.forEach { conflict ->
                        Text(t("conflictTitle"), color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Medium)
                        listOf("ByWave" to conflict.left, "Outlook" to conflict.right).forEach { (name, item) ->
                            Text(name, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            Text(item?.content?.summary ?: t("deleted"), fontWeight = FontWeight.Medium)
                            item?.content?.let {
                                Text(formatSyncTime(it.startsAt, displayTimeZone, locale) + " — " + formatSyncTime(it.endsAt, displayTimeZone, locale), style = MaterialTheme.typography.bodySmall)
                                if (it.location.isNotEmpty()) Text(it.location, style = MaterialTheme.typography.bodySmall)
                                if (it.description.isNotEmpty()) Text(it.description, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("left" to "keepLeft", "right" to "keepRight").forEach { (side, label) ->
                                OutlinedButton(enabled = !busy, onClick = { confirmation = CalendarCommand("resolve", id = pair.id, key = conflict.key, side = side, leftRevision = conflict.left?.revision ?: "", rightRevision = conflict.right?.revision ?: "") }) { Text(t(label)) }
                            }
                        }
                    }
                } }
            }
            if (apple) ConnectionCard {
                Text(t("appleAccount"), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Text(t("appleIntro"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (!state.apple.available) Text(t("https")) else {
                    SelectionContainer { Text(state.apple.username + "\n" + state.apple.serverUrl, style = MaterialTheme.typography.bodySmall) }
                    Text(t("choose"), style = MaterialTheme.typography.titleSmall)
                    val chosen = appleChosen ?: state.calendars.map { it.id }.toSet()
                    state.calendars.forEach { calendar ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(calendar.id in chosen, enabled = !busy, onCheckedChange = { checked -> appleChosen = if (checked) chosen + calendar.id else chosen - calendar.id })
                            Text(calendar.name, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    Button(enabled = !busy && chosen.isNotEmpty(), onClick = { command(CalendarCommand("apple-password", label = deviceLabel, calendarIds = chosen.toList())) }) { Text(t("appleStep1")) }
                    secret?.let { password ->
                        Text(t("passwordOnce"), style = MaterialTheme.typography.bodySmall)
                        SelectionContainer { Text(password.plain, style = MaterialTheme.typography.titleMedium) }
                        TextButton(onClick = { run { copy(password.plain); copied = true } }) { Text(t(if (copied) "copied" else "copy")) }
                    }
                    OutlinedButton(enabled = !busy, onClick = { run { installProfile(api.appleProfile().profile) } }) { Text(t("appleStep2")) }
                    Text(t("appleStep3"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                state.apple.passwords.forEach { password ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(password.label, style = MaterialTheme.typography.bodyMedium)
                            Text(if (password.paused) t("paused") else password.lastUsedAt?.let { t("lastSync") + " · " + formatSyncTime(it, displayTimeZone, locale) } ?: t("pending"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(enabled = !busy, onClick = { confirmation = CalendarCommand("revoke-password", id = password.id) }) { Text(t("revoke")) }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(enabled = !busy, onClick = { editingPassword = password; editingCalendars = password.calendarIds?.toSet() ?: state.calendars.map { it.id }.toSet() }) { Text(t("choose")) }
                        TextButton(enabled = !busy, onClick = { command(CalendarCommand("apple-settings", id = password.id, paused = !password.paused)) }) { Text(t(if (password.paused) "resume" else "pause")) }
                    }
                }
            }
            TextButton(onClick = { details = !details }) { Text(t("details")) }
            if (details) Text(t("scope"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.account != null) TextButton(enabled = !busy, onClick = { confirmation = CalendarCommand("disconnect", confirm = "disconnect") }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(t("disconnectTitle")) }
        }
    }
    editingPassword?.let { password ->
        AlertDialog(onDismissRequest = { editingPassword = null }, title = { Text(t("choose")) }, text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                data?.calendars?.forEach { calendar ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(calendar.id in editingCalendars, onCheckedChange = { checked -> editingCalendars = if (checked) editingCalendars + calendar.id else editingCalendars - calendar.id })
                        Text(calendar.name)
                    }
                }
            }
        }, confirmButton = { TextButton(onClick = { editingPassword = null; command(CalendarCommand("apple-settings", id = password.id, paused = password.paused, calendarIds = editingCalendars.toList())) }) { Text(t("save")) } }, dismissButton = { TextButton(onClick = { editingPassword = null }) { Text(t("cancel")) } })
    }
    confirmation?.let { pending ->
        val label = when (pending.action) { "disconnect" -> "disconnect"; "resolve" -> if (pending.side == "left") "keepLeft" else "keepRight"; else -> "revoke" }
        AlertDialog(onDismissRequest = { confirmation = null }, title = { Text(t(label)) }, text = { Text(t(when (pending.action) { "disconnect" -> "disconnectHelp"; "resolve" -> "conflictTitle"; else -> "revokeHelp" })) },
            confirmButton = { TextButton(onClick = { confirmation = null; command(pending) }) { Text(t(label)) } }, dismissButton = { TextButton(onClick = { confirmation = null }) { Text(t("cancel")) } })
    }
}

@Composable
private fun ConnectionCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = .4f)), modifier = Modifier.fillMaxWidth().animateContentSize()) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp), content = content)
    }
}

@Composable
private fun CalendarPicker(label: String, selected: String, items: List<SyncCalendar>, placeholder: String, enabled: Boolean, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(onClick = { expanded = true }, enabled = enabled && items.isNotEmpty(), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) { Text(items.find { it.id == selected }?.name ?: placeholder, modifier = Modifier.weight(1f)) }
            DropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
                items.forEach { calendar -> DropdownMenuItem(text = { Text(calendar.name) }, onClick = { onSelect(calendar.id); expanded = false }) }
            }
        }
    }
}

@Composable
internal fun formatSyncTime(value: String, displayTimeZone: java.time.ZoneId, locale: String): String {
    val formatter = remember(displayTimeZone, locale) {
        java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.SHORT)
            .withLocale(java.util.Locale.forLanguageTag(locale)).withZone(displayTimeZone)
    }
    return runCatching { formatter.format(java.time.Instant.parse(value)) }.getOrDefault(value)
}
