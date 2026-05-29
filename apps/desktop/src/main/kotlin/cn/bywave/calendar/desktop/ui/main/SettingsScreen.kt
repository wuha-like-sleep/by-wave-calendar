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
import androidx.compose.material.icons.filled.Security
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.bywave.calendar.desktop.BuildInfo
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.model.CalendarCreateInput
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.CalendarUpdateInput
import cn.bywave.calendar.desktop.data.model.Profile
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
                    "设置",
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 18.sp,
                )
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onClose) {
                    Icon(Icons.Default.Close, contentDescription = "关闭设置")
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
    SectionTitle("账户")

    SectionCard {
        InfoRow("邮箱", profile.email)
        if (!profile.displayName.isNullOrEmpty()) InfoRow("显示名", profile.displayName)
        InfoRow("服务器", profile.serverUrl)
        InfoRow("设备 ID", profile.deviceId, mono = true)
    }

    Spacer(Modifier.height(32.dp))
    SectionTitle("账号管理")
    Text(
        "切换 / 添加 / 移除 ByWave 服务器。每个账号是独立的服务器+用户组合。",
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
                    TextButton(onClick = { onSwitchProfile(p.deviceId) }) { Text("切换") }
                }
                TextButton(onClick = { onRemoveProfile(p.deviceId) }) {
                    Text("移除", color = MaterialTheme.colorScheme.error)
                }
            }
            if (p != profiles.last()) HorizontalDivider()
        }
    }

    Spacer(Modifier.height(12.dp))
    OutlinedButton(onClick = onAddAccount) {
        Text("+ 添加服务器")
    }

    Spacer(Modifier.height(36.dp))
    SectionTitle("退出当前账号", danger = true)
    Text(
        "退出会保留本地缓存的事件数据。重新登录同一账号可以接着用。",
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
        Text("退出当前账号")
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
                    // Per-row Edit + Delete affordances. Icon buttons keep
                    // the row compact; tooltips come from contentDescription.
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
                            errorMsg = it.localizedMessage ?: "操作失败"
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
                            errorMsg = it.localizedMessage ?: "删除失败"
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

// -------- Security --------

@Composable
private fun SecuritySection(profile: Profile) {
    SectionTitle("安全")
    Text(
        "敏感操作（改密码 / Passkey / MFA / 删除账号）走网页 —— 桌面 APP 通过一次性令牌把你直接送进已登录的网页。",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 16.dp),
    )

    SectionCard {
        OpenInWebRow(profile = profile, next = "/app/settings#password", title = "修改密码", subtitle = "需要当前密码")
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/settings#passkey", title = "Passkey 管理", subtitle = "添加 / 重命名 / 撤销")
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/settings#mfa", title = "二次验证 (TOTP)", subtitle = "MFA / 备用码")
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/settings#devices", title = "我的设备", subtitle = "查看 / 撤销其它登录")
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/logins", title = "登录历史", subtitle = "最近 100 条登录记录")
    }

    Spacer(Modifier.height(32.dp))
    SectionTitle("危险操作", danger = true)
    SectionCard(danger = true) {
        OpenInWebRow(profile = profile, next = "/app/settings#danger", title = "删除账号", subtitle = "永久删除，请谨慎", danger = true)
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
    SectionTitle("关于")
    SectionCard {
        InfoRow("应用", "ByWave Calendar Desktop")
        InfoRow("版本", "v${BuildInfo.VERSION_NAME} (build ${BuildInfo.VERSION_CODE})")
        InfoRow("服务器", profile.serverUrl)
        InfoRow("许可证", "MIT")
        InfoRow("版权", "© 2026 ByWave")
    }

    Spacer(Modifier.height(16.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = onCheckUpdate) {
            Text("检查更新")
        }
        OutlinedButton(onClick = {
            runCatching {
                Desktop.getDesktop().browse(URI("https://github.com/wuha-like-sleep/by-wave-calendar"))
            }
        }) {
            Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text("GitHub")
        }
    }

    Spacer(Modifier.height(24.dp))
    Text(
        "ByWave Calendar 是一个开源的自托管日历共享平台。" +
            "桌面端用 Compose Multiplatform 构建 —— Mac / Win / Linux 同一份 Kotlin 源码。",
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
                        errorMsg = it.localizedMessage ?: "打开网页失败"
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
                contentDescription = "在浏览器打开",
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    errorMsg?.let { msg ->
        AlertDialog(
            onDismissRequest = { errorMsg = null },
            title = { Text("打开失败") },
            text = { Text(msg) },
            confirmButton = { TextButton(onClick = { errorMsg = null }) { Text("好的") } },
        )
    }
}

/** Button variant of OpenInWebRow — same one-shot token flow, but a
 *  Button widget for "primary" deep-links (Appearance / Calendars
 *  "在网页管理"). */
@Composable
private fun OpenInWebButton(profile: Profile, next: String, label: String) {
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
                    errorMsg = it.localizedMessage ?: "打开网页失败"
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
            title = { Text("打开失败") },
            text = { Text(msg) },
            confirmButton = { TextButton(onClick = { errorMsg = null }) { Text("好的") } },
        )
    }
}
