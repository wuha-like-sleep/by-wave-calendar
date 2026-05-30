// Desktop Settings page — opened from the toolbar gear icon (or Cmd+,).
// Mirrors the web /app/settings sections but trimmed for what makes
// sense on a desktop client:
//
//   Account     — email / displayName / serverUrl readout, profile switch,
//                 sign out
//   Calendars   — list calendars with color + name (read-only for now;
//                 edit links to web)
//   Security    — 修改密码 / Passkey / MFA / 我的设备 / 删除账号 — all
//                 deep-link to the web /app/settings#... via a one-shot
//                 web-session token (POST /api/v1/auth/web-session).
//                 The desktop has full bearer access, so the bridge
//                 mints the cookie session in the browser without the
//                 user re-entering their password.
//   Appearance  — same deep-link to /app/settings#theme. (Desktop doesn't
//                 read the server-side theme preference yet — that's a
//                 future enhancement; for now Settings just opens the
//                 web picker so changes take effect there.)
//   About       — version + check-for-update + GitHub + license
//
// Layout: left rail nav (220dp) + right pane content. Renders as a
// full-screen overlay above MainScreen — Esc or the X button closes.
//
// Deep-links use java.awt.Desktop.browse(URI) which delegates to the OS
// default browser. We don't bundle Chromium / open inside the app —
// keeping the app surface trimmed is the whole point of routing these
// flows out.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.bywave.calendar.desktop.BuildInfo
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.model.BookingLink
import cn.bywave.calendar.desktop.data.model.BookingLinkCreateInput
import cn.bywave.calendar.desktop.data.model.BookingLinkUpdateInput
import cn.bywave.calendar.desktop.data.model.CalendarCreateInput
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.CalendarUpdateInput
import cn.bywave.calendar.desktop.data.model.Profile
import cn.bywave.calendar.desktop.data.model.ShareToken
import cn.bywave.calendar.desktop.data.update.UpdateChecker
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import kotlinx.coroutines.launch
import java.awt.Desktop
import java.net.URI

/** Which left-rail tab is active. Order here = order in the nav rail.
 *  Labels are I18n keys, resolved at render time so switching language
 *  in the Appearance section instantly updates the tab labels. */
private enum class SettingsTab(val labelKey: String, val icon: ImageVector) {
    Account("settings.tabAccount", Icons.Default.AccountCircle),
    Calendars("settings.tabCalendars", Icons.Default.CalendarMonth),
    Booking("settings.tabBooking", Icons.Default.Link),
    Security("settings.tabSecurity", Icons.Default.Security),
    Appearance("settings.tabAppearance", Icons.Default.Brush),
    About("settings.tabAbout", Icons.Default.Info),
}

@Composable
fun SettingsScreen(
    profile: Profile,
    profiles: List<Profile>,
    calendars: List<CalendarMeta>,
    onClose: () -> Unit,
    onSignOut: () -> Unit,
    onSwitchProfile: (String) -> Unit,
    onRemoveProfile: (String) -> Unit,
    onAddAccount: () -> Unit,
    onCheckUpdate: () -> Unit,
    /** Called after a calendar create / update / delete succeeds. The
     *  caller (MainScreen) re-runs the events fetch — calendars are
     *  embedded in that response, so reloading is how the new/edited/
     *  deleted calendar propagates back into this list AND into the
     *  calendar views behind the Settings overlay. */
    onCalendarsChanged: () -> Unit,
) {
    var tab by remember { mutableStateOf(SettingsTab.Account) }
    // Observe locale so the header + close button re-render on switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    // Full-screen Surface above MainScreen. Background is the standard
    // app surface (not a semi-transparent scrim) — desktop settings
    // are a "place you go," not a popover; full opacity helps focus.
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Header strip — title on the left, X close on the right.
            // Echoes the calendar TopBar height so the transition between
            // calendar and settings doesn't visually jitter.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    t("settings.title"),
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 18.sp,
                )
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onClose) {
                    Icon(Icons.Default.Close, contentDescription = t("settings.close"))
                }
            }
            HorizontalDivider()

            Row(modifier = Modifier.fillMaxSize()) {
                // Left rail — nav tabs.
                Column(
                    modifier = Modifier
                        .width(220.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f))
                        .verticalScroll(rememberScrollState())
                        .padding(vertical = 12.dp, horizontal = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    SettingsTab.values().forEach { t ->
                        NavRow(
                            tab = t,
                            active = tab == t,
                            onClick = { tab = t },
                        )
                    }
                }
                VerticalDivider()
                // Right pane — content for the selected tab.
                //
                // CRITICAL BUG FIX (v0.7.7): this was a Box, which
                // stacks children on top of each other (Compose's Box
                // is the same as FrameLayout/RelativeLayout). Every
                // SectionTitle / SectionCard / Spacer in the section
                // composables got placed at (0,0), making the title,
                // description, and buttons overlap — exactly the
                // "字全部挤在一起" the user reported on v0.7.6.
                // Column is the right container: stacks children
                // vertically, respects Spacers, supports verticalScroll.
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 32.dp, vertical = 24.dp),
                ) {
                    when (tab) {
                        SettingsTab.Account -> AccountSection(
                            profile = profile,
                            profiles = profiles,
                            onSwitchProfile = onSwitchProfile,
                            onRemoveProfile = onRemoveProfile,
                            onAddAccount = onAddAccount,
                            onSignOut = onSignOut,
                        )
                        SettingsTab.Calendars -> CalendarsSection(
                            calendars = calendars,
                            profile = profile,
                            onChanged = onCalendarsChanged,
                        )
                        SettingsTab.Booking -> BookingSection(
                            calendars = calendars,
                            profile = profile,
                        )
                        SettingsTab.Security -> SecuritySection(profile = profile)
                        SettingsTab.Appearance -> AppearanceSection(profile = profile)
                        SettingsTab.About -> AboutSection(
                            profile = profile,
                            onCheckUpdate = onCheckUpdate,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NavRow(tab: SettingsTab, active: Boolean, onClick: () -> Unit) {
    val bg = if (active) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f) else Color.Transparent
    val fg = if (active) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val label = remember(locale, tab) { cn.bywave.calendar.desktop.i18n.I18n.t(tab.labelKey) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(bg)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(tab.icon, contentDescription = null, modifier = Modifier.size(18.dp), tint = fg)
        Spacer(Modifier.width(10.dp))
        Text(label, color = fg, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
    }
}

// -------- Account --------

@Composable
private fun AccountSection(
    profile: Profile,
    profiles: List<Profile>,
    onSwitchProfile: (String) -> Unit,
    onRemoveProfile: (String) -> Unit,
    onAddAccount: () -> Unit,
    onSignOut: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    SectionTitle(t("settings.account.title"))

    SectionCard {
        InfoRow(t("settings.account.email"), profile.email)
        if (!profile.displayName.isNullOrEmpty()) InfoRow(t("settings.account.displayName"), profile.displayName)
        InfoRow(t("settings.account.server"), profile.serverUrl)
        InfoRow(t("settings.account.deviceId"), profile.deviceId, mono = true)
    }

    Spacer(Modifier.height(32.dp))
    SectionTitle(t("settings.profileMgmt.title"))
    Text(
        t("settings.profileMgmt.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )

    SectionCard {
        profiles.forEach { p ->
            val isActive = p.deviceId == profile.deviceId
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(
                            if (isActive) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outline.copy(alpha = 0.4f),
                        ),
                )
                Spacer(Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(p.email, fontWeight = FontWeight.Medium)
                    Text(
                        p.serverUrl,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (!isActive) {
                    TextButton(onClick = { onSwitchProfile(p.deviceId) }) { Text(t("settings.profileMgmt.switch")) }
                }
                TextButton(onClick = { onRemoveProfile(p.deviceId) }) {
                    Text(t("settings.profileMgmt.remove"), color = MaterialTheme.colorScheme.error)
                }
            }
            if (p != profiles.last()) HorizontalDivider()
        }
    }

    Spacer(Modifier.height(12.dp))
    OutlinedButton(onClick = onAddAccount) {
        Text(t("settings.profileMgmt.addServer"))
    }

    Spacer(Modifier.height(36.dp))
    SectionTitle(t("settings.signOut.title"), danger = true)
    Text(
        t("settings.signOut.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )
    Button(
        onClick = onSignOut,
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        ),
    ) {
        Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(t("settings.signOut.button"))
    }
}

// -------- Calendars --------
//
// v0.8: desktop went read/write. Previously this section just listed
// calendars + a "manage on the web" deep-link. Now it owns full CRUD —
// create / rename / recolor / change timezone / delete — by calling the
// CalendarCRUD endpoints on a short-lived ApiClient (same pattern the
// OpenInWebRow uses for its one-shot web-session call). After any
// mutation we fire `onChanged`, which re-runs the parent's events fetch;
// calendars ride along in that response (EventsResponse.calendars), so
// the reload is what surfaces the new/edited/deleted calendar both here
// and in the calendar views behind the Settings overlay.

/** Brand swatch palette — mirrors the web app's calendar colors so a
 *  calendar created on desktop matches one created on web. Plain preset
 *  swatches (no full color wheel) keeps the picker simple. */
private val CALENDAR_COLOR_PRESETS: List<String> = listOf(
    "#6366f1", // indigo
    "#059669", // emerald
    "#E11D48", // rose
    "#0284C7", // sky
    "#D97706", // amber
    "#7C3AED", // violet
    "#DC2626", // red
    "#64748b", // slate
)

@Composable
private fun CalendarsSection(
    calendars: List<CalendarMeta>,
    profile: Profile,
    onChanged: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    // At most one dialog up at a time. `null` = none, otherwise the kind
    // + (for edit/delete) the target calendar. Kept local to this section
    // — calendar CRUD is a self-contained flow that doesn't need to live
    // in CalendarState.
    var editing by remember { mutableStateOf<CalendarMeta?>(null) }   // edit dialog target
    var deleting by remember { mutableStateOf<CalendarMeta?>(null) }  // delete confirm target
    var creating by remember { mutableStateOf(false) }               // create dialog open
    var sharing by remember { mutableStateOf<CalendarMeta?>(null) }   // share-links dialog target

    SectionTitle(t("settings.calendars.title"))
    Text(
        t("settings.calendars.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )

    SectionCard {
        if (calendars.isEmpty()) {
            Text(
                t("settings.calendars.empty"),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        } else {
            calendars.forEach { cal ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(14.dp)
                            .clip(CircleShape)
                            .background(parseHex(cal.color)),
                    )
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(cal.name, fontWeight = FontWeight.Medium)
                        if (!cal.timezone.isNullOrEmpty()) {
                            Text(
                                cal.timezone,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    // Per-row Share + Edit + Delete affordances. Icon
                    // buttons keep the row compact; tooltips come from
                    // contentDescription.
                    IconButton(onClick = { sharing = cal }) {
                        Icon(
                            Icons.Default.Share,
                            contentDescription = t("settings.calendars.share"),
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = { editing = cal }) {
                        Icon(
                            Icons.Default.Edit,
                            contentDescription = t("settings.calendars.edit"),
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = { deleting = cal }) {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = t("settings.calendars.delete"),
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.error,
                        )
                    }
                }
                if (cal != calendars.last()) HorizontalDivider()
            }
        }
    }

    Spacer(Modifier.height(16.dp))
    Button(onClick = { creating = true }) {
        Text(t("settings.calendars.new"))
    }

    // ---- Dialogs ----

    if (creating) {
        CalendarEditDialog(
            profile = profile,
            existing = null,
            onDismiss = { creating = false },
            onSaved = {
                creating = false
                onChanged()
            },
        )
    }

    editing?.let { cal ->
        CalendarEditDialog(
            profile = profile,
            existing = cal,
            onDismiss = { editing = null },
            onSaved = {
                editing = null
                onChanged()
            },
        )
    }

    deleting?.let { cal ->
        CalendarDeleteDialog(
            profile = profile,
            calendar = cal,
            onDismiss = { deleting = null },
            onDeleted = {
                deleting = null
                onChanged()
            },
        )
    }

    sharing?.let { cal ->
        ShareLinksDialog(
            profile = profile,
            calendar = cal,
            onDismiss = { sharing = null },
        )
    }
}

/** Per-calendar share / subscribe-link manager. Mirrors the web
 *  calendar.ejs "分享" panel: list active subscribe links (each a public
 *  read-only .ics URL), generate a new one (optional label), copy the URL
 *  to the clipboard, and revoke (with a confirm step). All calls go through
 *  a short-lived ApiClient for the active profile — same one-shot pattern
 *  the calendar CRUD dialogs use. The list reloads after create / revoke
 *  (via reloadKey) so the UI always reflects server state. */
@Composable
private fun ShareLinksDialog(
    profile: Profile,
    calendar: CalendarMeta,
    onDismiss: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var tokens by remember { mutableStateOf<List<ShareToken>?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var newLabel by remember { mutableStateOf("") }
    var generating by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    // Token (id) the user just copied — drives a transient "已复制" hint.
    var copied by remember { mutableStateOf<String?>(null) }
    // Revoke confirm target. null = no confirm up.
    var revoking by remember { mutableStateOf<ShareToken?>(null) }
    // Bump to force a reload after create / revoke.
    var reloadKey by remember { mutableStateOf(0) }

    androidx.compose.runtime.LaunchedEffect(reloadKey) {
        loading = true
        loadError = null
        val api = ApiClient(profile.serverUrl)
        runCatching { api.listShareTokens(calendar.id) }
            .onSuccess {
                api.close()
                tokens = it
                loading = false
            }
            .onFailure {
                api.close()
                loadError = it.localizedMessage ?: t("settings.share.loadFailed")
                loading = false
            }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                cn.bywave.calendar.desktop.i18n.I18n.t(
                    "settings.share.title",
                    mapOf("name" to calendar.name),
                ),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        text = {
            Column(
                modifier = Modifier.width(480.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    t("settings.share.intro"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                // Generate-new row: optional label + button.
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = newLabel,
                        onValueChange = { newLabel = it },
                        label = { Text(t("settings.share.labelPlaceholder")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        onClick = {
                            generating = true
                            actionError = null
                            scope.launch {
                                val api = ApiClient(profile.serverUrl)
                                runCatching {
                                    api.createShareToken(
                                        calendarId = calendar.id,
                                        label = newLabel.trim().ifBlank { null },
                                    )
                                }.onSuccess {
                                    api.close()
                                    generating = false
                                    newLabel = ""
                                    reloadKey++  // re-list so the new link shows
                                }.onFailure {
                                    api.close()
                                    generating = false
                                    actionError = it.localizedMessage ?: t("settings.share.generateFailed")
                                }
                            }
                        },
                        enabled = !generating,
                    ) {
                        if (generating) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(t("settings.share.generate"))
                    }
                }

                if (actionError != null) {
                    Text(
                        actionError!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                HorizontalDivider()

                when {
                    loading -> {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(t("settings.share.loading"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    loadError != null -> {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(loadError!!, color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { reloadKey++ }) { Text(t("error.retry")) }
                        }
                    }
                    tokens.isNullOrEmpty() -> {
                        Text(
                            t("settings.share.empty"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 8.dp),
                        )
                    }
                    else -> {
                        val list = tokens!!
                        list.forEach { tok ->
                            Column(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Text(
                                    tok.label?.ifBlank { null } ?: t("settings.share.unnamed"),
                                    fontWeight = FontWeight.Medium,
                                )
                                Text(
                                    tok.url,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                                    maxLines = 2,
                                )
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(onClick = {
                                        copyToClipboard(tok.url)
                                        copied = tok.token
                                    }) {
                                        Text(
                                            if (copied == tok.token) t("settings.share.copied")
                                            else t("settings.share.copy"),
                                        )
                                    }
                                    TextButton(onClick = { revoking = tok }) {
                                        Text(
                                            t("settings.share.revoke"),
                                            color = MaterialTheme.colorScheme.error,
                                        )
                                    }
                                }
                            }
                            if (tok != list.last()) HorizontalDivider()
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(t("settings.share.close")) }
        },
    )

    // Revoke confirm — revoking invalidates the .ics URL for anyone still
    // subscribed, so we make the user confirm (mirrors web's data-confirm).
    revoking?.let { tok ->
        var working by remember { mutableStateOf(false) }
        var revokeError by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!working) revoking = null },
            title = {
                Text(
                    t("settings.share.revokeTitle"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.error,
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(t("settings.share.revokeConfirm"))
                    if (revokeError != null) {
                        Text(
                            revokeError!!,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        working = true
                        revokeError = null
                        scope.launch {
                            val api = ApiClient(profile.serverUrl)
                            runCatching {
                                api.revokeShareToken(calendar.id, tok.token)
                            }.onSuccess {
                                api.close()
                                working = false
                                revoking = null
                                reloadKey++  // re-list so the revoked link disappears
                            }.onFailure {
                                api.close()
                                working = false
                                revokeError = it.localizedMessage ?: t("settings.share.revokeFailed")
                            }
                        }
                    },
                    enabled = !working,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) {
                    if (working) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(t("settings.share.revoke"))
                }
            },
            dismissButton = {
                TextButton(onClick = { revoking = null }, enabled = !working) {
                    Text(t("settings.calendars.cancel"))
                }
            },
        )
    }
}

/** Put `text` on the system clipboard. Uses AWT's Toolkit clipboard
 *  directly — Compose Desktop's ClipboardManager works too, but Toolkit is
 *  available everywhere without threading a LocalClipboardManager through,
 *  and copy-a-URL doesn't need rich content. Best-effort: a headless /
 *  locked-down environment could throw, which we swallow (the URL is still
 *  shown on screen for manual copy). */
private fun copyToClipboard(text: String) {
    runCatching {
        java.awt.Toolkit.getDefaultToolkit().systemClipboard
            .setContents(java.awt.datatransfer.StringSelection(text), null)
    }
}

/** Create OR edit dialog — one composable, switched by `existing`.
 *  `existing == null` → create (POST); otherwise → edit (PATCH the
 *  changed fields). Owns its own form state + a short-lived ApiClient
 *  for the mutation, surfacing API errors inline (mirrors how
 *  EventEditDialog renders `errorMessage` in-body). */
@Composable
private fun CalendarEditDialog(
    profile: Profile,
    existing: CalendarMeta?,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    val isEdit = existing != null
    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    // Default new calendars to the first brand swatch; pre-select the
    // existing color on edit (parseHex tolerates any case / missing #).
    var color by remember { mutableStateOf(existing?.color ?: CALENDAR_COLOR_PRESETS.first()) }
    // Default new-calendar timezone to the system zone so the field is
    // never empty on create (the server otherwise infers one, but
    // showing the user's tz up front is clearer).
    var timezone by remember {
        mutableStateOf(existing?.timezone ?: java.time.ZoneId.systemDefault().id)
    }
    var description by remember { mutableStateOf(existing?.description.orEmpty()) }

    var saving by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    val canSubmit = name.isNotBlank() && !saving

    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = {
            Text(
                if (isEdit) t("settings.calendars.editTitle") else t("settings.calendars.createTitle"),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        text = {
            Column(
                modifier = Modifier.width(420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(t("settings.calendars.nameLabel") + " *") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                // Color picker — a wrapping row of preset swatches; the
                // selected one gets a ring. Reuses the circle-swatch motif
                // from EventEditDialog's CalendarPicker.
                Text(
                    t("settings.calendars.colorLabel"),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.outline,
                )
                ColorSwatchRow(selected = color, onSelect = { color = it })

                OutlinedTextField(
                    value = timezone,
                    onValueChange = { timezone = it },
                    label = { Text(t("settings.calendars.timezoneLabel")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text(t("settings.calendars.descLabel")) },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )

                if (errorMsg != null) {
                    Text(
                        errorMsg!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    saving = true
                    errorMsg = null
                    scope.launch {
                        // Short-lived ApiClient for the active profile —
                        // same one-shot pattern as OpenInWebRow. The
                        // bearer token comes from ProfileStore (active
                        // profile), so we don't thread one in here.
                        val api = ApiClient(profile.serverUrl)
                        val tz = timezone.trim().ifBlank { null }
                        val desc = description.trim().ifBlank { null }
                        runCatching {
                            if (isEdit) {
                                // PATCH: only send what could have changed.
                                api.updateCalendar(
                                    id = existing!!.id,
                                    body = CalendarUpdateInput(
                                        name = name.trim(),
                                        description = desc,
                                        color = color,
                                        timezone = tz,
                                    ),
                                )
                            } else {
                                api.createCalendar(
                                    body = CalendarCreateInput(
                                        name = name.trim(),
                                        description = desc,
                                        color = color,
                                        timezone = tz,
                                    ),
                                )
                            }
                        }.onSuccess {
                            api.close()
                            saving = false
                            onSaved()
                        }.onFailure {
                            api.close()
                            saving = false
                            errorMsg = it.localizedMessage ?: t("settings.calendars.saveFailed")
                        }
                    }
                },
                enabled = canSubmit,
            ) {
                if (saving) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(if (isEdit) t("settings.calendars.save") else t("settings.calendars.create"))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !saving) {
                Text(t("settings.calendars.cancel"))
            }
        },
    )
}

/** Confirm dialog for deleting a calendar. Deleting cascades to all of
 *  the calendar's events server-side, so the warning copy spells that
 *  out (with the calendar name interpolated) and the confirm button is
 *  styled as a destructive action. */
@Composable
private fun CalendarDeleteDialog(
    profile: Profile,
    calendar: CalendarMeta,
    onDismiss: () -> Unit,
    onDeleted: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var working by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!working) onDismiss() },
        title = {
            Text(
                t("settings.calendars.deleteTitle"),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.error,
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    cn.bywave.calendar.desktop.i18n.I18n.t(
                        "settings.calendars.deleteWarning",
                        mapOf("name" to calendar.name),
                    ),
                )
                if (errorMsg != null) {
                    Text(
                        errorMsg!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    working = true
                    errorMsg = null
                    scope.launch {
                        val api = ApiClient(profile.serverUrl)
                        runCatching {
                            api.deleteCalendar(calendar.id)
                        }.onSuccess {
                            api.close()
                            working = false
                            onDeleted()
                        }.onFailure {
                            api.close()
                            working = false
                            errorMsg = it.localizedMessage ?: t("settings.calendars.deleteFailed")
                        }
                    }
                },
                enabled = !working,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
            ) {
                if (working) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(t("settings.calendars.deleteConfirm"))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !working) {
                Text(t("settings.calendars.cancel"))
            }
        },
    )
}

/** Wrapping row of preset color swatches. The selected swatch gets a
 *  thicker outline ring so the current choice is obvious at a glance. */
@Composable
private fun ColorSwatchRow(selected: String, onSelect: (String) -> Unit) {
    // Normalize for comparison — server may echo back lower/upper case.
    val sel = selected.removePrefix("#").lowercase()
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CALENDAR_COLOR_PRESETS.forEach { hex ->
            val isSel = hex.removePrefix("#").lowercase() == sel
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(parseHex(hex))
                    .border(
                        width = if (isSel) 3.dp else 1.dp,
                        color = if (isSel) MaterialTheme.colorScheme.onSurface
                        else MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                        shape = CircleShape,
                    )
                    .clickable { onSelect(hex) },
            )
        }
    }
}

// -------- Booking links --------
//
// Native owner-management for "预约链接 / Booking links" — public
// scheduling pages where guests pick an open slot. Mirrors the web owner
// UI and the share-links panel above: list links (title / duration /
// enabled state / publicUrl + Copy), create new ones with a form, toggle
// enabled (pause / resume), and delete (with confirm). All calls go through
// a short-lived ApiClient for the active profile — the same one-shot
// pattern the calendar CRUD + share-links dialogs use. The list reloads
// after any mutation (via reloadKey) so the UI always reflects server
// state. weeklyAvailability is intentionally NOT exposed here for v1 — the
// server defaults it, matching the web owner UI.

@Composable
private fun BookingSection(
    calendars: List<CalendarMeta>,
    profile: Profile,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var links by remember { mutableStateOf<List<BookingLink>?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    // The id the user just copied — drives a transient "已复制" hint.
    var copied by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }            // create dialog open
    var deleting by remember { mutableStateOf<BookingLink?>(null) } // delete confirm target
    // Bump to force a reload after create / toggle / delete.
    var reloadKey by remember { mutableStateOf(0) }
    // Id currently being toggled — disables its switch while the PATCH flies.
    var toggling by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }

    androidx.compose.runtime.LaunchedEffect(reloadKey) {
        loading = true
        loadError = null
        val api = ApiClient(profile.serverUrl)
        runCatching { api.listBookingLinks() }
            .onSuccess {
                api.close()
                links = it
                loading = false
            }
            .onFailure {
                api.close()
                loadError = it.localizedMessage ?: t("booking.loadFailed")
                loading = false
            }
    }

    SectionTitle(t("booking.title"))
    Text(
        t("booking.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )

    SectionCard {
        when {
            loading -> {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(t("booking.loading"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            loadError != null -> {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(loadError!!, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { reloadKey++ }) { Text(t("error.retry")) }
                }
            }
            links.isNullOrEmpty() -> {
                Text(
                    t("booking.empty"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
            else -> {
                val list = links!!
                list.forEach { link ->
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(link.title, fontWeight = FontWeight.Medium)
                                Text(
                                    cn.bywave.calendar.desktop.i18n.I18n.t(
                                        "booking.durationValue",
                                        mapOf("n" to link.durationMinutes),
                                    ) + " · " +
                                        if (link.enabled) t("booking.enabled") else t("booking.paused"),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            // Enabled toggle (PATCH enabled). Disabled while
                            // its own PATCH is in flight.
                            Switch(
                                checked = link.enabled,
                                enabled = toggling != link.id,
                                onCheckedChange = { wantEnabled ->
                                    toggling = link.id
                                    actionError = null
                                    scope.launch {
                                        val api = ApiClient(profile.serverUrl)
                                        runCatching {
                                            api.setBookingLinkEnabled(link.id, wantEnabled)
                                        }.onSuccess {
                                            api.close()
                                            toggling = null
                                            reloadKey++  // re-list so state reflects server
                                        }.onFailure {
                                            api.close()
                                            toggling = null
                                            actionError = it.localizedMessage ?: t("booking.toggleFailed")
                                        }
                                    }
                                },
                            )
                            IconButton(onClick = { deleting = link }) {
                                Icon(
                                    Icons.Default.Delete,
                                    contentDescription = t("booking.delete"),
                                    modifier = Modifier.size(18.dp),
                                    tint = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                        Text(
                            link.publicUrl,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            maxLines = 2,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = {
                                copyToClipboard(link.publicUrl)
                                copied = link.id
                            }) {
                                Text(
                                    if (copied == link.id) t("booking.copied")
                                    else t("booking.copyLink"),
                                )
                            }
                            TextButton(onClick = {
                                runCatching {
                                    Desktop.getDesktop().browse(URI(link.publicUrl))
                                }
                            }) {
                                Text(t("booking.open"))
                            }
                        }
                    }
                    if (link != list.last()) HorizontalDivider()
                }
            }
        }
    }

    if (actionError != null) {
        Spacer(Modifier.height(8.dp))
        Text(
            actionError!!,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    }

    Spacer(Modifier.height(16.dp))
    // Can't create a booking link without a calendar to bind it to.
    Button(onClick = { creating = true }, enabled = calendars.isNotEmpty()) {
        Text(t("booking.new"))
    }
    if (calendars.isEmpty()) {
        Spacer(Modifier.height(8.dp))
        Text(
            t("booking.needCalendar"),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    // ---- Dialogs ----

    if (creating) {
        BookingCreateDialog(
            profile = profile,
            calendars = calendars,
            onDismiss = { creating = false },
            onCreated = {
                creating = false
                reloadKey++
            },
        )
    }

    deleting?.let { link ->
        BookingDeleteDialog(
            profile = profile,
            link = link,
            onDismiss = { deleting = null },
            onDeleted = {
                deleting = null
                reloadKey++
            },
        )
    }
}

/** Create-a-booking-link dialog. Owns its own form state + a short-lived
 *  ApiClient for the POST, surfacing API errors inline (mirrors
 *  CalendarEditDialog). weeklyAvailability is left to the server default —
 *  no availability editor here for v1. */
@Composable
private fun BookingCreateDialog(
    profile: Profile,
    calendars: List<CalendarMeta>,
    onDismiss: () -> Unit,
    onCreated: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var slug by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    // Default the calendar picker to the first calendar (the caller only
    // opens this dialog when calendars is non-empty).
    var calendarId by remember { mutableStateOf(calendars.first().id) }
    var duration by remember { mutableStateOf("30") }
    var minNotice by remember { mutableStateOf("4") }
    var maxDays by remember { mutableStateOf("30") }
    var bufferBefore by remember { mutableStateOf("0") }
    var bufferAfter by remember { mutableStateOf("0") }
    var notifyEmail by remember { mutableStateOf(true) }

    var saving by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    // Slug shape mirrors the server's ^[a-z0-9][a-z0-9-]{0,30}$ so we can
    // gate submit + show a hint before the round-trip.
    val slugRegex = remember { Regex("^[a-z0-9][a-z0-9-]{0,30}$") }
    val slugOk = slug.matches(slugRegex)
    val durationInt = duration.trim().toIntOrNull()
    val minNoticeInt = minNotice.trim().toIntOrNull()
    val maxDaysInt = maxDays.trim().toIntOrNull()
    val canSubmit = !saving && slugOk && title.isNotBlank() &&
        durationInt != null && durationInt > 0 &&
        minNoticeInt != null && minNoticeInt >= 0 &&
        maxDaysInt != null && maxDaysInt > 0

    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = {
            Text(
                t("booking.createTitle"),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        text = {
            Column(
                modifier = Modifier.width(440.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = slug,
                    onValueChange = { slug = it },
                    label = { Text(t("booking.slugLabel") + " *") },
                    singleLine = true,
                    isError = slug.isNotEmpty() && !slugOk,
                    supportingText = { Text(t("booking.slugHint")) },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text(t("booking.titleLabel") + " *") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text(t("booking.descLabel")) },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )

                // Calendar picker — reuse the calendars the app already
                // loaded. A simple vertical list of selectable rows keeps
                // it lightweight (no dropdown menu plumbing).
                Text(
                    t("booking.calendarLabel"),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.outline,
                )
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    calendars.forEach { cal ->
                        val selected = cal.id == calendarId
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { calendarId = cal.id }
                                .padding(vertical = 8.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (selected) MaterialTheme.colorScheme.primary
                                        else MaterialTheme.colorScheme.outline.copy(alpha = 0.4f),
                                    ),
                            )
                            Spacer(Modifier.width(10.dp))
                            Box(
                                modifier = Modifier
                                    .size(12.dp)
                                    .clip(CircleShape)
                                    .background(parseHex(cal.color)),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                cal.name,
                                fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
                            )
                        }
                    }
                }

                // Numeric fields. Kept as text fields with numeric parsing
                // (canSubmit gates bad input) rather than steppers — simpler
                // and matches the free-text style of the rest of the form.
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = duration,
                        onValueChange = { duration = it.filter { c -> c.isDigit() } },
                        label = { Text(t("booking.duration") + " *") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = minNotice,
                        onValueChange = { minNotice = it.filter { c -> c.isDigit() } },
                        label = { Text(t("booking.minNotice")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = maxDays,
                        onValueChange = { maxDays = it.filter { c -> c.isDigit() } },
                        label = { Text(t("booking.maxDays")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = bufferBefore,
                        onValueChange = { bufferBefore = it.filter { c -> c.isDigit() } },
                        label = { Text(t("booking.bufferBefore")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = bufferAfter,
                        onValueChange = { bufferAfter = it.filter { c -> c.isDigit() } },
                        label = { Text(t("booking.bufferAfter")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(t("booking.notifyEmail"), modifier = Modifier.weight(1f))
                    Switch(checked = notifyEmail, onCheckedChange = { notifyEmail = it })
                }

                if (errorMsg != null) {
                    Text(
                        errorMsg!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    saving = true
                    errorMsg = null
                    scope.launch {
                        val api = ApiClient(profile.serverUrl)
                        runCatching {
                            api.createBookingLink(
                                BookingLinkCreateInput(
                                    slug = slug.trim(),
                                    title = title.trim(),
                                    description = description.trim().ifBlank { null },
                                    calendarId = calendarId,
                                    durationMinutes = durationInt!!,
                                    minNoticeHours = minNoticeInt!!,
                                    maxDaysAhead = maxDaysInt!!,
                                    bufferBeforeMin = bufferBefore.trim().toIntOrNull(),
                                    bufferAfterMin = bufferAfter.trim().toIntOrNull(),
                                    notifyEmail = notifyEmail,
                                ),
                            )
                        }.onSuccess {
                            api.close()
                            saving = false
                            onCreated()
                        }.onFailure {
                            api.close()
                            saving = false
                            errorMsg = it.localizedMessage ?: t("booking.createFailed")
                        }
                    }
                },
                enabled = canSubmit,
            ) {
                if (saving) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(t("booking.create"))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !saving) {
                Text(t("booking.cancel"))
            }
        },
    )
}

/** Confirm dialog for deleting a booking link. Deleting removes the public
 *  scheduling page so the warning copy (with the link title interpolated)
 *  spells that out, and the confirm button is styled destructive — mirrors
 *  CalendarDeleteDialog / the share-link revoke confirm. */
@Composable
private fun BookingDeleteDialog(
    profile: Profile,
    link: BookingLink,
    onDismiss: () -> Unit,
    onDeleted: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var working by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!working) onDismiss() },
        title = {
            Text(
                t("booking.deleteTitle"),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.error,
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    cn.bywave.calendar.desktop.i18n.I18n.t(
                        "booking.deleteWarning",
                        mapOf("name" to link.title),
                    ),
                )
                if (errorMsg != null) {
                    Text(
                        errorMsg!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    working = true
                    errorMsg = null
                    scope.launch {
                        val api = ApiClient(profile.serverUrl)
                        runCatching {
                            api.deleteBookingLink(link.id)
                        }.onSuccess {
                            api.close()
                            working = false
                            onDeleted()
                        }.onFailure {
                            api.close()
                            working = false
                            errorMsg = it.localizedMessage ?: t("booking.deleteFailed")
                        }
                    }
                },
                enabled = !working,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
            ) {
                if (working) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(t("booking.deleteConfirm"))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !working) {
                Text(t("booking.cancel"))
            }
        },
    )
}

// -------- Security --------

@Composable
private fun SecuritySection(profile: Profile) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    // 修改密码 + 我的设备 are now native (own dialogs / inline list).
    // Passkey / MFA / 登录历史 / 删除账号 stay on the web — they need
    // richer native UI (WebAuthn ceremony, TOTP enrollment, irreversible
    // confirmation) than this client warrants yet.
    var changePassword by remember { mutableStateOf(false) }

    SectionTitle(t("settings.security.title"))
    Text(
        t("settings.security.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 16.dp),
    )

    SectionCard {
        // Native change-password — opens an in-app dialog instead of the web.
        ActionRow(
            title = t("settings.security.changePassword"),
            subtitle = t("settings.security.changePassword.sub"),
            onClick = { changePassword = true },
        )
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/settings#passkey", title = t("settings.security.passkey"), subtitle = t("settings.security.passkey.sub"))
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/settings#mfa", title = t("settings.security.mfa"), subtitle = t("settings.security.mfa.sub"))
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/logins", title = t("settings.security.loginHistory"), subtitle = t("settings.security.loginHistory.sub"))
    }

    // Native devices list — load on first render, refresh after revoke.
    Spacer(Modifier.height(32.dp))
    DevicesSection(profile = profile)

    Spacer(Modifier.height(32.dp))
    SectionTitle(t("settings.security.danger"), danger = true)
    SectionCard(danger = true) {
        OpenInWebRow(profile = profile, next = "/app/settings#danger", title = t("settings.security.deleteAccount"), subtitle = t("settings.security.deleteAccount.sub"), danger = true)
    }

    if (changePassword) {
        ChangePasswordDialog(
            profile = profile,
            onDismiss = { changePassword = false },
        )
    }
}

/** Native change-password dialog. Two fields (current + new) plus a
 *  confirm field so a typo in the new password doesn't lock the user out.
 *  Client-side validation mirrors the server's policy (new ≥ 8 chars,
 *  new != current); server errors (wrong current password, weak password)
 *  surface inline. On success we note that OTHER sessions were signed out
 *  (the server invalidates them) — this desktop keeps working. */
@Composable
private fun ChangePasswordDialog(profile: Profile, onDismiss: () -> Unit) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }

    var working by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    // After a successful change we swap the form for a success note (which
    // also mentions other sessions being signed out) + a single Close.
    var done by remember { mutableStateOf(false) }

    val canSubmit = !working && !done &&
        current.isNotBlank() && next.length >= 8 && confirm.isNotBlank()

    AlertDialog(
        onDismissRequest = { if (!working) onDismiss() },
        title = {
            Text(
                t("settings.security.changePassword.title"),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        text = {
            if (done) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(t("settings.security.changePassword.success"))
                    Text(
                        t("settings.security.changePassword.otherSessions"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Column(
                    modifier = Modifier.width(380.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    OutlinedTextField(
                        value = current,
                        onValueChange = { current = it },
                        label = { Text(t("settings.security.changePassword.current")) },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = next,
                        onValueChange = { next = it },
                        label = { Text(t("settings.security.changePassword.new")) },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = confirm,
                        onValueChange = { confirm = it },
                        label = { Text(t("settings.security.changePassword.confirm")) },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        t("settings.security.changePassword.hint"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (errorMsg != null) {
                        Text(
                            errorMsg!!,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        },
        confirmButton = {
            if (done) {
                TextButton(onClick = onDismiss) { Text(t("settings.security.changePassword.close")) }
            } else {
                Button(
                    onClick = {
                        // Local validation first — avoids a round-trip for
                        // the common "new password typo" case. (Length is
                        // already gated by `canSubmit`.)
                        if (next != confirm) {
                            errorMsg = t("settings.security.changePassword.mismatch")
                        } else {
                            working = true
                            errorMsg = null
                            scope.launch {
                                val api = ApiClient(profile.serverUrl)
                                runCatching {
                                    api.changePassword(currentPassword = current, newPassword = next)
                                }.onSuccess {
                                    api.close()
                                    working = false
                                    done = true
                                }.onFailure {
                                    api.close()
                                    working = false
                                    errorMsg = it.localizedMessage ?: t("settings.security.changePassword.failed")
                                }
                            }
                        }
                    },
                    enabled = canSubmit,
                ) {
                    if (working) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(t("settings.security.changePassword.submit"))
                }
            }
        },
        dismissButton = {
            if (!done) {
                TextButton(onClick = onDismiss, enabled = !working) {
                    Text(t("settings.security.changePassword.cancel"))
                }
            }
        },
    )
}

/** Native "我的设备" list. Loads the paired devices on first render
 *  (and after each revoke). Each row shows label / kind / last-seen plus
 *  a Revoke button — except the row for THIS desktop's own device, which
 *  we don't let the user revoke from here (that would log the current
 *  session out on the next token refresh). The active device is matched
 *  by `profile.deviceId`. */
@Composable
private fun DevicesSection(profile: Profile) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    var devices by remember { mutableStateOf<List<cn.bywave.calendar.desktop.data.model.DeviceDTO>?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var revoking by remember { mutableStateOf<cn.bywave.calendar.desktop.data.model.DeviceDTO?>(null) }
    // Bump to force a reload (after a successful revoke).
    var reloadKey by remember { mutableStateOf(0) }

    androidx.compose.runtime.LaunchedEffect(reloadKey) {
        loading = true
        loadError = null
        val api = ApiClient(profile.serverUrl)
        runCatching { api.listDevices() }
            .onSuccess {
                api.close()
                devices = it.devices
                loading = false
            }
            .onFailure {
                api.close()
                loadError = it.localizedMessage ?: t("settings.devices.loadFailed")
                loading = false
            }
    }

    SectionTitle(t("settings.devices.title"))
    Text(
        t("settings.devices.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )

    SectionCard {
        when {
            loading -> {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(t("settings.devices.loading"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            loadError != null -> {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(loadError!!, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { reloadKey++ }) { Text(t("error.retry")) }
                }
            }
            devices.isNullOrEmpty() -> {
                Text(
                    t("settings.devices.empty"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
            else -> {
                val list = devices!!
                list.forEach { device ->
                    val isCurrent = device.id == profile.deviceId
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(device.label, fontWeight = FontWeight.Medium)
                                if (isCurrent) {
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        t("settings.devices.thisDevice"),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                            val meta = buildString {
                                append(device.kind)
                                val seen = device.lastSeenAt ?: device.createdAt
                                append(" · ")
                                append(
                                    cn.bywave.calendar.desktop.i18n.I18n.t(
                                        "settings.devices.lastSeen",
                                        mapOf("when" to formatTimestamp(seen)),
                                    ),
                                )
                            }
                            Text(
                                meta,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        // Don't let the user revoke the device they're using —
                        // it'd boot this very session on the next refresh.
                        if (!isCurrent) {
                            TextButton(onClick = { revoking = device }) {
                                Text(t("settings.devices.revoke"), color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                    if (device != list.last()) HorizontalDivider()
                }
            }
        }
    }

    revoking?.let { device ->
        RevokeDeviceDialog(
            profile = profile,
            device = device,
            onDismiss = { revoking = null },
            onRevoked = {
                revoking = null
                reloadKey++  // re-fetch the list so the revoked row disappears
            },
        )
    }
}

/** Confirm dialog for revoking a single device. Revoking signs that
 *  device out on its next token refresh — irreversible from the device's
 *  side (it must re-pair), so we make the user confirm. */
@Composable
private fun RevokeDeviceDialog(
    profile: Profile,
    device: cn.bywave.calendar.desktop.data.model.DeviceDTO,
    onDismiss: () -> Unit,
    onRevoked: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var working by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!working) onDismiss() },
        title = {
            Text(
                t("settings.devices.revokeTitle"),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.error,
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    cn.bywave.calendar.desktop.i18n.I18n.t(
                        "settings.devices.revokeConfirm",
                        mapOf("label" to device.label),
                    ),
                )
                if (errorMsg != null) {
                    Text(
                        errorMsg!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    working = true
                    errorMsg = null
                    scope.launch {
                        val api = ApiClient(profile.serverUrl)
                        runCatching {
                            api.revokeDevice(device.id)
                        }.onSuccess {
                            api.close()
                            working = false
                            onRevoked()
                        }.onFailure {
                            api.close()
                            working = false
                            errorMsg = it.localizedMessage ?: t("settings.devices.revokeFailed")
                        }
                    }
                },
                enabled = !working,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
            ) {
                if (working) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(t("settings.devices.revoke"))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !working) {
                Text(t("settings.calendars.cancel"))
            }
        },
    )
}

/** Best-effort pretty-print of an ISO8601 server timestamp into the
 *  user's local zone. Falls back to the raw string if parsing fails (the
 *  server could change format) — better than crashing the row. */
private fun formatTimestamp(iso: String): String {
    return runCatching {
        val instant = java.time.Instant.parse(iso)
        val local = instant.atZone(java.time.ZoneId.systemDefault())
        java.time.format.DateTimeFormatter
            .ofPattern("yyyy-MM-dd HH:mm")
            .format(local)
    }.getOrDefault(iso)
}

/** Plain action row that runs a native handler (no web hop). Mirrors
 *  OpenInWebRow's layout but with a chevron-free trailing affordance —
 *  it stays inside the app, so it doesn't get the "↗ leaves the app" icon. */
@Composable
private fun ActionRow(title: String, subtitle: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// -------- Appearance --------

@Composable
private fun AppearanceSection(profile: Profile) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    // -- Language picker (per-install; persisted to ~/.bywave-calendar/locale)
    SectionTitle(t("settings.language.title"))
    Text(
        t("settings.language.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )
    SectionCard {
        cn.bywave.calendar.desktop.i18n.I18n.all.forEach { loc ->
            val active = loc == locale
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { cn.bywave.calendar.desktop.i18n.I18n.setLocale(loc) }
                    .padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(
                            if (active) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outline.copy(alpha = 0.4f),
                        ),
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    loc.label,
                    fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
                    modifier = Modifier.weight(1f),
                )
            }
            if (loc != cn.bywave.calendar.desktop.i18n.I18n.all.last()) HorizontalDivider()
        }
    }

    Spacer(Modifier.height(36.dp))

    // -- Event reminders (desktop notifications; per-install) --
    val remindersOn by cn.bywave.calendar.desktop.data.notify.ReminderPrefs.enabled.collectAsState()
    val leadMinutes by cn.bywave.calendar.desktop.data.notify.ReminderPrefs.leadMinutes.collectAsState()
    SectionTitle(t("settings.reminders.title"))
    Text(
        t("settings.reminders.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )
    SectionCard {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(t("settings.reminders.enable"), modifier = Modifier.weight(1f))
            Switch(
                checked = remindersOn,
                onCheckedChange = { cn.bywave.calendar.desktop.data.notify.ReminderPrefs.setEnabled(it) },
            )
        }
        // Lead-time chips — only meaningful while reminders are on.
        if (remindersOn) {
            HorizontalDivider()
            Text(
                t("settings.reminders.lead"),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp, bottom = 8.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                cn.bywave.calendar.desktop.data.notify.ReminderPrefs.leadOptions.forEach { m ->
                    val selected = m == leadMinutes
                    val label = if (m == 0) t("settings.reminders.atStart")
                                else cn.bywave.calendar.desktop.i18n.I18n.t(
                                    "settings.reminders.leadMinutes", mapOf("n" to m))
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(
                                if (selected) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.surfaceVariant,
                            )
                            .clickable { cn.bywave.calendar.desktop.data.notify.ReminderPrefs.setLeadMinutes(m) }
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text(
                            label,
                            style = MaterialTheme.typography.labelMedium,
                            color = if (selected) MaterialTheme.colorScheme.onPrimary
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    Spacer(Modifier.height(36.dp))

    // -- Theme / palette (web deep-link)
    SectionTitle(t("settings.appearance.title"))
    Text(
        t("settings.appearance.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 16.dp),
    )
    OpenInWebButton(profile = profile, next = "/app/settings#theme", label = t("settings.appearance.openOnWeb"))
}

// -------- About --------

@Composable
private fun AboutSection(profile: Profile, onCheckUpdate: () -> Unit) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    SectionTitle(t("settings.about.title"))
    SectionCard {
        InfoRow(t("settings.about.app"), "ByWave Calendar Desktop")
        InfoRow(t("settings.about.version"), "v${BuildInfo.VERSION_NAME} (build ${BuildInfo.VERSION_CODE})")
        InfoRow(t("settings.about.server"), profile.serverUrl)
        InfoRow(t("settings.about.license"), "MIT")
        InfoRow(t("settings.about.copyright"), "© 2026 ByWave")
    }

    Spacer(Modifier.height(16.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = onCheckUpdate) {
            Text(t("settings.about.checkUpdate"))
        }
        OutlinedButton(onClick = {
            runCatching {
                Desktop.getDesktop().browse(URI("https://github.com/wuha-like-sleep/by-wave-calendar"))
            }
        }) {
            Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(t("settings.about.github"))
        }
    }

    Spacer(Modifier.height(24.dp))
    Text(
        t("settings.about.tagline"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

// ---- Shared widgets ----
//
// v0.7.6 spacing pass — user feedback was「字全部挤在一起了」. The
// previous values (8dp section gap, 8dp card vertical padding, 96dp
// label column) felt cramped against the surrounding Surface. Targets:
//   - section title → body description: 12dp
//   - section title → card: 14dp
//   - inside cards: 14dp vertical padding; 12dp per InfoRow
//   - between major rows: 16dp via Spacer where applicable

@Composable
private fun SectionTitle(text: String, danger: Boolean = false) {
    // v0.7.6: bumped fontSize 17→18 and lineHeight 24→26 and bottom
    // padding 12→16 — user feedback was that Settings text looked
    // cramped, especially with Chinese characters where the default
    // tight Compose lineHeight cuts decorations close to ascenders.
    Text(
        text,
        fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp,
        lineHeight = 26.sp,
        color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.padding(bottom = 16.dp),
    )
}

@Composable
private fun SectionCard(danger: Boolean = false, content: @Composable () -> Unit) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (danger)
            MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.15f)
        else
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        modifier = Modifier.fillMaxWidth(),
    ) {
        // v0.7.6: bumped padding horizontal 18→20, vertical 14→18 so
        // rows inside the card don't hug the edges. Combined with the
        // bumped InfoRow vertical-10→14 below this gives breathing room
        // between adjacent rows without an explicit Divider every time.
        Column(modifier = Modifier.padding(horizontal = 20.dp, vertical = 18.dp)) {
            content()
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String, mono: Boolean = false) {
    // v0.7.6: vertical padding 10→14, label width 110→120 (Chinese
    // 「显示名」barely fit before).
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(120.dp),
        )
        Text(
            value,
            modifier = Modifier.weight(1f),
            // Wider lineHeight so wrapped URLs don't pile on top of
            // each other.
            lineHeight = 22.sp,
            fontFamily = if (mono) androidx.compose.ui.text.font.FontFamily.Monospace else null,
        )
    }
}

/** Action row that opens a web page deep-linked into the user's session
 *  via /api/v1/auth/web-session. Subtle "↗" icon + chevron to signal
 *  "this leaves the app." */
@Composable
private fun OpenInWebRow(
    profile: Profile,
    next: String,
    title: String,
    subtitle: String,
    danger: Boolean = false,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()
    var working by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !working) {
                working = true
                scope.launch {
                    runCatching {
                        val api = ApiClient(profile.serverUrl)
                        val resp = api.webSession(next)
                        Desktop.getDesktop().browse(URI(resp.url))
                        api.close()
                    }.onFailure {
                        errorMsg = it.localizedMessage ?: t("openInWeb.openFailed")
                    }
                    working = false
                }
            }
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                title,
                fontWeight = FontWeight.Medium,
                color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            )
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (working) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        } else {
            Icon(
                Icons.AutoMirrored.Filled.OpenInNew,
                contentDescription = t("openInWeb.openInBrowser"),
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    errorMsg?.let { msg ->
        AlertDialog(
            onDismissRequest = { errorMsg = null },
            title = { Text(t("openInWeb.openFailed.title")) },
            text = { Text(msg) },
            confirmButton = { TextButton(onClick = { errorMsg = null }) { Text(t("openInWeb.ok")) } },
        )
    }
}

/** Button variant of OpenInWebRow — same one-shot token flow, but a
 *  Button widget for "primary" deep-links (Appearance / Calendars
 *  "在网页管理"). */
@Composable
private fun OpenInWebButton(profile: Profile, next: String, label: String) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()
    var working by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    Button(
        onClick = {
            working = true
            scope.launch {
                runCatching {
                    val api = ApiClient(profile.serverUrl)
                    val resp = api.webSession(next)
                    Desktop.getDesktop().browse(URI(resp.url))
                    api.close()
                }.onFailure {
                    errorMsg = it.localizedMessage ?: t("openInWeb.openFailed")
                }
                working = false
            }
        },
        enabled = !working,
    ) {
        if (working) {
            CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        } else {
            Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(label)
    }
    errorMsg?.let { msg ->
        AlertDialog(
            onDismissRequest = { errorMsg = null },
            title = { Text(t("openInWeb.openFailed.title")) },
            text = { Text(msg) },
            confirmButton = { TextButton(onClick = { errorMsg = null }) { Text(t("openInWeb.ok")) } },
        )
    }
}
