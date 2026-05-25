// The bottom sheet that surfaces when UpdateChecker has a new release
// ready. Walks the user through: see notes → tap "立即下载" → progress
// bar → tap "立即安装" → system installer takes over.
//
// Three branches:
//   - Voluntary: user can swipe-dismiss or tap "稍后", which marks
//     this versionCode as dismissed in UpdateChecker.
//   - Mandatory: dismissal disabled. Sheet covers the whole screen
//     and the only way out is to install (or kill the APP).
//   - Re-installing same version: if a verified APK is already in
//     cache from a previous attempt, we skip straight to "立即安装".

package cn.bywave.calendar.update

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UpdateAvailableSheet(
    release: AndroidReleaseDto,
    mandatory: Boolean,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(
        // For mandatory updates: don't let the user scroll past the
        // sheet into the dismissed state. They can still kill the APP.
        skipPartiallyExpanded = mandatory,
    )

    // Progress / status of the download. Kept in a local Flow so
    // recomposition doesn't restart the download every time.
    val statusFlow = remember { MutableStateFlow<DownloadProgress?>(null) }
    val status by statusFlow.collectAsState()

    // If a verified APK is already in cache from a prior attempt, jump
    // straight to "ready to install" state.
    LaunchedEffect(release.versionCode) {
        ApkDownloader.verifiedCachedFile(context, release)?.let { f ->
            statusFlow.value = DownloadProgress.Done(f)
        }
    }

    var unknownSourcesError by remember { mutableStateOf<String?>(null) }
    val unknownSourcesLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        // Regardless of result, just retry installing. If the user
        // still didn't grant the permission they'll get the same
        // settings prompt — at least it's no worse than where we
        // started.
        val done = status as? DownloadProgress.Done
        if (done != null) {
            when (val r = ApkInstaller.install(context, done.file)) {
                is InstallResult.Failed -> unknownSourcesError = r.message
                is InstallResult.NeedsUnknownSources ->
                    unknownSourcesError = "请在系统设置中允许「ByWave 日历」安装未知来源应用"
                InstallResult.Launched -> { /* system takes over */ }
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = {
            // Voluntary updates: swipe-dismiss is fine.
            // Mandatory: ignore the dismiss request, force a re-show
            // (Material 3 doesn't actually have a "can't dismiss" flag
            // for ModalBottomSheet; we work around by no-op'ing the
            // dismiss request — UpdateChecker.state stays Available so
            // the sheet recomposes immediately).
            if (!mandatory) {
                UpdateChecker.onUserDismissed()
                onDismiss()
            }
        },
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
        ) {
            Text(
                text = if (mandatory) "需要更新" else "发现新版本",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "v${release.versionName}" +
                    if (release.sizeBytes > 0) " · ${(release.sizeBytes / 1024 / 1024)} MB" else "",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (mandatory) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "这是一次必要的升级，请安装后继续使用。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Spacer(Modifier.height(16.dp))

            // Release notes — scrollable in case they're long.
            if (release.notes.isNotBlank()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightInUpdate(release.notes)
                        .verticalScroll(rememberScrollState()),
                ) {
                    Text(
                        text = release.notes,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Spacer(Modifier.height(20.dp))
            }

            // Status / action area.
            val s = status
            when (s) {
                null -> {
                    // Idle — show download button.
                    Button(
                        onClick = {
                            scope.launch {
                                ApkDownloader.download(context, release).collect { p ->
                                    statusFlow.value = p
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("立即下载") }
                    if (!mandatory) {
                        Spacer(Modifier.height(4.dp))
                        TextButton(
                            onClick = {
                                UpdateChecker.onUserDismissed()
                                onDismiss()
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("稍后") }
                    }
                }
                is DownloadProgress.Downloading -> {
                    LinearProgressIndicator(
                        progress = { s.fraction.coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "已下载 ${(s.bytesRead / 1024 / 1024)} / ${(s.totalBytes / 1024 / 1024).coerceAtLeast(1)} MB",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                is DownloadProgress.Done -> {
                    if (unknownSourcesError != null) {
                        Text(
                            text = unknownSourcesError!!,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(12.dp))
                    }
                    Button(
                        onClick = {
                            when (val r = ApkInstaller.install(context, s.file)) {
                                is InstallResult.Launched -> { /* system installer takes over */ }
                                is InstallResult.NeedsUnknownSources -> {
                                    // Launch settings so user can grant.
                                    unknownSourcesLauncher.launch(r.settingsIntent)
                                }
                                is InstallResult.Failed -> {
                                    unknownSourcesError = r.message
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("立即安装") }
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "系统会弹出安装确认对话框，首次升级还需要在设置里允许「安装未知应用」",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                is DownloadProgress.Failed -> {
                    Text(
                        text = s.message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = {
                                statusFlow.value = null  // Reset to idle, user can retry
                            },
                            modifier = Modifier.weight(1f),
                        ) { Text("重试") }
                        if (!mandatory) {
                            TextButton(
                                onClick = {
                                    UpdateChecker.onUserDismissed()
                                    onDismiss()
                                },
                                modifier = Modifier.weight(1f),
                            ) { Text("稍后") }
                        }
                    }
                }
            }
        }
    }
}

// Cap the release-notes box at ~30% of the screen height so very long
// notes don't push the action button below the fold.
@Composable
private fun Modifier.heightInUpdate(notes: String): Modifier {
    val lines = notes.count { it == '\n' } + 1
    // Heuristic: ~22dp per line, max 180dp.
    val target = (lines * 22).coerceIn(44, 180)
    return this.then(Modifier.height(target.dp))
}
