// Native desktop settings. Browser-only security operations use authenticated deep links.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.VerticalScrollbar
import androidx.compose.foundation.rememberScrollbarAdapter
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.RssFeed
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
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.bywave.calendar.desktop.BuildInfo
import cn.bywave.calendar.desktop.ui.theme.Dimens
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.model.Booking
import cn.bywave.calendar.desktop.data.model.BookingLink
import cn.bywave.calendar.desktop.data.model.BookingLinkCreateInput
import cn.bywave.calendar.desktop.data.model.BookingLinkUpdateInput
import cn.bywave.calendar.desktop.data.model.CalendarCreateInput
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.CalendarSubscription
import cn.bywave.calendar.desktop.data.model.CalendarUpdateInput
import cn.bywave.calendar.desktop.data.model.Profile
import cn.bywave.calendar.desktop.data.model.ShareToken
import cn.bywave.calendar.desktop.data.update.UpdateChecker
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import cn.bywave.calendar.desktop.util.userFacingError
import kotlinx.coroutines.launch
import java.awt.Desktop
import java.net.URI

/** Which left-rail tab is active. Order here = order in the nav rail.
 *  Labels are I18n keys, resolved at render time so switching language
 *  in the Appearance section instantly updates the tab labels. */
private enum class SettingsTab(val labelKey: String, val icon: ImageVector) {
    Account("settings.tabAccount", Icons.Default.AccountCircle),
    Calendars("settings.tabCalendars", Icons.Default.CalendarMonth),
    SystemCalendar("settings.tabSystemCalendar", Icons.Default.CalendarMonth),
    Booking("settings.tabBooking", Icons.Default.Link),
    Security("settings.tabSecurity", Icons.Default.Security),
    Devices("settings.devices.title", Icons.Default.Devices),
    Reminders("settings.reminders.title", Icons.Default.Notifications),
    Language("settings.language.title", Icons.Default.Language),
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
    /** When non-null, Settings opens directly on the Calendars tab with
     *  that calendar's edit dialog already open — the sidebar's
     *  per-calendar edit button uses this so "edit this calendar" is
     *  one click from the main window instead of gear → tab → row →
     *  pencil (the path the web app's sidebar calendar menu gives in
     *  one step). Null → the usual Account tab landing. */
    initialCalendarsEditId: String? = null,
    /** When true, Settings opens on the Calendars tab with the create
     *  dialog already open — the sidebar's "new calendar" entry uses
     *  this so creating a calendar is one click from the main window
     *  instead of gear → tab → button. */
    initialCalendarsCreate: Boolean = false,
) {
    var tab by remember {
        mutableStateOf(
            if (initialCalendarsEditId != null || initialCalendarsCreate) SettingsTab.Calendars else SettingsTab.Account,
        )
    }
    val contentScroll = remember(tab, profile.deviceId) { ScrollState(0) }
    val navScroll = rememberScrollState()
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
                    .height(72.dp)
                    .padding(horizontal = 24.dp),
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
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .35f))

            Row(modifier = Modifier.fillMaxSize()) {
                // Left rail — nav tabs.
                Column(
                    modifier = Modifier
                        .width(236.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.background)
                        .verticalScroll(navScroll)
                        .padding(vertical = 24.dp, horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    cn.bywave.calendar.desktop.ui.theme.BrandMark(42.dp)
                    Spacer(Modifier.height(24.dp))
                    SettingsTab.values().forEach { t ->
                        NavRow(
                            tab = t,
                            active = tab == t,
                            onClick = { tab = t },
                        )
                    }
                }
                VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .35f))
                // Keep each section at the top when navigating, with a visible scrollbar.
                Box(
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    Column(
                        modifier = Modifier
                            .verticalScroll(contentScroll)
                            .widthIn(max = 840.dp)
                            .fillMaxWidth()
                            .padding(horizontal = 40.dp, vertical = 32.dp),
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
                                initialEditId = initialCalendarsEditId,
                                initialCreate = initialCalendarsCreate,
                            )
                            SettingsTab.Booking -> BookingSection(
                                calendars = calendars,
                                profile = profile,
                            )
                            SettingsTab.SystemCalendar -> SystemCalendarSection(profile)
                            SettingsTab.Security -> SecuritySection(profile = profile)
                            SettingsTab.Devices -> DevicesSection(profile = profile)
                            SettingsTab.Reminders -> RemindersSection()
                            SettingsTab.Language -> LanguageSection()
                            SettingsTab.Appearance -> AppearanceSection(profile = profile)
                            SettingsTab.About -> AboutSection(
                                profile = profile,
                                onCheckUpdate = onCheckUpdate,
                            )
                        }
                    }
                    VerticalScrollbar(
                        adapter = rememberScrollbarAdapter(contentScroll),
                        modifier = Modifier.align(Alignment.CenterEnd).fillMaxHeight().padding(vertical = 12.dp, horizontal = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun NavRow(tab: SettingsTab, active: Boolean, onClick: () -> Unit) {
    val bg by androidx.compose.animation.animateColorAsState(if (active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent, androidx.compose.animation.core.tween(140), label = "settings-selection")
    val fg = if (active) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val label = remember(locale, tab) { cn.bywave.calendar.desktop.i18n.I18n.t(tab.labelKey) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(bg)
            .pointerHoverIcon(PointerIcon.Hand)
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

    // 「移除账号」和「退出登录」在这台机器上都是不可撤销的:凭据被删掉,
    // 想回来得拿手机重新扫码配对。而它们以前都是点一下立刻生效,和旁边
    // 那个无害的「切换」按钮只差几十像素。日历删除、预约链接删除早就有
    // 二次确认了,这两个才是最容易误点的。
    var removeTarget by remember { mutableStateOf<Profile?>(null) }
    var confirmSignOut by remember { mutableStateOf(false) }

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
                    Text(p.email, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        p.serverUrl,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (!isActive) {
                    TextButton(onClick = { onSwitchProfile(p.deviceId) }) { Text(t("settings.profileMgmt.switch")) }
                }
                TextButton(onClick = { removeTarget = p }) {
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
        onClick = { confirmSignOut = true },
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        ),
    ) {
        Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(t("settings.signOut.button"))
    }

    removeTarget?.let { target ->
        DangerConfirmDialog(
            title = t("settings.profileMgmt.removeTitle"),
            body = cn.bywave.calendar.desktop.i18n.I18n.t(
                "settings.profileMgmt.removeWarning",
                mapOf("email" to target.email),
            ),
            confirmLabel = t("settings.profileMgmt.removeConfirm"),
            onConfirm = {
                removeTarget = null
                onRemoveProfile(target.deviceId)
            },
            onDismiss = { removeTarget = null },
        )
    }

    if (confirmSignOut) {
        DangerConfirmDialog(
            title = t("settings.signOut.confirmTitle"),
            body = t("settings.signOut.confirmWarning"),
            confirmLabel = t("settings.signOut.button"),
            onConfirm = {
                confirmSignOut = false
                onSignOut()
            },
            onDismiss = { confirmSignOut = false },
        )
    }
}

/** 破坏性操作的二次确认。和日历删除 / 预约链接删除那两个对话框长一样,
 *  区别只是文案由调用方给 —— 这里不需要各自再写一遍按钮样式。 */
@Composable
private fun DangerConfirmDialog(
    title: String,
    body: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val cancel = remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("common.cancel") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, fontWeight = FontWeight.SemiBold) },
        text = {
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.widthIn(max = 420.dp),
            )
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
            ) { Text(confirmLabel) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(cancel) }
        },
    )
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

/** Preset swatch palette — the same 17 colors, in the same order, as
 *  the web app's COLOR_PALETTE (calendar-app.js) so a calendar offered
 *  on one platform can be picked identically on every other. (This list
 *  used to be a divergent 8-color subset despite this comment claiming
 *  parity; Android / iOS carried two further, different sets.) Plain
 *  preset swatches (no full color wheel) keeps the picker simple. */
private val CALENDAR_COLOR_PRESETS: List<String> = listOf(
    "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
    "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
    "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
    "#ec4899", "#64748b",
)

/** New-calendar default color — the web create dialog's default
 *  (#6366f1 indigo), NOT the first palette entry (which is red). */
private const val DEFAULT_CALENDAR_COLOR = "#6366f1"

@Composable
private fun CalendarsSection(
    calendars: List<CalendarMeta>,
    profile: Profile,
    onChanged: () -> Unit,
    initialEditId: String? = null,
    initialCreate: Boolean = false,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    // At most one dialog up at a time. `null` = none, otherwise the kind
    // + (for edit/delete) the target calendar. Kept local to this section
    // — calendar CRUD is a self-contained flow that doesn't need to live
    // in CalendarState.
    var editing by remember { mutableStateOf<CalendarMeta?>(null) }   // edit dialog target
    var deleting by remember { mutableStateOf<CalendarMeta?>(null) }  // delete confirm target
    // Seeded from initialCreate so the sidebar's "new calendar" entry
    // lands with the create dialog already up (mirrors initialEditId).
    var creating by remember { mutableStateOf(initialCreate) }        // create dialog open
    var sharing by remember { mutableStateOf<CalendarMeta?>(null) }   // share-links dialog target
    var subscribing by remember { mutableStateOf<CalendarMeta?>(null) } // subscriptions dialog target
    // One-shot .ics export state (per section, not per calendar: only
    // one export runs at a time and the notice names the file written).
    var exporting by remember { mutableStateOf(false) }
    var exportNotice by remember { mutableStateOf<String?>(null) }
    var exportError by remember { mutableStateOf<String?>(null) }

    // 拉一次导出文本 → 原生保存对话框 → 写文件。文件名优先用服务端
    // Content-Disposition 给的（它按日历名清洗过），拿不到才本地按同一
    // 规则清洗。用户在保存对话框里取消 = 什么都不发生，不算失败。
    fun runExport(cal: CalendarMeta) {
        if (exporting) return
        exporting = true
        exportNotice = null
        exportError = null
        scope.launch {
            val api = ApiClient(profile)
            runCatching { api.exportCalendarIcs(cal.id) }
                .onSuccess { result ->
                    api.close()
                    val target = pickIcsSaveFile(result.fileName ?: icsExportFileName(cal.name))
                    if (target != null) {
                        val written = runCatching {
                            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                target.writeText(result.text, Charsets.UTF_8)
                            }
                        }
                        if (written.isSuccess) {
                            exportNotice = cn.bywave.calendar.desktop.i18n.I18n.t(
                                "settings.export.done",
                                mapOf("name" to target.name),
                            )
                        } else {
                            exportError = t("settings.export.failed")
                        }
                    }
                    exporting = false
                }
                .onFailure {
                    api.close()
                    exporting = false
                    exportError = userFacingError(it, "settings.export.failed")
                }
        }
    }

    // Deep-link from the sidebar's per-calendar edit button: open the
    // requested calendar's edit dialog once, as soon as the list
    // contains it. Consumed-flag so later list reloads (e.g. after an
    // unrelated save) don't resurrect the dialog.
    var initialEditConsumed by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(initialEditId, calendars) {
        if (!initialEditConsumed && initialEditId != null) {
            calendars.firstOrNull { it.id == initialEditId }?.let {
                editing = it
                initialEditConsumed = true
            }
        }
    }

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
                        Text(cal.name, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (!cal.timezone.isNullOrEmpty()) {
                            Text(
                                cal.timezone,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    // Per-row Share + Subscriptions + Export + Edit +
                    // Delete affordances. Icon buttons keep the row
                    // compact; tooltips come from contentDescription.
                    IconButton(onClick = { sharing = cal }) {
                        Icon(
                            Icons.Default.Share,
                            contentDescription = t("settings.calendars.share"),
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = { subscribing = cal }) {
                        Icon(
                            Icons.Default.RssFeed,
                            contentDescription = t("settings.subscriptions.button"),
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = { runExport(cal) }, enabled = !exporting) {
                        Icon(
                            Icons.Default.Download,
                            contentDescription = t("settings.export.button"),
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

    if (exporting || exportNotice != null || exportError != null) {
        Spacer(Modifier.height(12.dp))
        when {
            exporting -> Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    t("settings.export.working"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            exportError != null -> Text(
                exportError!!,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            else -> Text(
                exportNotice!!,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
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

    subscribing?.let { cal ->
        SubscriptionsDialog(
            profile = profile,
            calendar = cal,
            onDismiss = { subscribing = null },
            onChanged = onChanged,
        )
    }
}

/** 默认导出文件名：和服务端导出同规则清洗（非字母数字/中文/连字符的
 *  连续片段换一个下划线，最长 50 字符），再加 .ics。服务端给了
 *  Content-Disposition 文件名时优先用服务端的，这只是兜底。 */
internal fun icsExportFileName(calendarName: String): String {
    val safe = calendarName.replace(Regex("[^a-zA-Z0-9\u4e00-\u9fff-]+"), "_").take(50)
    return (safe.ifEmpty { "calendar" }) + ".ics"
}

/** Native save-file dialog for the .ics export — the SAVE twin of
 *  ImportIcsDialog's pickIcsFile (same AWT FileDialog reasoning: the
 *  native picker on macOS and Windows, modal by construction).
 *  Returns null when the user cancels. */
internal fun pickIcsSaveFile(defaultName: String): java.io.File? {
    val dialog = java.awt.FileDialog(
        null as java.awt.Frame?,
        cn.bywave.calendar.desktop.i18n.I18n.t("settings.export.title"),
        java.awt.FileDialog.SAVE,
    )
    dialog.file = defaultName
    dialog.isVisible = true
    val dir = dialog.directory ?: return null
    val name = dialog.file ?: return null
    return java.io.File(dir, name)
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
        val api = ApiClient(profile)
        runCatching { api.listShareTokens(calendar.id) }
            .onSuccess {
                api.close()
                tokens = it
                loading = false
            }
            .onFailure {
                api.close()
                loadError = userFacingError(it, "settings.share.loadFailed")
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
                                val api = ApiClient(profile)
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
                                    actionError = userFacingError(it, "settings.share.generateFailed")
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
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    tok.url,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
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
                            val api = ApiClient(profile)
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
                                revokeError = userFacingError(it, "settings.share.revokeFailed")
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

/** Per-calendar ICS subscription manager — the inbound twin of
 *  ShareLinksDialog: ShareLinks publishes this calendar OUT as a .ics
 *  link, subscriptions pull external .ics feeds IN. Lists each feed
 *  (label / URL, status, event count, last sync), adds new ones (URL +
 *  optional label), refreshes on demand, and deletes with a confirm.
 *  Same one-shot ApiClient pattern as the share-links dialog; the list
 *  reloads after every mutation (reloadKey). A create whose first fetch
 *  failed is still a successful create — the subscription was saved —
 *  so that outcome gets its own notice instead of the error slot. */
@Composable
private fun SubscriptionsDialog(
    profile: Profile,
    calendar: CalendarMeta,
    onDismiss: () -> Unit,
    onChanged: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val displayZone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()
    val scope = rememberCoroutineScope()

    var subs by remember { mutableStateOf<List<CalendarSubscription>?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var newUrl by remember { mutableStateOf("") }
    var newLabel by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    // Outcome line for add / refresh. Warning = saved-but-first-sync-
    // failed (amber role played by the error color at body size).
    var notice by remember { mutableStateOf<String?>(null) }
    var noticeWarning by remember { mutableStateOf(false) }
    // Subscription id currently being refreshed (per-row spinner).
    var refreshingId by remember { mutableStateOf<String?>(null) }
    // Delete confirm target. null = no confirm up.
    var deleting by remember { mutableStateOf<CalendarSubscription?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    androidx.compose.runtime.LaunchedEffect(reloadKey) {
        loading = true
        loadError = null
        val api = ApiClient(profile)
        runCatching { api.listSubscriptions(calendar.id) }
            .onSuccess {
                api.close()
                subs = it
                loading = false
            }
            .onFailure {
                api.close()
                loadError = userFacingError(it, "settings.subscriptions.loadFailed")
                loading = false
            }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                cn.bywave.calendar.desktop.i18n.I18n.t(
                    "settings.subscriptions.title",
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
                    t("settings.subscriptions.intro"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                // Add-new form: feed URL + optional label.
                OutlinedTextField(
                    value = newUrl,
                    onValueChange = { newUrl = it },
                    label = { Text(t("settings.subscriptions.urlPlaceholder")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = newLabel,
                        onValueChange = { newLabel = it },
                        label = { Text(t("settings.subscriptions.labelPlaceholder")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        onClick = {
                            adding = true
                            actionError = null
                            notice = null
                            scope.launch {
                                val api = ApiClient(profile)
                                runCatching {
                                    api.createSubscription(
                                        calendarId = calendar.id,
                                        url = newUrl.trim(),
                                        label = newLabel.trim().ifBlank { null },
                                    )
                                }.onSuccess { resp ->
                                    api.close()
                                    adding = false
                                    newUrl = ""
                                    newLabel = ""
                                    if (resp.refresh.ok) {
                                        notice = cn.bywave.calendar.desktop.i18n.I18n.t(
                                            "settings.subscriptions.savedSynced",
                                            mapOf(
                                                "inserted" to (resp.refresh.inserted ?: 0),
                                                "updated" to (resp.refresh.updated ?: 0),
                                                "skipped" to (resp.refresh.skipped ?: 0),
                                            ),
                                        )
                                        noticeWarning = false
                                    } else {
                                        // 已保存、首次同步失败 —— 不是创建失败，
                                        // 别让用户再建一条一模一样的订阅。
                                        notice = cn.bywave.calendar.desktop.i18n.I18n.t(
                                            "settings.subscriptions.savedSyncFailed",
                                            mapOf("error" to (resp.refresh.error ?: "")),
                                        )
                                        noticeWarning = true
                                    }
                                    reloadKey++
                                    onChanged()
                                }.onFailure {
                                    api.close()
                                    adding = false
                                    actionError = userFacingError(it, "settings.subscriptions.addFailed")
                                }
                            }
                        },
                        enabled = !adding && newUrl.isNotBlank(),
                    ) {
                        if (adding) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(t("settings.subscriptions.add"))
                    }
                }

                if (notice != null) {
                    Text(
                        notice!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (noticeWarning) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
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
                            Text(t("settings.subscriptions.loading"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    loadError != null -> {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(loadError!!, color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { reloadKey++ }) { Text(t("error.retry")) }
                        }
                    }
                    subs.isNullOrEmpty() -> {
                        Text(
                            t("settings.subscriptions.empty"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 8.dp),
                        )
                    }
                    else -> {
                        val list = subs!!
                        list.forEach { sub ->
                            Column(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Text(
                                    sub.label?.ifBlank { null } ?: sub.url,
                                    fontWeight = FontWeight.Medium,
                                )
                                if (!sub.label.isNullOrBlank()) {
                                    Text(
                                        sub.url,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                                        maxLines = 2,
                                    )
                                }
                                when {
                                    !sub.lastError.isNullOrBlank() -> Text(
                                        cn.bywave.calendar.desktop.i18n.I18n.t(
                                            "settings.subscriptions.statusError",
                                            mapOf("error" to sub.lastError!!),
                                        ),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                    sub.lastFetchedAt != null -> Text(
                                        cn.bywave.calendar.desktop.i18n.I18n.t(
                                            "settings.subscriptions.statusOk",
                                            mapOf(
                                                "count" to (sub.lastEventCount ?: 0),
                                                "when" to formatTimestamp(sub.lastFetchedAt!!, displayZone),
                                            ),
                                        ),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    else -> Text(
                                        t("settings.subscriptions.statusNever"),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(
                                        onClick = {
                                            refreshingId = sub.id
                                            actionError = null
                                            notice = null
                                            scope.launch {
                                                val api = ApiClient(profile)
                                                runCatching {
                                                    api.refreshSubscription(calendar.id, sub.id)
                                                }.onSuccess { r ->
                                                    api.close()
                                                    refreshingId = null
                                                    notice = cn.bywave.calendar.desktop.i18n.I18n.t(
                                                        "settings.subscriptions.refreshed",
                                                        mapOf(
                                                            "inserted" to r.inserted,
                                                            "updated" to r.updated,
                                                            "skipped" to r.skipped,
                                                        ),
                                                    )
                                                    noticeWarning = false
                                                    reloadKey++
                                                    onChanged()
                                                }.onFailure {
                                                    api.close()
                                                    refreshingId = null
                                                    actionError = userFacingError(it, "settings.subscriptions.refreshFailed")
                                                }
                                            }
                                        },
                                        enabled = refreshingId == null,
                                    ) {
                                        if (refreshingId == sub.id) {
                                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                                            Spacer(Modifier.width(8.dp))
                                        }
                                        Text(t("settings.subscriptions.refresh"))
                                    }
                                    TextButton(onClick = { deleting = sub }) {
                                        Text(
                                            t("settings.subscriptions.delete"),
                                            color = MaterialTheme.colorScheme.error,
                                        )
                                    }
                                }
                            }
                            if (sub != list.last()) HorizontalDivider()
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(t("settings.subscriptions.close")) }
        },
    )

    // Delete confirm — removing the feed detaches future syncs (events
    // already imported stay), so the copy says exactly that.
    deleting?.let { sub ->
        var working by remember { mutableStateOf(false) }
        var deleteError by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!working) deleting = null },
            title = {
                Text(
                    t("settings.subscriptions.deleteTitle"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.error,
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(t("settings.subscriptions.deleteConfirm"))
                    if (deleteError != null) {
                        Text(
                            deleteError!!,
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
                        deleteError = null
                        scope.launch {
                            val api = ApiClient(profile)
                            runCatching {
                                api.deleteSubscription(calendar.id, sub.id)
                            }.onSuccess {
                                api.close()
                                working = false
                                deleting = null
                                reloadKey++
                            }.onFailure {
                                api.close()
                                working = false
                                deleteError = userFacingError(it, "settings.subscriptions.deleteFailed")
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
                    Text(t("settings.subscriptions.delete"))
                }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }, enabled = !working) {
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
    // Default new calendars to the shared default swatch; pre-select the
    // existing color on edit (parseHex tolerates any case / missing #).
    var color by remember { mutableStateOf(existing?.color ?: DEFAULT_CALENDAR_COLOR) }
    // Default new-calendar timezone to the system zone so the field is
    // never empty on create (the server otherwise infers one, but
    // showing the user's tz up front is clearer).
    val displayZone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()
    // The device zone is an initial suggestion, not an instruction to replace
    // the selected calendar zone or an in-progress draft when the OS changes.
    var timezone by rememberCalendarTimezoneDraft(existing?.timezone, displayZone)
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
                        // Short-lived ApiClient bound to this profile —
                        // same one-shot pattern as OpenInWebRow. The
                        // bearer token comes from ProfileStore keyed by
                        // this profile's deviceId, so we don't thread one in.
                        val api = ApiClient(profile)
                        val tz = timezone.trim().ifBlank { null }
                        val desc = description.trim().ifBlank { null }
                        runCatching {
                            if (isEdit) {
                                // PATCH 口径与 Android / 服务端对齐：只发与原值
                                // 不同的字段。description 尤其不能走 desc——
                                // 清空时 desc 是 null，而本端 JSON 配置
                                // explicitNulls=false 会把 null 字段整个省掉，
                                // 服务端收到「没这个字段」= 不改，旧描述永远
                                // 清不掉。改后：清空时照发空串，服务端存为空。
                                api.updateCalendar(
                                    id = existing!!.id,
                                    body = CalendarUpdateInput(
                                        name = name.trim().takeIf { it != existing.name },
                                        description = description.takeIf { it != existing.description.orEmpty() },
                                        color = color.takeIf { it != existing.color },
                                        // 时区没有「清空」的概念：空值仍旧不发。
                                        timezone = tz?.takeIf { it != existing.timezone },
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
                            errorMsg = userFacingError(it, "settings.calendars.saveFailed")
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
                        val api = ApiClient(profile)
                        runCatching {
                            api.deleteCalendar(calendar.id)
                        }.onSuccess {
                            api.close()
                            working = false
                            onDeleted()
                        }.onFailure {
                            api.close()
                            working = false
                            errorMsg = userFacingError(it, "settings.calendars.deleteFailed")
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

/** Preset color swatches in rows of nine (17 presets = two rows, which
 *  fits the 420dp dialog; a single Row overflowed once the palette grew
 *  to the shared 17). The selected swatch gets a thicker outline ring
 *  so the current choice is obvious at a glance. */
@Composable
private fun ColorSwatchRow(selected: String, onSelect: (String) -> Unit) {
    // Normalize for comparison — server may echo back lower/upper case.
    val sel = selected.removePrefix("#").lowercase()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        CALENDAR_COLOR_PRESETS.chunked(9).forEach { rowColors ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                rowColors.forEach { hex ->
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
// state. The create/edit dialog also edits weeklyAvailability (per-weekday
// windows, the server's matrix) and each row opens a bookings viewer
// (list / detail / owner-side cancel) — both used to be web-only.

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
    // 刚创建好的那条 — 列表上方渲染一条带「复制链接」的横幅，直到
    // 用户关掉或又建了新的一条。
    var justCreated by remember { mutableStateOf<BookingLink?>(null) }
    var editing by remember { mutableStateOf<BookingLink?>(null) }  // edit dialog target
    var deleting by remember { mutableStateOf<BookingLink?>(null) } // delete confirm target
    var viewingBookings by remember { mutableStateOf<BookingLink?>(null) } // bookings viewer target
    // Bump to force a reload after create / toggle / delete.
    var reloadKey by remember { mutableStateOf(0) }
    // Id currently being toggled — disables its switch while the PATCH flies.
    var toggling by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }

    androidx.compose.runtime.LaunchedEffect(reloadKey) {
        loading = true
        loadError = null
        val api = ApiClient(profile)
        runCatching { api.listBookingLinks() }
            .onSuccess {
                api.close()
                links = it
                loading = false
            }
            .onFailure {
                api.close()
                loadError = userFacingError(it, "booking.loadFailed")
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

    // 创建成功的第一时间把链接摆出来给复制动作，不让用户回列表里找那一行。
    justCreated?.let { created ->
        val url = created.publicUrl ?: created.slug
        var bannerCopied by remember(created.id) { mutableStateOf(false) }
        Surface(
            shape = RoundedCornerShape(10.dp),
            color = MaterialTheme.colorScheme.primaryContainer,
            modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        t("booking.createdBanner", mapOf("name" to created.title)),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        url,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.width(10.dp))
                OutlinedButton(onClick = {
                    copyToClipboard(url)
                    bannerCopied = true
                }) {
                    Text(if (bannerCopied) t("booking.copied") else t("booking.copyLink"))
                }
                TextButton(onClick = { justCreated = null }) {
                    Text(t("common.close"))
                }
            }
        }
    }

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
                                Text(link.title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                                        val api = ApiClient(profile)
                                        runCatching {
                                            api.setBookingLinkEnabled(link.id, wantEnabled)
                                        }.onSuccess {
                                            api.close()
                                            toggling = null
                                            reloadKey++  // re-list so state reflects server
                                        }.onFailure {
                                            api.close()
                                            toggling = null
                                            actionError = userFacingError(it, "booking.toggleFailed")
                                        }
                                    }
                                },
                            )
                            IconButton(onClick = { editing = link }) {
                                Icon(
                                    Icons.Default.Edit,
                                    contentDescription = t("booking.edit"),
                                    modifier = Modifier.size(18.dp),
                                )
                            }
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
                            cn.bywave.calendar.desktop.i18n.I18n.t("booking.scheduleTimezone", mapOf("zone" to
                                cn.bywave.calendar.event.bookingTimeZone(link.timezone, calendars.firstOrNull { it.id == link.calendarId }?.timezone))),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
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
                            TextButton(onClick = { viewingBookings = link }) {
                                Text(t("booking.viewBookings"))
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
            onCreated = { created ->
                creating = false
                justCreated = created
                reloadKey++
            },
        )
    }

    editing?.let { link ->
        BookingCreateDialog(
            profile = profile,
            calendars = calendars,
            existing = link,
            onDismiss = { editing = null },
            onCreated = {
                editing = null
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

    viewingBookings?.let { link ->
        BookingsDialog(
            profile = profile,
            link = link,
            onDismiss = { viewingBookings = null },
        )
    }
}

/** Create-or-edit booking-link dialog. Owns its own form state + a
 *  short-lived ApiClient for the POST/PATCH, surfacing API errors inline
 *  (mirrors CalendarEditDialog). With `existing` set the form is seeded
 *  from that link and saving PATCHes it — the update endpoint existed
 *  from the start; this dialog is what finally wires it up.
 *  weeklyAvailability is edited inline (AvailabilityEditor below) and
 *  seeded from the link's real matrix, so saving an unrelated field
 *  never resets custom hours back to the server default. */
@Composable
private fun BookingCreateDialog(
    profile: Profile,
    calendars: List<CalendarMeta>,
    existing: BookingLink? = null,
    onDismiss: () -> Unit,
    /** 创建成功时带回新建的那条（父区据此渲染带「复制链接」的横幅）；
     *  编辑成功时传 null。 */
    onCreated: (created: BookingLink?) -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var slug by remember { mutableStateOf(existing?.slug ?: "") }
    var title by remember { mutableStateOf(existing?.title ?: "") }
    var description by remember { mutableStateOf(existing?.description ?: "") }
    // Default the calendar picker to the first calendar (the caller only
    // opens this dialog when calendars is non-empty); editing keeps the
    // link's own calendar.
    var calendarId by remember { mutableStateOf(existing?.calendarId ?: calendars.first().id) }
    var duration by remember { mutableStateOf(existing?.durationMinutes?.toString() ?: "30") }
    var minNotice by remember { mutableStateOf(existing?.minNoticeHours?.toString() ?: "4") }
    var maxDays by remember { mutableStateOf(existing?.maxDaysAhead?.toString() ?: "30") }
    var bufferBefore by remember { mutableStateOf(existing?.bufferBeforeMin?.toString() ?: "0") }
    var bufferAfter by remember { mutableStateOf(existing?.bufferAfterMin?.toString() ?: "0") }
    var notifyEmail by remember { mutableStateOf(existing?.notifyEmail ?: true) }
    // Per-weekday windows (dow 0=Sun..6=Sat → [start, end] text pairs).
    // Absent key = not bookable that day. Seeded from the link's stored
    // matrix; a fresh create starts from the server's default matrix.
    var availability by remember { mutableStateOf(seedAvailability(existing?.weeklyAvailability)) }

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
        maxDaysInt != null && maxDaysInt > 0 &&
        availabilityValid(availability)

    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = {
            Text(
                if (existing != null) t("booking.editTitle") else t("booking.createTitle"),
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

                Text(
                    cn.bywave.calendar.desktop.i18n.I18n.t("booking.scheduleTimezone", mapOf("zone" to
                        cn.bywave.calendar.event.bookingTimeZone(null, calendars.firstOrNull { it.id == calendarId }?.timezone))),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

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

                AvailabilityEditor(
                    availability = availability,
                    onChange = { availability = it },
                    t = t,
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
                        val api = ApiClient(profile)
                        runCatching {
                            if (existing != null) {
                                api.updateBookingLink(
                                    existing.id,
                                    BookingLinkUpdateInput(
                                        slug = slug.trim(),
                                        title = title.trim(),
                                        // 与原值不同才发：清空时照发空串。
                                        // 以前 ifBlank{null} + explicitNulls=false
                                        // 会把清空吞掉，旧描述清不掉（与日历
                                        // 描述同一个坑）；服务端 PATCH 收 ""。
                                        description = description.trim().takeIf { it != (existing.description ?: "") },
                                        calendarId = calendarId,
                                        durationMinutes = durationInt!!,
                                        minNoticeHours = minNoticeInt!!,
                                        maxDaysAhead = maxDaysInt!!,
                                        bufferBeforeMin = bufferBefore.trim().toIntOrNull(),
                                        bufferAfterMin = bufferAfter.trim().toIntOrNull(),
                                        notifyEmail = notifyEmail,
                                        weeklyAvailability = availabilityWire(availability),
                                    ),
                                )
                            } else {
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
                                        weeklyAvailability = availabilityWire(availability),
                                    ),
                                )
                            }
                        }.onSuccess { saved ->
                            api.close()
                            saving = false
                            // runCatching 的值就是 API 返回的那条：新建时
                            // 带回去给父区弹复制横幅，编辑时传 null。
                            onCreated(if (existing == null) saved else null)
                        }.onFailure {
                            api.close()
                            saving = false
                            errorMsg = userFacingError(it, if (existing != null) "booking.saveFailed" else "booking.createFailed")
                        }
                    }
                },
                enabled = canSubmit,
            ) {
                if (saving) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(if (existing != null) t("booking.save") else t("booking.create"))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !saving) {
                Text(t("booking.cancel"))
            }
        },
    )
}

// ---- Weekly availability (shared by the booking-link create/edit dialog) ----
//
// The wire matrix is Record<dow, [start, end][] | null> with dow keys
// "0".."6" (0 = Sunday) and "HH:MM" wall-clock pairs in the link's
// scheduling zone. The editor state keeps only bookable days:
// dow -> list of (start, end) text pairs; an absent day is "off".

private val HHMM_REGEX = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

/** The server's DEFAULT_AVAILABILITY (src/lib/booking.ts): Mon–Fri 09:00–18:00. */
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

/** Per-weekday availability editor: a switch per day (Monday-first, like
 *  the rest of the app) plus editable HH:MM windows. Lives inside the
 *  booking-link create/edit dialog; purely local state — the dialog
 *  serializes on save. */
@Composable
private fun AvailabilityEditor(
    availability: Map<Int, List<Pair<String, String>>>,
    onChange: (Map<Int, List<Pair<String, String>>>) -> Unit,
    t: (String) -> String,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            t("booking.availability"),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        Text(
            t("booking.availabilityHint"),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // Monday-first rows; weekday.short.1..7 are Mon..Sun.
        listOf(1, 2, 3, 4, 5, 6, 0).forEach { dow ->
            val windows = availability[dow]
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    t("weekday.short.${if (dow == 0) 7 else dow}"),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.width(30.dp),
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
                    Text(
                        "—",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            windows?.forEachIndexed { idx, window ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(start = 38.dp),
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
                        modifier = Modifier.width(96.dp),
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
                        modifier = Modifier.width(96.dp),
                    )
                    IconButton(onClick = {
                        val next = windows.toMutableList()
                        next.removeAt(idx)
                        onChange(if (next.isEmpty()) availability - dow else availability + (dow to next))
                    }) {
                        Icon(
                            Icons.Default.Close,
                            contentDescription = t("common.close"),
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
            if (windows != null) {
                TextButton(
                    onClick = {
                        val lastEnd = windows.lastOrNull()?.second ?: "09:00"
                        onChange(availability + (dow to (windows + (lastEnd to lastEnd))))
                    },
                    modifier = Modifier.padding(start = 30.dp),
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(t("booking.availabilityAdd"))
                }
            }
        }
        if (!availabilityValid(availability)) {
            Text(
                t("booking.availabilityInvalid"),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

// ---- Bookings viewer (per-link records: list / detail / owner cancel) ----

private fun bookingStatusKey(booking: Booking): String = when {
    booking.cancelledAt != null -> "booking.statusCancelled"
    runCatching { java.time.Instant.parse(booking.endsAt) }.getOrNull()
        ?.isBefore(java.time.Instant.now()) == true -> "booking.statusPast"
    else -> "booking.statusConfirmed"
}

/** Read-mostly viewer for the bookings made on one link. The default
 *  filter is the server's "upcoming & active" view; "All" also pulls
 *  past + cancelled rows. Tapping a row opens its detail in place, where
 *  an active booking can be cancelled (owner-side endpoint; the guest
 *  gets the standard cancellation mail). */
@Composable
private fun BookingsDialog(
    profile: Profile,
    link: BookingLink,
    onDismiss: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()
    val displayZone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()

    var showAll by remember { mutableStateOf(false) }
    var bookings by remember { mutableStateOf<List<Booking>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<Booking?>(null) }
    var confirmingCancel by remember { mutableStateOf(false) }
    var cancelling by remember { mutableStateOf(false) }
    var cancelError by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    androidx.compose.runtime.LaunchedEffect(showAll, reloadKey) {
        bookings = null
        loadError = null
        val api = ApiClient(profile)
        runCatching { api.listBookings(link.id, showAll) }
            .onSuccess {
                api.close()
                bookings = it
            }
            .onFailure {
                api.close()
                loadError = userFacingError(it, "booking.bookingsLoadFailed")
            }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                cn.bywave.calendar.desktop.i18n.I18n.t("booking.bookingsTitle", mapOf("name" to link.title)),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        text = {
            Column(
                modifier = Modifier.width(480.dp).heightIn(max = 520.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                val current = selected
                if (current == null) {
                    // Filter: upcoming & active (server default) vs all.
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (showAll) {
                            OutlinedButton(onClick = { showAll = false }) { Text(t("booking.bookingsUpcoming")) }
                            Button(onClick = {}) { Text(t("booking.bookingsAll")) }
                        } else {
                            Button(onClick = {}) { Text(t("booking.bookingsUpcoming")) }
                            OutlinedButton(onClick = { showAll = true }) { Text(t("booking.bookingsAll")) }
                        }
                    }
                    if (notice != null) {
                        Text(notice!!, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                    when {
                        loadError != null -> Text(loadError!!, color = MaterialTheme.colorScheme.error)
                        bookings == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(t("booking.loading"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        bookings!!.isEmpty() -> Text(
                            t("booking.bookingsEmpty"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        else -> bookings!!.forEach { booking ->
                            Column(
                                modifier = Modifier.fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                                    .clickable { selected = booking; confirmingCancel = false; cancelError = null }
                                    .padding(vertical = 6.dp, horizontal = 4.dp),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(booking.guestName, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(
                                        t(bookingStatusKey(booking)),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = if (booking.cancelledAt != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Text(
                                    booking.guestEmail,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    formatTimestamp(booking.startsAt, displayZone) + " – " + formatTimestamp(booking.endsAt, displayZone),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            HorizontalDivider()
                        }
                    }
                } else if (!confirmingCancel) {
                    // Detail view for one booking.
                    Text(
                        t("booking.guestLabel") + ": " + current.guestName,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        current.guestEmail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        formatTimestamp(current.startsAt, displayZone) + " – " + formatTimestamp(current.endsAt, displayZone),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        t(bookingStatusKey(current)),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (current.cancelledAt != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (!current.guestMessage.isNullOrBlank()) {
                        Text(
                            t("booking.messageLabel") + ": " + current.guestMessage,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (cancelError != null) {
                        Text(cancelError!!, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { selected = null }) { Text(t("common.back")) }
                        Spacer(Modifier.weight(1f))
                        if (current.cancelledAt == null) {
                            Button(
                                onClick = { confirmingCancel = true },
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                            ) { Text(t("booking.cancelBooking")) }
                        }
                    }
                } else {
                    // Cancel confirmation (same dialog, swapped content).
                    Text(
                        t("booking.cancelBookingTitle"),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Text(
                        cn.bywave.calendar.desktop.i18n.I18n.t(
                            "booking.cancelBookingWarning",
                            mapOf(
                                "guest" to current.guestName,
                                "when" to formatTimestamp(current.startsAt, displayZone),
                            ),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (cancelError != null) {
                        Text(cancelError!!, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { confirmingCancel = false }, enabled = !cancelling) {
                            Text(t("booking.cancel"))
                        }
                        Spacer(Modifier.weight(1f))
                        Button(
                            onClick = {
                                cancelling = true
                                cancelError = null
                                scope.launch {
                                    val api = ApiClient(profile)
                                    runCatching { api.cancelBooking(link.id, current.id) }
                                        .onSuccess {
                                            api.close()
                                            cancelling = false
                                            confirmingCancel = false
                                            selected = null
                                            notice = t("booking.bookingCancelled")
                                            reloadKey++
                                        }
                                        .onFailure {
                                            api.close()
                                            cancelling = false
                                            cancelError = userFacingError(it, "booking.cancelBookingFailed")
                                        }
                                }
                            },
                            enabled = !cancelling,
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                        ) {
                            if (cancelling) {
                                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(8.dp))
                            }
                            Text(t("booking.cancelBooking"))
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(t("common.close")) }
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
                        val api = ApiClient(profile)
                        runCatching {
                            api.deleteBookingLink(link.id)
                        }.onSuccess {
                            api.close()
                            working = false
                            onDeleted()
                        }.onFailure {
                            api.close()
                            working = false
                            errorMsg = userFacingError(it, "booking.deleteFailed")
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
private fun SystemCalendarSection(profile: Profile) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val displayZone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()
    val client = remember(profile.deviceId, profile.serverUrl) { ApiClient(profile) }
    val api = remember(client) { client.calendarConnectionApi() }
    androidx.compose.runtime.DisposableEffect(client) { onDispose { client.close() } }
    cn.bywave.calendar.connect.CalendarConnectionPanel(
        api = api, locale = locale.code,
        apple = System.getProperty("os.name").orEmpty().lowercase().contains("mac"),
        deviceLabel = "ByWave · " + System.getProperty("os.name"),
        openUrl = { java.awt.Desktop.getDesktop().browse(java.net.URI(it)) },
        copy = ::copyToClipboard,
        installProfile = { xml ->
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val file = java.nio.file.Files.createTempFile("ByWave-Calendar-", ".mobileconfig")
                java.nio.file.Files.writeString(file, xml)
                file.toFile().deleteOnExit()
                java.awt.Desktop.getDesktop().open(file.toFile())
            }
        },
        active = androidx.compose.ui.platform.LocalWindowInfo.current.isWindowFocused,
        displayTimeZone = displayZone,
        errorMessage = { e ->
            if (e is cn.bywave.calendar.desktop.data.api.ApiException && e.status == 404)
                cn.bywave.calendar.connect.CalendarCopy.text(locale.code, "serverUpdate")
            else cn.bywave.calendar.desktop.util.userFacingError(e, cn.bywave.calendar.connect.CalendarCopy.text(locale.code, "error.unavailable"))
        },
    )
}

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
        OpenInWebRow(profile = profile, next = "/app/settings/security#passkey", title = t("settings.security.passkey"), subtitle = t("settings.security.passkey.sub"))
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/settings/security#mfa", title = t("settings.security.mfa"), subtitle = t("settings.security.mfa.sub"))
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/settings/devices#api-tokens", title = t("settings.security.apiTokens"), subtitle = t("settings.security.apiTokens.sub"))
        HorizontalDivider()
        OpenInWebRow(profile = profile, next = "/app/logins", title = t("settings.security.loginHistory"), subtitle = t("settings.security.loginHistory.sub"))
    }

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
                    // Scrollable as a safety net: a long server error
                    // under a large system font must not push the
                    // buttons out of the dialog (sibling dialogs in
                    // this file already scroll their bodies).
                    modifier = Modifier
                        .width(380.dp)
                        .heightIn(max = 480.dp)
                        .verticalScroll(rememberScrollState()),
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
                                val api = ApiClient(profile)
                                runCatching {
                                    api.changePassword(currentPassword = current, newPassword = next)
                                }.onSuccess {
                                    api.close()
                                    working = false
                                    done = true
                                }.onFailure {
                                    api.close()
                                    working = false
                                    errorMsg = userFacingError(it, "settings.security.changePassword.failed")
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
    val displayZone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()

    var devices by remember { mutableStateOf<List<cn.bywave.calendar.desktop.data.model.DeviceDTO>?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var revoking by remember { mutableStateOf<cn.bywave.calendar.desktop.data.model.DeviceDTO?>(null) }
    // Bump to force a reload (after a successful revoke).
    var reloadKey by remember { mutableStateOf(0) }

    androidx.compose.runtime.LaunchedEffect(reloadKey) {
        loading = true
        loadError = null
        val api = ApiClient(profile)
        runCatching { api.listDevices() }
            .onSuccess {
                api.close()
                devices = it.devices
                loading = false
            }
            .onFailure {
                api.close()
                loadError = userFacingError(it, "settings.devices.loadFailed")
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
                                Text(device.label, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
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
                                        mapOf("when" to formatTimestamp(seen, displayZone)),
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
                        val api = ApiClient(profile)
                        runCatching {
                            api.revokeDevice(device.id)
                        }.onSuccess {
                            api.close()
                            working = false
                            onRevoked()
                        }.onFailure {
                            api.close()
                            working = false
                            errorMsg = userFacingError(it, "settings.devices.revokeFailed")
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

/** Only opening a new dialog adopts the current device zone. */
@Composable
internal fun rememberCalendarTimezoneDraft(existingTimeZone: String?, initialDisplayZone: java.time.ZoneId): androidx.compose.runtime.MutableState<String> =
    remember { mutableStateOf(existingTimeZone ?: initialDisplayZone.id) }

/** Best-effort pretty-print of an ISO8601 server timestamp into the
 *  user's local zone. Falls back to the raw string if parsing fails (the
 *  server could change format) — better than crashing the row. */
@Composable
internal fun formatTimestamp(iso: String, displayZone: java.time.ZoneId): String {
    val formatter = remember(displayZone) {
        java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(displayZone)
    }
    return runCatching {
        formatter.format(java.time.Instant.parse(iso))
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
private fun LanguageSection() {
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
                    .pointerHoverIcon(PointerIcon.Hand)
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

}

@Composable
private fun RemindersSection() {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    // Event reminders are local to this installation.
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
                            .pointerHoverIcon(PointerIcon.Hand)
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

}

@Composable
private fun AppearanceSection(profile: Profile) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    // Appearance changes take effect immediately.
    val appearance by cn.bywave.calendar.desktop.data.AppearancePrefs.mode.collectAsState()
    SectionTitle(t("settings.theme.title"))
    Text(
        t("settings.theme.desc"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )
    SectionCard {
        listOf(
            cn.bywave.calendar.desktop.data.AppearancePrefs.Mode.LIGHT to "settings.theme.light",
            cn.bywave.calendar.desktop.data.AppearancePrefs.Mode.DARK to "settings.theme.dark",
            cn.bywave.calendar.desktop.data.AppearancePrefs.Mode.SYSTEM to "settings.theme.system",
        ).forEach { (mode, key) ->
            val active = mode == appearance
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .pointerHoverIcon(PointerIcon.Hand)
                    .clickable { cn.bywave.calendar.desktop.data.AppearancePrefs.setMode(mode) }
                    .padding(horizontal = 4.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(
                    selected = active,
                    onClick = { cn.bywave.calendar.desktop.data.AppearancePrefs.setMode(mode) },
                )
                Spacer(Modifier.width(8.dp))
                Text(t(key), style = MaterialTheme.typography.bodyMedium)
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
    OpenInWebButton(profile = profile, next = "/app/settings/appearance#theme", label = t("settings.appearance.openOnWeb"))
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

    // 帮助与支持 — the site's /support page (FAQ + contact channels),
    // on the user's own server like the legal pages below, opened in
    // the APP's current language.
    Spacer(Modifier.height(24.dp))
    SectionTitle(t("settings.about.help"))
    SectionCard {
        val langCode = cn.bywave.calendar.desktop.i18n.I18n.current.value.code
        val base = profile.serverUrl.trimEnd('/')
        TextButton(onClick = {
            runCatching { Desktop.getDesktop().browse(URI("$base/support?lang=$langCode")) }
        }) {
            Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text(t("settings.about.help"))
        }
    }

    // 法律 — aligned with the mobile apps' Settings → 法律 section. The
    // pages live on the user's own server (localized EJS); ?lang= makes
    // them open in the same language the desktop APP is currently using.
    Spacer(Modifier.height(24.dp))
    SectionTitle(t("settings.about.legal"))
    SectionCard {
        val langCode = cn.bywave.calendar.desktop.i18n.I18n.current.value.code
        val base = profile.serverUrl.trimEnd('/')
        listOf(
            "legal.privacy" to "/privacy",
            "legal.terms" to "/terms",
            "legal.dataProcessing" to "/data-processing",
            "legal.openSource" to "/open-source",
        ).forEach { (key, path) ->
            TextButton(onClick = {
                runCatching { Desktop.getDesktop().browse(URI("$base$path?lang=$langCode")) }
            }) {
                Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(t(key))
            }
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
        shape = RoundedCornerShape(Dimens.cardRadius),
        color = if (danger)
            MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.15f)
        else
            MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
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
    // Label column is weight-based, NOT a fixed width. A fixed 120.dp clipped
    // / awkwardly wrapped longer translations ("Anzeigename", "ID de l'appareil",
    // "ID de dispositivo") — that was part of the "切语言后变形" report. Weight
    // keeps every row's label column the same width (so values still align) while
    // giving enough room for any language to stay on one line.
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
            modifier = Modifier.weight(0.42f),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            value,
            modifier = Modifier.weight(0.58f),
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
                        val api = ApiClient(profile)
                        val resp = api.webSession(next)
                        Desktop.getDesktop().browse(URI(resp.url))
                        api.close()
                    }.onFailure {
                        errorMsg = userFacingError(it, "openInWeb.openFailed")
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
                    val api = ApiClient(profile)
                    val resp = api.webSession(next)
                    Desktop.getDesktop().browse(URI(resp.url))
                    api.close()
                }.onFailure {
                    errorMsg = userFacingError(it, "openInWeb.openFailed")
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
