// Full-screen update dialog. Replaces the previous "banner with one
// download button that opens browser" UX with an in-app flow:
//   1. Show new version + notes side-by-side with current version.
//   2. "下载并打开" button starts UpdateDownloader, progress bar
//      shows bytes / total / percent live.
//   3. On done, the OS pops Finder with the mounted DMG —
//      user drags .app to /Applications + relaunches.
//   4. On error, show the message + "重试".
//
// Mandatory updates hide "稍后" so users have to act; non-mandatory
// have a dismiss path that closes the dialog for this session.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.BuildInfo
import cn.bywave.calendar.desktop.data.update.DownloadState
import cn.bywave.calendar.desktop.data.update.UpdateChecker
import cn.bywave.calendar.desktop.data.update.UpdateDownloader
import kotlinx.coroutines.launch

@Composable
fun UpdateDialog(onDismiss: () -> Unit) {
    val info = UpdateChecker.available.collectAsState().value
        // Renderer is only mounted when info != null, but null-check
        // defensively in case the dismiss races with state collection.
        ?: return
    val download by UpdateDownloader.state.collectAsState()
    val scope = rememberCoroutineScope()
    val asset = UpdateChecker.platform?.let { info.assets[it] }

    AlertDialog(
        onDismissRequest = {
            // Don't allow dismiss while a download is in flight — closing
            // the dialog would orphan the progress UI. Users can wait
            // or kill the app to abort.
            if (download !is DownloadState.Running) onDismiss()
        },
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Default.CloudDownload,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    "桌面端有新版本",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        },
        text = {
            Column(
                modifier = Modifier.width(440.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Version side-by-side
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("当前版本", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                        Text("v${BuildInfo.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    }
                    Text("→", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.outline)
                    Column(modifier = Modifier.weight(1f).padding(start = 12.dp)) {
                        Text("新版本", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        Text("v${info.versionName}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
                    }
                }

                if (info.notes.isNotBlank()) {
                    Text("更新内容", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.outline)
                    Text(
                        info.notes,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }

                if (asset == null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp),
                    ) {
                        Text(
                            "暂无 ${osLabel(UpdateChecker.platform)} 版本",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                } else {
                    // Download progress / outcome
                    when (val d = download) {
                        DownloadState.Idle -> Unit
                        is DownloadState.Running -> {
                            val pct = (d.fraction * 100).toInt()
                            Column {
                                LinearProgressIndicator(
                                    progress = { d.fraction.coerceAtLeast(0.02f) },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                Text(
                                    if (d.bytesTotal > 0) "下载中 · ${fmtMB(d.bytesDone)} / ${fmtMB(d.bytesTotal)} · ${pct}%"
                                    else "下载中 · ${fmtMB(d.bytesDone)}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.outline,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                        }
                        is DownloadState.Done -> {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Default.CheckCircle,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    "已下载到 ${d.file.parent} —— Finder 已弹出，把图标拖到「应用程序」即可。",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                        is DownloadState.Failed -> {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Default.Warning,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.error,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(d.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (asset != null && download !is DownloadState.Running) {
                Button(onClick = {
                    UpdateDownloader.reset()
                    scope.launch {
                        UpdateDownloader.downloadAndOpen(asset.url, asset.sha256.ifBlank { null })
                    }
                }) {
                    Text(if (download is DownloadState.Done) "再次打开" else "下载并打开")
                }
            }
        },
        dismissButton = {
            if (download !is DownloadState.Running) {
                TextButton(onClick = onDismiss) {
                    Text(if (info.mandatory) "等待安装" else "稍后")
                }
            }
        },
    )
}

private fun fmtMB(b: Long): String = "%.1f MB".format(b / 1024.0 / 1024.0)

private fun osLabel(p: String?): String = when (p) {
    "mac" -> "macOS"
    "win" -> "Windows"
    "linux" -> "Linux"
    else -> "当前系统"
}
