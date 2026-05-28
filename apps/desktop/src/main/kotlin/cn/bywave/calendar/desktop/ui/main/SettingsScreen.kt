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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
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
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.Profile
import cn.bywave.calendar.desktop.data.update.UpdateChecker
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import kotlinx.coroutines.launch
import java.awt.Desktop
import java.net.URI

/** Which left-rail tab is active. Order here = order in the nav rail. */
private enum class SettingsTab(val label: String, val icon: ImageVector) {
    Account("账户", Icons.Default.AccountCircle),
    Calendars("日历", Icons.Default.CalendarMonth),
    Security("安全", Icons.Default.Security),
    Appearance("外观", Icons.Default.Brush),
    About("关于", Icons.Default.Info),
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
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 28.dp, vertical = 20.dp),
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
                        SettingsTab.Calendars -> CalendarsSection(calendars = calendars, profile = profile)
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
        Text(tab.label, color = fg, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
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

    Spacer(Modifier.height(20.dp))
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

    Spacer(Modifier.height(28.dp))
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

@Composable
private fun CalendarsSection(calendars: List<CalendarMeta>, profile: Profile) {
    SectionTitle("我的日历")
    Text(
        "桌面端目前只读显示。新建 / 删除 / 改属性请到网页端。",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 12.dp),
    )

    SectionCard {
        if (calendars.isEmpty()) {
            Text(
                "还没有日历。",
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
                            .background(parseHex(cal.color) ?: Color.Gray),
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
                }
                if (cal != calendars.last()) HorizontalDivider()
            }
        }
    }

    Spacer(Modifier.height(16.dp))
    OpenInWebButton(profile = profile, next = "/app/calendars", label = "在网页管理日历")
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

    Spacer(Modifier.height(20.dp))
    SectionTitle("危险操作", danger = true)
    SectionCard(danger = true) {
        OpenInWebRow(profile = profile, next = "/app/settings#danger", title = "删除账号", subtitle = "永久删除，请谨慎", danger = true)
    }
}

// -------- Appearance --------

@Composable
private fun AppearanceSection(profile: Profile) {
    SectionTitle("外观")
    Text(
        "主题 / 配色 / 密度的偏好绑定到你的账号 —— 在网页设置一次，下次桌面端登录同步生效。",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 16.dp),
    )
    OpenInWebButton(profile = profile, next = "/app/settings#theme", label = "在网页选择主题 / 密度")
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

@Composable
private fun SectionTitle(text: String, danger: Boolean = false) {
    Text(
        text,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.padding(bottom = 8.dp),
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
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            content()
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String, mono: Boolean = false) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(96.dp),
        )
        Text(
            value,
            modifier = Modifier.weight(1f),
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
