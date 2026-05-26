// SettingsScreen — minimal account + about page. Mirrors the
// first-level Settings of iOS SettingsView (account info, language
// deep-link, about, sign out). Detailed sub-pages (MFA, Passkey,
// language picker, etc.) come in v0.4+.

package cn.bywave.calendar.ui.settings

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import cn.bywave.calendar.BuildConfig
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.store.SyncPreferences
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.update.UpdateChecker
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onSignOut: () -> Unit,
    onManageCalendars: () -> Unit = {},
) {
    val profiles = remember { BywaveApp.instance.profiles }
    val active = profiles.active()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefsStore = remember { SyncPreferences(context) }
    val prefs by prefsStore.flow.collectAsState(initial = cn.bywave.calendar.data.store.SyncPrefs())
    var showSignOutDialog by remember { mutableStateOf(false) }
    var permissionWarning by remember { mutableStateOf<String?>(null) }
    // Feedback host for "检查更新" — Snackbar is the right grain for a
    // throwaway "已是最新版" or "检查失败" toast.
    val snackbarHostState = remember { androidx.compose.material3.SnackbarHostState() }
    var checkingForUpdate by remember { mutableStateOf(false) }

    // -- Permission launchers --
    val calendarPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        val ok = granted[Manifest.permission.READ_CALENDAR] == true &&
            granted[Manifest.permission.WRITE_CALENDAR] == true
        if (ok) scope.launch { prefsStore.setMirrorToSystem(true) }
        else permissionWarning = context.getString(R.string.settings_perm_calendar_denied)
    }
    val notifPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) scope.launch { prefsStore.setRemindersEnabled(true) }
        else permissionWarning = context.getString(R.string.settings_perm_notifications_denied)
    }

    Scaffold(
        snackbarHost = { androidx.compose.material3.SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
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
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.size(4.dp))

            // Account card
            Section(title = stringResource(R.string.settings_account)) {
                ReadRow(label = stringResource(R.string.settings_email), value = active?.email ?: "—")
                HorizontalDivider()
                ReadRow(label = stringResource(R.string.settings_server), value = active?.serverUrl ?: "—")
            }

            // Sync (v0.6)
            Section(title = stringResource(R.string.settings_sync_section)) {
                SwitchRow(
                    title = stringResource(R.string.settings_mirror_title),
                    subtitle = stringResource(R.string.settings_mirror_desc),
                    checked = prefs.mirrorToSystemCalendar,
                    onCheckedChange = { wanted ->
                        if (wanted) {
                            // Ask for calendar runtime perms first; on grant
                            // the callback flips the pref. On deny we just
                            // show a hint and leave it off.
                            val hasRead = ContextCompat.checkSelfPermission(
                                context, Manifest.permission.READ_CALENDAR,
                            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                            val hasWrite = ContextCompat.checkSelfPermission(
                                context, Manifest.permission.WRITE_CALENDAR,
                            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                            if (hasRead && hasWrite) {
                                scope.launch { prefsStore.setMirrorToSystem(true) }
                            } else {
                                calendarPermLauncher.launch(arrayOf(
                                    Manifest.permission.READ_CALENDAR,
                                    Manifest.permission.WRITE_CALENDAR,
                                ))
                            }
                        } else {
                            scope.launch { prefsStore.setMirrorToSystem(false) }
                        }
                    },
                )
                HorizontalDivider()
                SwitchRow(
                    title = stringResource(R.string.settings_reminders_title),
                    subtitle = stringResource(R.string.settings_reminders_desc),
                    checked = prefs.remindersEnabled,
                    onCheckedChange = { wanted ->
                        if (wanted) {
                            val needsRuntime = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                            val hasPerm = !needsRuntime || ContextCompat.checkSelfPermission(
                                context, Manifest.permission.POST_NOTIFICATIONS,
                            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                            if (hasPerm) {
                                scope.launch { prefsStore.setRemindersEnabled(true) }
                            } else {
                                notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                        } else {
                            scope.launch { prefsStore.setRemindersEnabled(false) }
                        }
                    },
                )
                if (prefs.remindersEnabled) {
                    HorizontalDivider()
                    LeadTimeRow(
                        currentMinutes = prefs.reminderLeadMinutes,
                        onPick = { m -> scope.launch { prefsStore.setReminderLeadMinutes(m) } },
                    )
                }
            }

            if (permissionWarning != null) {
                Text(
                    text = permissionWarning!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }

            // Calendars (v0.8.2) — rename / change timezone. Server's
            // PATCH /calendars/:id supported this all along; the missing
            // UI was the only reason "导入的日历" names were stuck.
            Section(title = "日历") {
                ActionRow(
                    label = "管理日历",
                    onClick = onManageCalendars,
                    trailingIcon = Icons.Default.ChevronRight,
                )
            }

            // System
            Section(title = "系统") {
                ActionRow(
                    icon = Icons.Default.Language,
                    label = stringResource(R.string.settings_language),
                    trailing = "去系统设置",
                    onClick = {
                        // App-specific language settings (Android 13+) —
                        // falls back to general APP info page on older.
                        val uri = Uri.fromParts("package", context.packageName, null)
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        runCatching { context.startActivity(intent) }
                    },
                )
            }

            // About
            Section(title = stringResource(R.string.settings_about)) {
                ActionRow(
                    label = stringResource(R.string.settings_privacy),
                    onClick = { openExternal(context, "https://rl.lz-ss.com/privacy") },
                    trailingIcon = Icons.AutoMirrored.Filled.OpenInNew,
                )
                HorizontalDivider()
                ActionRow(
                    label = stringResource(R.string.settings_terms),
                    onClick = { openExternal(context, "https://rl.lz-ss.com/terms") },
                    trailingIcon = Icons.AutoMirrored.Filled.OpenInNew,
                )
                HorizontalDivider()
                ActionRow(
                    label = stringResource(R.string.settings_support),
                    onClick = { openExternal(context, "https://rl.lz-ss.com/support") },
                    trailingIcon = Icons.AutoMirrored.Filled.OpenInNew,
                )
                HorizontalDivider()
                ActionRow(
                    label = stringResource(R.string.settings_github),
                    onClick = { openExternal(context, "https://github.com/wuha-like-sleep/by-wave-calendar") },
                    trailingIcon = Icons.AutoMirrored.Filled.OpenInNew,
                )
                HorizontalDivider()
                // Manual update probe — useful when someone has dismissed
                // the auto-prompt and wants to come back to it, or when
                // we ship a fix and don't want them to wait 6h for the
                // throttle window. Clears the throttle + any prior
                // dismissal so the next check will surface a new sheet.
                //
                // Always emits a Snackbar so the user gets feedback —
                // without it a click on "检查更新" just silently does
                // nothing when there's no newer version, and people
                // wonder if their tap registered.
                ActionRow(
                    label = if (checkingForUpdate) "正在检查…" else "检查更新",
                    onClick = if (checkingForUpdate) ({}) else ({
                        UpdateChecker.clearDismissal()
                        checkingForUpdate = true
                        scope.launch {
                            try {
                                val result = UpdateChecker.checkNow(context.applicationContext)
                                val msg = when (result) {
                                    is cn.bywave.calendar.update.UserCheckResult.UpToDate ->
                                        "已是最新版 (v${BuildConfig.VERSION_NAME})"
                                    is cn.bywave.calendar.update.UserCheckResult.UpdateFound ->
                                        "发现新版本，已弹出更新提示"
                                    is cn.bywave.calendar.update.UserCheckResult.NotSignedIn ->
                                        "请先登录任一账号再检查更新"
                                    is cn.bywave.calendar.update.UserCheckResult.Failed ->
                                        "检查失败：${result.message}"
                                }
                                snackbarHostState.showSnackbar(msg)
                            } finally {
                                checkingForUpdate = false
                            }
                        }
                        Unit
                    }),
                    trailingIcon = Icons.Default.ChevronRight,
                )
                HorizontalDivider()
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("版本", modifier = Modifier.weight(1f))
                    Text(
                        text = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                        color = mutedTextColor(),
                    )
                }
            }

            // Sign out
            Section(title = "") {
                ActionRow(
                    icon = Icons.Filled.Logout,
                    label = stringResource(R.string.settings_signout),
                    danger = true,
                    onClick = { showSignOutDialog = true },
                )
            }

            Spacer(Modifier.size(24.dp))
        }
    }

    if (showSignOutDialog) {
        AlertDialog(
            onDismissRequest = { showSignOutDialog = false },
            title = { Text(stringResource(R.string.settings_signout)) },
            text = { Text(stringResource(R.string.settings_signout_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    showSignOutDialog = false
                    onSignOut()
                }) { Text(stringResource(R.string.settings_signout)) }
            },
            dismissButton = {
                TextButton(onClick = { showSignOutDialog = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column {
        if (title.isNotEmpty()) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium,
                color = mutedTextColor(),
                modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
                fontWeight = FontWeight.SemiBold,
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)),
        ) { content() }
    }
}

@Composable
private fun ReadRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Text(text = value, color = mutedTextColor(), maxLines = 1)
    }
}

@Composable
private fun ActionRow(
    label: String,
    onClick: () -> Unit,
    icon: ImageVector? = null,
    trailing: String? = null,
    trailingIcon: ImageVector = Icons.Default.ChevronRight,
    danger: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (danger) MaterialTheme.colorScheme.error
                       else MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.size(12.dp))
        }
        Text(
            label,
            modifier = Modifier.weight(1f),
            color = if (danger) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurface,
        )
        if (trailing != null) {
            Text(text = trailing, color = mutedTextColor(), style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.size(8.dp))
        }
        Icon(trailingIcon, contentDescription = null, tint = mutedTextColor())
    }
}

private fun openExternal(context: android.content.Context, url: String) {
    runCatching {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}

@Composable
private fun SwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Spacer(Modifier.size(8.dp))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun LeadTimeRow(
    currentMinutes: Int,
    onPick: (Int) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val options = listOf(5, 10, 15, 30, 60, 120)
    val labelRes = when (currentMinutes) {
        5 -> R.string.settings_reminder_lead_5
        10 -> R.string.settings_reminder_lead_10
        30 -> R.string.settings_reminder_lead_30
        60 -> R.string.settings_reminder_lead_60
        120 -> R.string.settings_reminder_lead_120
        else -> R.string.settings_reminder_lead_15
    }

    Box(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = true }
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.settings_reminder_lead), modifier = Modifier.weight(1f))
            Text(text = stringResource(labelRes), color = mutedTextColor())
            Spacer(Modifier.size(8.dp))
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = mutedTextColor())
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            for (m in options) {
                val res = when (m) {
                    5 -> R.string.settings_reminder_lead_5
                    10 -> R.string.settings_reminder_lead_10
                    15 -> R.string.settings_reminder_lead_15
                    30 -> R.string.settings_reminder_lead_30
                    60 -> R.string.settings_reminder_lead_60
                    else -> R.string.settings_reminder_lead_120
                }
                DropdownMenuItem(
                    text = { Text(stringResource(res)) },
                    onClick = {
                        onPick(m)
                        expanded = false
                    },
                )
            }
        }
    }
}
