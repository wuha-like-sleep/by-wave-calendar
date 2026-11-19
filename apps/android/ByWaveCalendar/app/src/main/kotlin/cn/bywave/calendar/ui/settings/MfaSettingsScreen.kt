// MfaSettingsScreen — native two-step verification management.
//
// Server contract (src/routes/devices.ts, bearer-auth, bare bodies):
//   POST /account/mfa/setup   → { otpauthUri, secret }; 409 already_enabled
//   POST /account/mfa/verify  { code } → { ok: true, backupCodes: [...] };
//                               wrong code → 403 invalid_code
//   POST /account/mfa/disable { password, code } → { ok: true };
//                               wrong password/code → 403
//
// There is no mfaEnabled field for the client to read: /auth/me
// returns only id / email / displayName / isAdmin and LoginResponse
// has no MFA flag (verified in code). So, like iOS MfaSettingsPage,
// opening this screen PROBES setup: a 200 hands us the pending secret
// to display, a 409 tells us MFA is already on and we show the
// disable form instead. Probing setup when MFA is off merely rotates
// the pending secret — harmless if the user backs out.

package cn.bywave.calendar.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.AccountMfaVerifyRequest
import cn.bywave.calendar.data.model.MfaDisableRequest
import cn.bywave.calendar.data.model.MfaSetupResponse
import cn.bywave.calendar.ui.calendar.mutedTextColor
import kotlinx.coroutines.launch
import retrofit2.HttpException

private enum class MfaPhase { LOADING, SETUP, BACKUP_CODES, ENABLED, LOAD_ERROR }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MfaSettingsScreen(onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val snackbar = remember { SnackbarHostState() }

    var phase by remember { mutableStateOf(MfaPhase.LOADING) }
    var setup by remember { mutableStateOf<MfaSetupResponse?>(null) }
    var backupCodes by remember { mutableStateOf<List<String>>(emptyList()) }
    var code by remember { mutableStateOf("") }
    var disablePassword by remember { mutableStateOf("") }
    var disableCode by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun api() = run {
        val profile = BywaveApp.instance.profiles.active()
            ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
        ApiClient.forProfile(profile, BywaveApp.instance.profiles).api
    }

    // Probe: setup doubles as the status check (see file header).
    suspend fun probe() {
        phase = MfaPhase.LOADING
        error = null
        try {
            setup = api().mfaSetup()
            phase = MfaPhase.SETUP
        } catch (e: HttpException) {
            if (e.code() == 409) {
                phase = MfaPhase.ENABLED
            } else {
                error = serverErrorMessage(e) ?: context.getString(R.string.mfa_settings_load_failed)
                phase = MfaPhase.LOAD_ERROR
            }
        } catch (e: Exception) {
            error = serverErrorMessage(e) ?: context.getString(R.string.mfa_settings_load_failed)
            phase = MfaPhase.LOAD_ERROR
        }
    }

    LaunchedEffect(Unit) { probe() }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.mfa_title)) },
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
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Spacer(Modifier.size(4.dp))

            when (phase) {
                MfaPhase.LOADING -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                }

                MfaPhase.LOAD_ERROR -> {
                    error?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    }
                    OutlinedButton(
                        onClick = { scope.launch { probe() } },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.eventedit_retry)) }
                }

                MfaPhase.SETUP -> {
                    val s = setup
                    Text(
                        text = stringResource(R.string.mfa_settings_setup_intro),
                        style = MaterialTheme.typography.bodyMedium,
                        color = mutedTextColor(),
                    )
                    if (s != null) {
                        CopyableValue(
                            label = stringResource(R.string.mfa_settings_secret_label),
                            value = s.secret,
                            onCopy = {
                                clipboard.setText(AnnotatedString(s.secret))
                                scope.launch { snackbar.showSnackbar(context.getString(R.string.mfa_settings_copied)) }
                            },
                        )
                        CopyableValue(
                            label = stringResource(R.string.mfa_settings_otpauth_label),
                            value = s.otpauthUri,
                            onCopy = {
                                clipboard.setText(AnnotatedString(s.otpauthUri))
                                scope.launch { snackbar.showSnackbar(context.getString(R.string.mfa_settings_copied)) }
                            },
                        )
                    }
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it.filter { c -> c.isDigit() }.take(8) },
                        label = { Text(stringResource(R.string.mfa_settings_code_label)) },
                        placeholder = { Text(stringResource(R.string.mfa_placeholder)) },
                        singleLine = true,
                        enabled = !busy,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    error?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    Button(
                        onClick = {
                            scope.launch {
                                busy = true
                                error = null
                                try {
                                    val resp = api().mfaVerify(AccountMfaVerifyRequest(code = code))
                                    backupCodes = resp.backupCodes
                                    phase = MfaPhase.BACKUP_CODES
                                } catch (e: Exception) {
                                    error = serverErrorMessage(e)
                                        ?: context.getString(R.string.mfa_settings_failed)
                                } finally {
                                    busy = false
                                }
                            }
                        },
                        enabled = !busy && code.length >= 6,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (busy) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                        } else {
                            Text(stringResource(R.string.mfa_settings_verify_button))
                        }
                    }
                }

                MfaPhase.BACKUP_CODES -> {
                    Text(
                        text = stringResource(R.string.mfa_settings_backup_title),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = stringResource(R.string.mfa_settings_backup_warn),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                    backupCodes.forEach { c ->
                        Text(
                            text = c,
                            style = MaterialTheme.typography.bodyLarge,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    OutlinedButton(
                        onClick = {
                            clipboard.setText(AnnotatedString(backupCodes.joinToString("\n")))
                            scope.launch { snackbar.showSnackbar(context.getString(R.string.mfa_settings_copied)) }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(6.dp))
                        Text(stringResource(R.string.mfa_settings_backup_copy_all))
                    }
                    Button(
                        onClick = onBack,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.mfa_settings_backup_done)) }
                }

                MfaPhase.ENABLED -> {
                    Text(
                        text = stringResource(R.string.mfa_settings_enabled_note),
                        style = MaterialTheme.typography.bodyMedium,
                        color = mutedTextColor(),
                    )
                    OutlinedTextField(
                        value = disablePassword,
                        onValueChange = { disablePassword = it },
                        label = { Text(stringResource(R.string.password_current)) },
                        singleLine = true,
                        enabled = !busy,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = disableCode,
                        onValueChange = { disableCode = it.filter { c -> c.isDigit() }.take(8) },
                        label = { Text(stringResource(R.string.mfa_settings_code_label)) },
                        placeholder = { Text(stringResource(R.string.mfa_placeholder)) },
                        singleLine = true,
                        enabled = !busy,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    error?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    Button(
                        onClick = {
                            scope.launch {
                                busy = true
                                error = null
                                try {
                                    api().mfaDisable(
                                        MfaDisableRequest(password = disablePassword, code = disableCode),
                                    )
                                    snackbar.showSnackbar(context.getString(R.string.mfa_settings_disabled_toast))
                                    onBack()
                                } catch (e: Exception) {
                                    error = serverErrorMessage(e)
                                        ?: context.getString(R.string.mfa_settings_failed)
                                } finally {
                                    busy = false
                                }
                            }
                        },
                        enabled = !busy && disablePassword.isNotEmpty() && disableCode.length >= 6,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError,
                        ),
                    ) {
                        if (busy) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onError,
                            )
                        } else {
                            Text(stringResource(R.string.mfa_settings_disable_button))
                        }
                    }
                }
            }

            Spacer(Modifier.size(24.dp))
        }
    }
}

/** A label + monospace value + copy button row (secret / otpauth URI). */
@Composable
private fun CopyableValue(
    label: String,
    value: String,
    onCopy: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onCopy) {
                Icon(
                    Icons.Default.ContentCopy,
                    contentDescription = stringResource(R.string.share_links_copy),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            fontFamily = FontFamily.Monospace,
        )
    }
}
