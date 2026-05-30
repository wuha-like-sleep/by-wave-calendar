// In-app update dialog. v0.7.7 made the install fully automatic
// (Sparkle-style):
//   1. Show new version + notes side-by-side with current version.
//   2. "下载并安装" → UpdateDownloader streams the DMG to ~/Downloads/,
//      progress bar live.
//   3. On download complete → UpdateInstaller.install(file) mounts
//      the DMG via hdiutil, spawns a detached shell script that
//      swaps the .app under /Applications/ and relaunches, then
//      exitProcess(0). User sees "正在安装并重启…" briefly, the
//      window closes, and the new version pops up ~5 seconds later.
//   4. On any step failing → DMG opens in Finder (v0.7.6 behaviour)
//      and the running app stays up so the user can still work.
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
import cn.bywave.calendar.desktop.data.update.UpdateInstaller
import kotlinx.coroutines.launch

@Composable
fun UpdateDialog(onDismiss: () -> Unit) {
    val info = UpdateChecker.available.collectAsState().value
        // Renderer is only mounted when info != null, but null-check
        // defensively in case the dismiss races with state collection.
        ?: return
    val download by UpdateDownloader.state.collectAsState()
    val install by UpdateInstaller.state.collectAsState()
    // Observe locale so all dialog copy re-renders on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = androidx.compose.runtime.remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val scope = rememberCoroutineScope()
    val asset = UpdateChecker.platform?.let { info.assets[it] }

    // Chain: download Done → hand the file to UpdateInstaller. The
    // install path takes over from there (mounts DMG, spawns swap
    // script, exits the JVM). LaunchedEffect keyed on download
    // identity so a re-click on "重试" after a failure re-triggers
    // the chain.
    LaunchedEffect(download) {
        val d = download
        if (d is DownloadState.Done && install is UpdateInstaller.InstallState.Idle) {
            UpdateInstaller.install(d.file)
        }
    }

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
                    t("update.title"),
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
                        Text(t("update.installed"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                        Text("v${BuildInfo.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    }
                    Text("→", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.outline)
                    Column(modifier = Modifier.weight(1f).padding(start = 12.dp)) {
                        Text(t("update.newVersion"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        Text("v${info.versionName}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
                    }
                }

                if (info.notes.isNotBlank()) {
                    Text(t("update.releaseNotes"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.outline)
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
                            cn.bywave.calendar.desktop.i18n.I18n.t(
                                "update.noAssetForPlatform",
                                mapOf("os" to osLabel(UpdateChecker.platform)),
                            ),
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
                                    if (d.bytesTotal > 0) cn.bywave.calendar.desktop.i18n.I18n.t(
                                        "update.progress",
                                        mapOf("done" to fmtMB(d.bytesDone), "total" to fmtMB(d.bytesTotal), "pct" to pct),
                                    )
                                    else cn.bywave.calendar.desktop.i18n.I18n.t(
                                        "update.progressNoTotal",
                                        mapOf("done" to fmtMB(d.bytesDone)),
                                    ),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.outline,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                        }
                        is DownloadState.Done -> {
                            // Show the install-stage label. UpdateInstaller
                            // takes the file from here; states are:
                            //   Idle / Mounting / Swapping            — automated
                            //   FallbackOpenedInFinder / Failed        — manual
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Default.CheckCircle,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    when (val i = install) {
                                        UpdateInstaller.InstallState.Idle ->
                                            t("update.install.ready")
                                        UpdateInstaller.InstallState.Mounting ->
                                            t("update.install.mounting")
                                        UpdateInstaller.InstallState.Swapping ->
                                            t("update.install.swapping")
                                        is UpdateInstaller.InstallState.FallbackOpenedInFinder ->
                                            cn.bywave.calendar.desktop.i18n.I18n.t(
                                                "update.install.fallback",
                                                mapOf("reason" to i.reason, "dir" to d.file.parent),
                                            )
                                        is UpdateInstaller.InstallState.Failed ->
                                            i.message
                                    },
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
            // Button visible:
            //   - asset exists (we have a download URL for this OS)
            //   - download isn't currently in progress
            //   - install isn't currently in progress (Swapping → we're
            //     about to exit, no point in clicking anything)
            val showAction = asset != null
                && download !is DownloadState.Running
                && install !is UpdateInstaller.InstallState.Mounting
                && install !is UpdateInstaller.InstallState.Swapping
            if (showAction) {
                Button(onClick = {
                    UpdateDownloader.reset()
                    scope.launch {
                        // v0.7.7: download() — no implicit Finder open.
                        // The LaunchedEffect(download) collector above
                        // chains to UpdateInstaller.install() on Done.
                        UpdateDownloader.download(asset!!.url, asset.sha256.ifBlank { null })
                    }
                }) {
                    Text(when {
                        install is UpdateInstaller.InstallState.FallbackOpenedInFinder -> t("update.retryAuto")
                        download is DownloadState.Done -> t("update.redownload")
                        download is DownloadState.Failed -> t("update.retry")
                        else -> t("update.downloadButton")
                    })
                }
            }
        },
        dismissButton = {
            if (download !is DownloadState.Running) {
                TextButton(onClick = onDismiss) {
                    Text(if (info.mandatory) t("update.waitInstall") else t("update.notNow"))
                }
            }
        },
    )
}

private fun fmtMB(b: Long): String = "%.1f MB".format(b / 1024.0 / 1024.0)

private fun osLabel(p: String?): String = cn.bywave.calendar.desktop.i18n.I18n.t(
    when (p) {
        "mac" -> "update.os.mac"
        "win" -> "update.os.win"
        "linux" -> "update.os.linux"
        else -> "update.os.unknown"
    }
)
