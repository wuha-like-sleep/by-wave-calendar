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
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import cn.bywave.calendar.BuildConfig
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.ChangePasswordRequest
import cn.bywave.calendar.data.model.DeleteAccountRequest
import cn.bywave.calendar.data.store.SyncPreferences
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.update.UpdateChecker
import kotlinx.coroutines.launch

/** Android 13+ 才有运行时通知权限；更早的版本装上就是允许的。 */
private fun hasNotificationPermission(context: android.content.Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(
        context, Manifest.permission.POST_NOTIFICATIONS,
    ) == android.content.pm.PackageManager.PERMISSION_GRANTED
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onSignOut: () -> Unit,
    onManageCalendars: () -> Unit = {},
    onManageBookingLinks: () -> Unit = {},
    onScanDesktopPair: () -> Unit = {},
) {
    val profiles = remember { BywaveApp.instance.profiles }
    val active = profiles.active()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefsStore = remember { SyncPreferences(context) }
    // 写完开关不能只落 DataStore 就完事——提醒是排进系统 AlarmManager 的，
    // 镜像是写进系统日历的，两者都活在 APP 之外，不主动去改就一直是旧的。
    // 所有改这三项的地方都走这一个函数，省得又漏掉某一条分支。
    val repository = remember { BywaveApp.instance.repository }
    fun applySync(write: suspend () -> Unit) {
        scope.launch {
            write()
            repository.applySyncPreferences()
        }
    }
    val prefs by prefsStore.flow.collectAsState(initial = cn.bywave.calendar.data.store.SyncPrefs())
    var showSignOutDialog by remember { mutableStateOf(false) }
    var showChangePassword by remember { mutableStateOf(false) }
    var showDeleteAccount by remember { mutableStateOf(false) }
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
        if (ok) applySync { prefsStore.setMirrorToSystem(true) }
        else permissionWarning = context.getString(R.string.settings_perm_calendar_denied)
    }
    // 提醒默认是开的，而 Android 13+ 的通知权限要单独授权。开关显示「开」
    // 而系统不让发通知 = 又一个空开关，所以这个状态必须拿在手上、显示出来。
    var notifGranted by remember { mutableStateOf(hasNotificationPermission(context)) }
    val notifPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        notifGranted = granted
        if (granted) applySync { prefsStore.setRemindersEnabled(true) }
        else permissionWarning = context.getString(R.string.settings_perm_notifications_denied)
    }

    Scaffold(
        snackbarHost = { androidx.compose.material3.SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.nav_back))
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

            // Account security (v0.11) — native change-password. Used to
            // bounce out to the web via the /auth/web-session bridge; the
            // server's POST /account/password lets us do it in-app now.
            Section(title = stringResource(R.string.settings_security)) {
                ActionRow(
                    label = stringResource(R.string.settings_change_password),
                    onClick = { showChangePassword = true },
                    trailingIcon = Icons.Default.ChevronRight,
                )
            }

            // Language (v0.10+) — APP 内语言覆盖。13+ 走平台 LocaleManager，
            // 12 及以下走 attachBaseContext 换 Configuration；状态和持久化
            // 都在 cn.bywave.calendar.i18n.LocaleHelper。
            run {
                var showLangDialog by remember { mutableStateOf(false) }
                val currentLocale by cn.bywave.calendar.i18n.LocaleHelper.current
                Section(title = stringResource(R.string.settings_language_section)) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { showLangDialog = true }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(stringResource(R.string.settings_language_title), fontWeight = FontWeight.Medium)
                            Text(
                                cn.bywave.calendar.i18n.LocaleHelper.currentLabel(context),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Icon(
                            Icons.Default.ChevronRight,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (showLangDialog) {
                    AlertDialog(
                        onDismissRequest = { showLangDialog = false },
                        title = { Text(stringResource(R.string.settings_language_title)) },
                        text = {
                            // 这里原来只列了「跟随系统 / 简体中文 / English」
                            // 三项，而 APP 实际带了 8 种翻译，locales_config.xml
                            // 里也声明了 8 种。后果：日文/韩文/西/法/德/繁中的
                            // 用户在 APP 里根本切不过去，Android 13 以下连系统
                            // 设置那条路都没有——翻译做了，但那批人看不到。
                            // 改成直接读 LocaleHelper.languages，以后加语言
                            // 只改一处。
                            val options = listOf(
                                "" to stringResource(R.string.settings_language_follow_system),
                            ) + cn.bywave.calendar.i18n.LocaleHelper.languages
                            // 语言多了之后一屏放不下，对话框内容要能滚。
                            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                                options.forEach { (code, label) ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable {
                                                cn.bywave.calendar.i18n.LocaleHelper.setLocale(context, code)
                                                showLangDialog = false
                                                // LocaleHelper 里会重建 Activity
                                                // （13+ 由平台重建，12 及以下
                                                // 我们自己 recreate），新语言
                                                // 立刻生效，不用手动重启。
                                            }
                                            .padding(vertical = 12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(label, modifier = Modifier.weight(1f))
                                        if (code == currentLocale) {
                                            Icon(
                                                Icons.Default.Check,
                                                contentDescription = null,
                                                tint = MaterialTheme.colorScheme.primary,
                                            )
                                        }
                                    }
                                }
                            }
                        },
                        confirmButton = {
                            TextButton(onClick = { showLangDialog = false }) {
                                Text(stringResource(android.R.string.cancel))
                            }
                        },
                    )
                }
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
                                applySync { prefsStore.setMirrorToSystem(true) }
                            } else {
                                calendarPermLauncher.launch(arrayOf(
                                    Manifest.permission.READ_CALENDAR,
                                    Manifest.permission.WRITE_CALENDAR,
                                ))
                            }
                        } else {
                            applySync { prefsStore.setMirrorToSystem(false) }
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
                            notifGranted = hasPerm
                            if (hasPerm) {
                                applySync { prefsStore.setRemindersEnabled(true) }
                            } else {
                                notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                        } else {
                            applySync { prefsStore.setRemindersEnabled(false) }
                        }
                    },
                )
                if (prefs.remindersEnabled && !notifGranted) {
                    HorizontalDivider()
                    Text(
                        text = stringResource(R.string.settings_reminders_need_permission),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
                            .padding(vertical = 10.dp),
                    )
                }
                if (prefs.remindersEnabled) {
                    HorizontalDivider()
                    LeadTimeRow(
                        currentMinutes = prefs.reminderLeadMinutes,
                        onPick = { m -> applySync { prefsStore.setReminderLeadMinutes(m) } },
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
            Section(title = stringResource(R.string.settings2_section_calendars)) {
                ActionRow(
                    label = stringResource(R.string.settings2_manage_calendars),
                    onClick = onManageCalendars,
                    trailingIcon = Icons.Default.ChevronRight,
                )
                HorizontalDivider()
                // Booking links (v0.12) — owner-managed public scheduling
                // pages. Server's /booking-links CRUD existed already; this
                // is the native UI.
                ActionRow(
                    label = stringResource(R.string.booking_title),
                    onClick = onManageBookingLinks,
                    trailingIcon = Icons.Default.ChevronRight,
                )
            }

            // Cross-device pairing — only the desktop direction has a
            // dedicated APP entry. Phone-to-phone pairing happens during
            // initial setup (the SetupScreen), which logged-in users can
            // also reach via "添加账号" in the profile switcher.
            Section(title = stringResource(R.string.settings2_section_desktop)) {
                ActionRow(
                    icon = Icons.Default.QrCodeScanner,
                    label = stringResource(R.string.settings2_scan_desktop),
                    trailing = stringResource(R.string.settings2_scan_desktop_sub),
                    onClick = onScanDesktopPair,
                    trailingIcon = Icons.Default.ChevronRight,
                )
            }

            // System
            Section(title = stringResource(R.string.settings2_section_system)) {
                ActionRow(
                    icon = Icons.Default.Language,
                    label = stringResource(R.string.settings_language),
                    trailing = stringResource(R.string.settings2_go_system),
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
                // Legal links open the bound server's own pages (each
                // operator self-hosts their policies), falling back to the
                // project site when signed out — see legalUrl().
                ActionRow(
                    label = stringResource(R.string.settings_privacy),
                    onClick = { openExternal(context, legalUrl(active?.serverUrl, "/privacy")) },
                    trailingIcon = Icons.AutoMirrored.Filled.OpenInNew,
                )
                HorizontalDivider()
                ActionRow(
                    label = stringResource(R.string.settings_data_processing),
                    onClick = { openExternal(context, legalUrl(active?.serverUrl, "/data-processing")) },
                    trailingIcon = Icons.AutoMirrored.Filled.OpenInNew,
                )
                HorizontalDivider()
                ActionRow(
                    label = stringResource(R.string.settings_terms),
                    onClick = { openExternal(context, legalUrl(active?.serverUrl, "/terms")) },
                    trailingIcon = Icons.AutoMirrored.Filled.OpenInNew,
                )
                HorizontalDivider()
                ActionRow(
                    label = stringResource(R.string.settings_support),
                    onClick = { openExternal(context, legalUrl(active?.serverUrl, "/support")) },
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
                    label = if (checkingForUpdate) stringResource(R.string.settings2_checking) else stringResource(R.string.settings2_check_update),
                    onClick = if (checkingForUpdate) ({}) else ({
                        UpdateChecker.clearDismissal()
                        checkingForUpdate = true
                        scope.launch {
                            try {
                                val result = UpdateChecker.checkNow(context.applicationContext)
                                val msg = when (result) {
                                    is cn.bywave.calendar.update.UserCheckResult.UpToDate ->
                                        context.getString(R.string.settings2_up_to_date, BuildConfig.VERSION_NAME)
                                    is cn.bywave.calendar.update.UserCheckResult.UpdateFound ->
                                        context.getString(R.string.settings2_update_found)
                                    is cn.bywave.calendar.update.UserCheckResult.NotSignedIn ->
                                        context.getString(R.string.settings2_not_signed_in)
                                    is cn.bywave.calendar.update.UserCheckResult.Failed ->
                                        context.getString(R.string.settings2_check_failed, result.message)
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
                    Text(stringResource(R.string.settings2_version), modifier = Modifier.weight(1f))
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

            // Danger zone (v0.11) — native account deletion. Server's
            // POST /account/delete requires password + an exact confirm
            // phrase; on success the account + all sessions are gone and
            // we sign this profile out (same path as 退出登录).
            Section(title = "") {
                ActionRow(
                    icon = Icons.Filled.Delete,
                    label = stringResource(R.string.settings_delete_account),
                    danger = true,
                    onClick = { showDeleteAccount = true },
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

    if (showChangePassword) {
        ChangePasswordDialog(onDismiss = { showChangePassword = false })
    }

    if (showDeleteAccount) {
        DeleteAccountDialog(
            onDismiss = { showDeleteAccount = false },
            onDeleted = {
                showDeleteAccount = false
                // Reuse the sign-out path: wipes the local cache,
                // invalidates the API client, removes the profile, and
                // pops back to calendar/setup as activeId recomputes.
                onSignOut()
            },
        )
    }
}

// ---- Native account dialogs (v0.11) ----

@Composable
private fun ChangePasswordDialog(onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Client-side validation mirrors the server (newPassword min 8) so we
    // don't make a round trip just to learn the password is too short.
    val tooShort = next.isNotEmpty() && next.length < 8
    val mismatch = confirm.isNotEmpty() && next != confirm
    val canSubmit = !busy &&
        current.isNotEmpty() &&
        next.length >= 8 &&
        next == confirm

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.settings_change_password)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = current,
                    onValueChange = { current = it },
                    label = { Text(stringResource(R.string.password_current)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = next,
                    onValueChange = { next = it },
                    label = { Text(stringResource(R.string.password_new)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    isError = tooShort,
                    supportingText = if (tooShort) {
                        { Text(stringResource(R.string.password_too_short), color = MaterialTheme.colorScheme.error) }
                    } else null,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = confirm,
                    onValueChange = { confirm = it },
                    label = { Text(stringResource(R.string.password_confirm)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    isError = mismatch,
                    supportingText = if (mismatch) {
                        { Text(stringResource(R.string.password_mismatch), color = MaterialTheme.colorScheme.error) }
                    } else null,
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = canSubmit,
                onClick = {
                    scope.launch {
                        busy = true
                        error = null
                        try {
                            val profile = BywaveApp.instance.profiles.active()
                                ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
                            val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                            client.api.changePassword(
                                ChangePasswordRequest(currentPassword = current, newPassword = next),
                            )
                            android.widget.Toast.makeText(
                                context,
                                context.getString(R.string.password_changed),
                                android.widget.Toast.LENGTH_LONG,
                            ).show()
                            onDismiss()
                        } catch (e: Exception) {
                            error = serverErrorMessage(e)
                                ?: context.getString(R.string.password_change_failed)
                        } finally {
                            busy = false
                        }
                    }
                },
            ) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Text(stringResource(R.string.action_save))
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

/** 本地化确认短语上线之前，服务端只认这一串。只用于对老服务端的一次重试，
 *  不显示给任何人看。 */
private const val LEGACY_DELETE_PHRASE = "\u5220\u9664\u6211\u7684\u8d26\u53f7"

@Composable
private fun DeleteAccountDialog(
    onDismiss: () -> Unit,
    onDeleted: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var password by remember { mutableStateOf("") }
    var phrase by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // 确认短语跟着界面语言走。
    //
    // 之前这一行是「同一个 key 在 8 种语言里都填中文的『删除我的账号』」，
    // 注释写着「必须等于服务端的 z.literal」。后果：一个德语用户，手机上
    // 没有中文输入法，就永远删不掉自己的账号 —— 按钮永远是灰的。
    //
    // 服务端早就不是 z.literal 了（src/routes/devices.ts 的 /account/delete）：
    // 它接受**任意一门受支持语言**的确认短语，也仍然接受中文那一串。所以
    // 客户端要做的就是：显示并要求用户输入他自己语言的那串，原样发过去。
    // 这里的取值必须和服务端 src/lib/i18n/locales/<lang>.ts 里的
    // settings.account.deleteConfirmFieldPlaceholder 完全一致 ——
    // DeleteAccountPhraseTest 会逐条比对，不一致就红。
    val requiredPhrase = stringResource(R.string.delete_account_confirm_phrase)
    // 软键盘容易在词尾自动补一个空格，trim 一下，别让用户对着一个
    // 看起来完全正确的输入框猜自己哪里错了。
    val typedPhrase = phrase.trim()
    val phraseMismatch = phrase.isNotEmpty() && typedPhrase != requiredPhrase
    val canSubmit = !busy && password.isNotEmpty() && typedPhrase == requiredPhrase

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.delete_account_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = stringResource(R.string.delete_account_warning),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(stringResource(R.string.delete_account_password)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = phrase,
                    onValueChange = { phrase = it },
                    label = { Text(stringResource(R.string.delete_account_confirm_label, requiredPhrase)) },
                    singleLine = true,
                    isError = phraseMismatch,
                    supportingText = if (phraseMismatch) {
                        { Text(stringResource(R.string.delete_account_confirm_mismatch, requiredPhrase), color = MaterialTheme.colorScheme.error) }
                    } else null,
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = canSubmit,
                onClick = {
                    scope.launch {
                        busy = true
                        error = null
                        try {
                            val profile = BywaveApp.instance.profiles.active()
                                ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
                            val client = ApiClient.forProfile(profile, BywaveApp.instance.profiles)
                            try {
                                client.api.deleteAccount(
                                    DeleteAccountRequest(password = password, confirm = requiredPhrase),
                                )
                            } catch (e: retrofit2.HttpException) {
                                // 老服务端（本地化确认短语上线之前的版本）只认中文那一串。
                                // 用户在自己语言里输入的是对的，不该因为服务端还没升级
                                // 就删不掉账号 —— 被判 400 bad_confirmation 时用兼容值
                                // 再试一次。其它错误（密码错、最后一个管理员）原样抛出。
                                if (e.code() == 400 && requiredPhrase != LEGACY_DELETE_PHRASE) {
                                    client.api.deleteAccount(
                                        DeleteAccountRequest(password = password, confirm = LEGACY_DELETE_PHRASE),
                                    )
                                } else throw e
                            }
                            onDeleted()
                        } catch (e: Exception) {
                            error = serverErrorMessage(e)
                                ?: context.getString(R.string.delete_account_failed)
                        } finally {
                            busy = false
                        }
                    }
                },
            ) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Text(
                        stringResource(R.string.settings_delete_account),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

// v0.9.0 UX refactor — Section/ActionRow/ReadRow tuned to match iOS
// Form/Section visual rhythm. Specifically:
//   - Section title: small caps, secondary color, indented to align
//     with iOS UITableView grouped style ("ABOUT", "ACCOUNT", etc).
//   - Section body: plain surface + 1dp border instead of translucent
//     overlay. iOS Form sections are clean white-on-light-gray, not
//     blurry frosted glass.
//   - Rows: bodyLarge (17sp ≈ iOS 17pt body), 12dp vertical (slightly
//     tighter than Material 3 default 16dp; iOS rows are visually
//     denser without feeling cramped).
//   - Chevron: lightened to outlineVariant (≈ iOS tertiaryLabel) so
//     it reads as "tappable hint" rather than "primary action".
//
// Implementation note: kept the @Composable signatures identical so
// the rest of SettingsScreen needs zero edits. Pure visual tweak.

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column {
        if (title.isNotEmpty()) {
            Text(
                text = title,
                // iOS Form section headers are uppercase + small + secondary.
                // labelSmall is 11sp Material — bump slightly via letterSpacing
                // to feel like SF Pro's section-header rendering.
                style = MaterialTheme.typography.labelSmall.copy(
                    letterSpacing = 0.5.sp,
                ),
                color = mutedTextColor(),
                modifier = Modifier.padding(start = 16.dp, top = 4.dp, bottom = 6.dp),
                fontWeight = FontWeight.SemiBold,
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(
                    BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
                    RoundedCornerShape(12.dp),
                ),
        ) { content() }
    }
}

@Composable
private fun ReadRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyLarge,
        )
        Text(
            text = value,
            color = mutedTextColor(),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
        )
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
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (danger) MaterialTheme.colorScheme.error
                       else MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.size(14.dp))
        }
        Text(
            label,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyLarge,
            color = if (danger) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurface,
        )
        if (trailing != null) {
            Text(
                text = trailing,
                color = mutedTextColor(),
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.size(6.dp))
        }
        // Lighter chevron — outlineVariant is closer to iOS's
        // tertiaryLabel than the medium-gray onSurfaceVariant we had.
        Icon(
            trailingIcon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(20.dp),
        )
    }
}

private fun openExternal(context: android.content.Context, url: String) {
    runCatching {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}

// Build a legal-page URL (e.g. /privacy, /data-processing, /terms) on the
// CURRENTLY BOUND server rather than hardcoding one operator's host. This
// project is open-source + self-hosted: each operator publishes their own
// policies at <their-server>/privacy etc, so a fork / another deployment
// must not point users at someone else's site. When no server is bound yet
// (signed out), fall back to the project's public demo — which serves the
// same generic, honest policies — so the links still resolve to something.
private const val PROJECT_DEMO_SITE = "https://rl.lz-ss.com"
private fun legalUrl(serverUrl: String?, path: String): String {
    val base = serverUrl?.trim()?.trimEnd('/').takeUnless { it.isNullOrEmpty() } ?: PROJECT_DEMO_SITE
    // Append ?lang= so the operator's now-localized legal pages open in the
    // app's current language (the server honors ?lang= above Accept-Language).
    // "follow system" ("") → omit it and let the server detect.
    val lang = serverLangParam(cn.bywave.calendar.i18n.LocaleHelper.current.value)
    return if (lang != null) "$base$path?lang=$lang" else base + path
}

/** Map the in-app language tag (LocaleHelper codes) to the server's ?lang=
 *  locale code. Android uses zh-Hans; the server uses zh-CN. zh-TW and
 *  en/ja/ko/es/fr/de already match. "" (follow system) → null (server detects). */
private fun serverLangParam(code: String): String? = when (code) {
    "" -> null
    "zh-Hans" -> "zh-CN"
    else -> code
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
