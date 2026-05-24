// SettingsScreen — minimal account + about page. Mirrors the
// first-level Settings of iOS SettingsView (account info, language
// deep-link, about, sign out). Detailed sub-pages (MFA, Passkey,
// language picker, etc.) come in v0.4+.

package cn.bywave.calendar.ui.settings

import android.content.Intent
import android.net.Uri
import android.provider.Settings
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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import cn.bywave.calendar.BuildConfig
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.ui.calendar.mutedTextColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onSignOut: () -> Unit,
) {
    val tokens = remember { BywaveApp.instance.tokenStore }
    val context = LocalContext.current
    var showSignOutDialog by remember { mutableStateOf(false) }

    Scaffold(
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
                ReadRow(label = stringResource(R.string.settings_email), value = tokens.userEmail ?: "—")
                HorizontalDivider()
                ReadRow(label = stringResource(R.string.settings_server), value = tokens.serverUrl ?: "—")
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
                    icon = Icons.AutoMirrored.Filled.Logout,
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
