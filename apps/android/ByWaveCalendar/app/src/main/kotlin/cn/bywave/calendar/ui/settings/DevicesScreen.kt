// DevicesScreen — signed-in device / session management.
//
// Server contract (src/routes/devices.ts, bearer-auth):
//   GET    /devices      → { devices: [{ id, label, kind, prefix,
//                          appVersion, lastSeenAt, lastSeenIp,
//                          firstSeenIp, createdAt }] }
//   GET    /devices/me   → { id, label, kind, hasPushToken } — which
//                          row THIS token belongs to (badge source)
//   DELETE /devices/{id} → { ok: true }
//
// Revoking a device kills its refresh token immediately. Revoking the
// CURRENT device therefore signs this phone out server-side too, so
// after a successful delete we follow the existing local sign-out
// path (the same one 设置 → 退出登录 uses: cache wipe + profile
// removal + back to setup/calendar) instead of leaving a zombie
// session whose every write fails with 401.

package cn.bywave.calendar.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.DeviceItem
import cn.bywave.calendar.ui.calendar.mutedTextColor
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen(
    onBack: () -> Unit,
    onSignOut: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    val devices = remember { mutableStateListOf<DeviceItem>() }
    var currentDeviceId by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var revoking by remember { mutableStateOf<DeviceItem?>(null) }

    fun api() = run {
        val profile = BywaveApp.instance.profiles.active()
            ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
        ApiClient.forProfile(profile, BywaveApp.instance.profiles).api
    }

    suspend fun reload() {
        try {
            val api = api()
            val list = api.devices().devices
            devices.clear()
            devices.addAll(list)
            // /devices/me is badge-only: a non-device bearer (API token)
            // may have no row, and that must not fail the whole page.
            currentDeviceId = runCatching { api.currentDevice().id }.getOrNull()
            error = null
        } catch (e: Exception) {
            error = serverErrorMessage(e) ?: context.getString(R.string.devices_load_failed)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reload() }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_devices_row)) },
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
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Spacer(Modifier.size(4.dp))

            if (loading) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            } else if (devices.isEmpty() && error == null) {
                Text(
                    text = stringResource(R.string.devices_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = mutedTextColor(),
                )
            } else {
                devices.forEach { d ->
                    val isCurrent = d.id == currentDeviceId
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = d.label?.takeIf { it.isNotBlank() }
                                    ?: stringResource(R.string.devices_unknown_label),
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.Medium,
                                modifier = Modifier.weight(1f),
                            )
                            if (isCurrent) {
                                Text(
                                    text = stringResource(R.string.devices_current_badge),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                        }
                        val meta = listOfNotNull(
                            d.kind?.takeIf { it.isNotBlank() },
                            d.appVersion?.takeIf { it.isNotBlank() }?.let { "v$it" },
                        ).joinToString(" · ")
                        if (meta.isNotBlank()) {
                            Text(
                                text = meta,
                                style = MaterialTheme.typography.bodySmall,
                                color = mutedTextColor(),
                            )
                        }
                        formatDeviceInstant(d.lastSeenAt)?.let { seen ->
                            Text(
                                text = stringResource(R.string.devices_last_seen, seen),
                                style = MaterialTheme.typography.bodySmall,
                                color = mutedTextColor(),
                            )
                        }
                        Row {
                            Spacer(Modifier.weight(1f))
                            TextButton(
                                onClick = { revoking = d },
                                enabled = !working,
                            ) {
                                Text(
                                    stringResource(R.string.devices_revoke),
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    }
                }
            }

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Spacer(Modifier.size(24.dp))
        }
    }

    val toRevoke = revoking
    if (toRevoke != null) {
        val isCurrent = toRevoke.id == currentDeviceId
        AlertDialog(
            onDismissRequest = { revoking = null },
            title = { Text(stringResource(R.string.devices_revoke_title)) },
            text = {
                Text(
                    if (isCurrent) stringResource(R.string.devices_revoke_current_message)
                    else stringResource(
                        R.string.devices_revoke_message,
                        toRevoke.label?.takeIf { it.isNotBlank() }
                            ?: stringResource(R.string.devices_unknown_label),
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        revoking = null
                        scope.launch {
                            working = true
                            error = null
                            try {
                                api().revokeDevice(toRevoke.id)
                                if (isCurrent) {
                                    // This phone's refresh token is now
                                    // dead server-side — leave through the
                                    // normal sign-out path (wipes cache,
                                    // alarms, mirror and the profile).
                                    onSignOut()
                                } else {
                                    snackbar.showSnackbar(context.getString(R.string.devices_revoked))
                                    reload()
                                }
                            } catch (e: Exception) {
                                error = serverErrorMessage(e)
                                    ?: context.getString(R.string.devices_revoke_failed)
                            } finally {
                                working = false
                            }
                        }
                    },
                ) {
                    Text(
                        stringResource(R.string.devices_revoke),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { revoking = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

/** ISO 8601 instant → the user's locale date+time, or null when the
 *  server sent nothing parseable (the row just omits the line). */
private fun formatDeviceInstant(iso: String?): String? {
    if (iso.isNullOrBlank()) return null
    return runCatching {
        DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
            .withLocale(Locale.getDefault())
            .format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
    }.getOrNull()
}
