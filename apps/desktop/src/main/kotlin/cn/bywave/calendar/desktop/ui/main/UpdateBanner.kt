// Slim banner above the calendar grid when UpdateChecker has spotted
// a newer release. Shows version + brief notes + a download button
// (opens the user's default browser to the per-OS asset URL) + a
// dismiss "×" button. Mandatory updates hide the dismiss button so
// users have to act (mirrors the Android in-app updater UX).
//
// Why a banner not a modal: an open modal would block the whole UI,
// which is hostile for a "nice-to-have" update prompt. The banner
// stays visible until the user dismisses or installs.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.BuildInfo
import cn.bywave.calendar.desktop.data.update.DesktopUpdateInfo
import cn.bywave.calendar.desktop.data.update.UpdateChecker
import java.awt.Desktop
import java.net.URI

@Composable
fun UpdateBanner(info: DesktopUpdateInfo) {
    val assetUrl = UpdateChecker.platform?.let { info.assets[it]?.url }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.primaryContainer)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Default.CloudDownload,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "桌面端有新版本 v${info.versionName} · 当前 v${BuildInfo.VERSION_NAME}",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            if (info.notes.isNotBlank()) {
                Text(
                    info.notes.lineSequence().joinToString(" · ").take(140),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.85f),
                    maxLines = 1,
                )
            }
        }
        Spacer(Modifier.width(12.dp))

        if (assetUrl != null) {
            Button(
                onClick = {
                    runCatching {
                        if (Desktop.isDesktopSupported()) Desktop.getDesktop().browse(URI(assetUrl))
                    }
                    // Don't auto-dismiss — user might want the banner
                    // to remind them after download finishes.
                },
            ) { Text("下载") }
        } else {
            // No asset for the user's platform on this release. Could
            // be a Mac-only build that hasn't landed for Windows yet.
            Text(
                "暂无 ${osLabel(UpdateChecker.platform)} 版本",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.8f),
            )
        }

        if (!info.mandatory) {
            Spacer(Modifier.width(4.dp))
            IconButton(onClick = { UpdateChecker.dismiss() }) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = "暂不更新",
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
        }
    }
}

private fun osLabel(p: String?): String = when (p) {
    "mac" -> "macOS"
    "win" -> "Windows"
    "linux" -> "Linux"
    else -> "当前系统"
}
