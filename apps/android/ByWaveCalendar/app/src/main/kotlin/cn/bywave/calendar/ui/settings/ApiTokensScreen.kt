// ApiTokensScreen — personal API token management.
//
// Server contract (src/routes/devices.ts, device-bearer auth):
//   GET  /account/api-tokens             → { apiEnabled, limit,
//          limitReached, passwordSet, mfaEnabled, tokens: [...],
//          usage: { total, perDay, perToken } }
//   POST /account/api-tokens             → 201 { token, plain }
//   POST /account/api-tokens/{id}/rotate → { token, plain, oldExpiresAt }
//   POST /account/api-tokens/{id}/revoke → { ok: true }
//
// This mirrors the Web settings page exactly: creating a token needs a
// password step-up, a WRITE token on an MFA account additionally needs
// a fresh TOTP code, tokens are read-only by default, at most 5 active
// per user, expiry defaults to 365 days (0 = never), rotation keeps
// the old secret working for 7 days, and revocation is immediate. The
// full secret (`plain`) is shown exactly once after create / rotate
// and is never persisted — it lives in this screen's state only.

package cn.bywave.calendar.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.ApiTokenItem
import cn.bywave.calendar.data.model.ApiTokenStepUpRequest
import cn.bywave.calendar.data.model.ApiTokensResponse
import cn.bywave.calendar.data.model.CreateApiTokenRequest
import cn.bywave.calendar.ui.calendar.mutedTextColor
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** The machine code out of a token-endpoint failure. After the
 *  envelope interceptor, error bodies are `{ code, message }`; the
 *  flat legacy shape `{ error: "code" }` is accepted too. */
private fun apiTokenErrorCode(e: Throwable): String? {
    val http = e as? retrofit2.HttpException ?: return null
    val raw = runCatching { http.response()?.errorBody()?.string() }.getOrNull()
    if (raw.isNullOrBlank()) return null
    val obj = runCatching {
        Json { ignoreUnknownKeys = true }.parseToJsonElement(raw).jsonObject
    }.getOrNull() ?: return null
    runCatching { obj["code"]?.jsonPrimitive?.content }.getOrNull()?.let { return it }
    return runCatching { obj["error"]?.jsonPrimitive?.content }.getOrNull()
}

/** Localized copy for the token-endpoint failures the user can act on;
 *  anything else falls back to the server message / generic string. */
private fun apiTokenErrorText(
    context: android.content.Context,
    e: Throwable,
    fallbackRes: Int,
    limit: Int = 5,
): String = when (apiTokenErrorCode(e)) {
    "step_up_failed" -> context.getString(R.string.api_tokens_step_up_failed)
    "limit_reached" -> context.getString(R.string.api_tokens_limit_reached, limit)
    "api_disabled" -> context.getString(R.string.api_tokens_disabled)
    "step_up_unavailable" -> context.getString(R.string.api_tokens_need_admin)
    "rotate_expired" -> context.getString(R.string.api_tokens_rotate_expired)
    "not_found", "rotate_failed" -> context.getString(R.string.api_tokens_rotate_failed)
    else -> serverErrorMessage(e) ?: context.getString(fallbackRes)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApiTokensScreen(
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var data by remember { mutableStateOf<ApiTokensResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    // The one-time secret notice: (label, plain). Memory only.
    var freshSecret by remember { mutableStateOf<Pair<String, String>?>(null) }
    var revoking by remember { mutableStateOf<ApiTokenItem?>(null) }
    var rotating by remember { mutableStateOf<ApiTokenItem?>(null) }

    fun api() = run {
        val profile = BywaveApp.instance.profiles.active()
            ?: throw IllegalStateException(BywaveApp.instance.getString(R.string.cal_err_not_signed_in))
        ApiClient.forProfile(profile, BywaveApp.instance.profiles).api
    }

    suspend fun reload() {
        try {
            data = api().apiTokens()
            error = null
        } catch (e: Exception) {
            error = apiTokenErrorText(context, e, R.string.api_tokens_load_failed)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reload() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.api_tokens_title)) },
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
            Text(
                text = stringResource(R.string.api_tokens_desc),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )

            if (loading) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(10.dp))
                    Text(stringResource(R.string.api_tokens_loading), color = mutedTextColor())
                }
            }

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { scope.launch { loading = true; reload() } }) {
                    Text(stringResource(R.string.action_retry))
                }
            }

            val d = data
            if (!loading && d != null) {
                freshSecret?.let { (label, plain) ->
                    NewApiTokenCard(
                        label = label,
                        plain = plain,
                        onDone = { freshSecret = null },
                    )
                }
                if (!d.apiEnabled) {
                    Text(
                        text = stringResource(R.string.api_tokens_disabled),
                        style = MaterialTheme.typography.bodyMedium,
                        color = mutedTextColor(),
                    )
                } else {
                    if (d.tokens.isEmpty()) {
                        Text(
                            text = stringResource(R.string.api_tokens_empty),
                            style = MaterialTheme.typography.bodyMedium,
                            color = mutedTextColor(),
                        )
                    } else {
                        d.tokens.forEach { token ->
                            ApiTokenCard(
                                token = token,
                                onRotate = { rotating = token },
                                onRevoke = { revoking = token },
                            )
                        }
                    }
                    ApiTokenUsageCard(usage = d.usage)
                    when {
                        d.passwordSet == false && !d.mfaEnabled -> {
                            Text(
                                text = stringResource(R.string.api_tokens_need_admin),
                                style = MaterialTheme.typography.bodySmall,
                                color = mutedTextColor(),
                            )
                        }
                        d.limitReached -> {
                            Text(
                                text = stringResource(R.string.api_tokens_limit_reached, d.limit),
                                style = MaterialTheme.typography.bodySmall,
                                color = mutedTextColor(),
                            )
                        }
                        else -> {
                            CreateApiTokenCard(
                                data = d,
                                onCreate = { labelText, writeScope, expiry, password, mfa ->
                                    val created = api().createApiToken(
                                        CreateApiTokenRequest(
                                            label = labelText,
                                            scope = if (writeScope) "write" else "read",
                                            expiresInDays = expiry,
                                            currentPassword = password,
                                            mfaCode = mfa,
                                        ),
                                    )
                                    freshSecret = created.token.label to created.plain
                                    reload()
                                },
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.size(24.dp))
        }
    }

    revoking?.let { token ->
        var working by remember { mutableStateOf(false) }
        var dialogError by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!working) revoking = null },
            title = { Text(token.label) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.api_tokens_revoke_confirm))
                    dialogError?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        working = true
                        dialogError = null
                        scope.launch {
                            try {
                                api().revokeApiToken(token.id)
                                revoking = null
                                reload()
                            } catch (e: Exception) {
                                dialogError = apiTokenErrorText(context, e, R.string.api_tokens_revoke_failed)
                            } finally {
                                working = false
                            }
                        }
                    },
                    enabled = !working,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) {
                    Text(stringResource(R.string.api_tokens_revoke))
                }
            },
            dismissButton = {
                TextButton(onClick = { revoking = null }, enabled = !working) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    rotating?.let { token ->
        val d = data
        var password by remember { mutableStateOf("") }
        var mfaCode by remember { mutableStateOf("") }
        var working by remember { mutableStateOf(false) }
        var dialogError by remember { mutableStateOf<String?>(null) }
        val passwordSet = d?.passwordSet
        val mfaEnabled = d?.mfaEnabled == true
        val stepUpReady = when {
            passwordSet == true ->
                password.isNotBlank() && (token.scope != "write" || !mfaEnabled || mfaCode.isNotBlank())
            passwordSet == false -> mfaCode.isNotBlank()
            else -> password.isNotBlank() || mfaCode.isNotBlank()
        }
        AlertDialog(
            onDismissRequest = { if (!working) rotating = null },
            title = { Text(token.label) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        stringResource(R.string.api_tokens_rotate_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                    )
                    if (passwordSet != false) {
                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it },
                            label = { Text(stringResource(R.string.api_tokens_current_password)) },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (mfaEnabled) {
                        OutlinedTextField(
                            value = mfaCode,
                            onValueChange = { mfaCode = it },
                            label = { Text(stringResource(R.string.api_tokens_mfa_code)) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    dialogError?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        working = true
                        dialogError = null
                        scope.launch {
                            try {
                                val rotated = api().rotateApiToken(
                                    token.id,
                                    ApiTokenStepUpRequest(
                                        currentPassword = password.ifBlank { null },
                                        mfaCode = mfaCode.trim().ifBlank { null },
                                    ),
                                )
                                rotating = null
                                freshSecret = rotated.token.label to rotated.plain
                                reload()
                            } catch (e: Exception) {
                                dialogError = apiTokenErrorText(context, e, R.string.api_tokens_rotate_failed)
                            } finally {
                                working = false
                            }
                        }
                    },
                    enabled = !working && stepUpReady,
                ) {
                    Text(stringResource(R.string.api_tokens_rotate))
                }
            },
            dismissButton = {
                TextButton(onClick = { rotating = null }, enabled = !working) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

/** One token card: label + scope badge (+ expired / grace badges),
 *  prefix, created / last-used / use-count meta, the expiry or grace
 *  line, and rotate / revoke. Rotate hides for expired tokens and for
 *  tokens already in their rotation grace — the Web page's rule. */
@Composable
private fun ApiTokenCard(
    token: ApiTokenItem,
    onRotate: () -> Unit,
    onRevoke: () -> Unit,
) {
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
                text = token.label,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = stringResource(
                    if (token.scope == "write") R.string.api_tokens_scope_write
                    else R.string.api_tokens_scope_read,
                ),
                style = MaterialTheme.typography.labelMedium,
                color = if (token.scope == "write") MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
            )
            if (token.expired) {
                Spacer(Modifier.size(8.dp))
                Text(
                    text = stringResource(R.string.api_tokens_expired),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            if (token.inGrace) {
                Spacer(Modifier.size(8.dp))
                Text(
                    text = stringResource(R.string.api_tokens_grace_badge),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        Text(
            text = token.prefix + "…",
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = mutedTextColor(),
        )
        val meta = StringBuilder()
        formatTokenInstant(token.createdAt)?.let {
            meta.append(stringResource(R.string.api_tokens_created, it))
        }
        if (meta.isNotEmpty()) meta.append(" · ")
        val lastUsed = formatTokenInstant(token.lastUsedAt)
        if (lastUsed != null) {
            meta.append(stringResource(R.string.api_tokens_last_used, lastUsed))
            if (!token.lastUsedIp.isNullOrBlank()) {
                meta.append(" · ").append(token.lastUsedIp)
            }
        } else {
            meta.append(stringResource(R.string.api_tokens_never_used))
        }
        meta.append(" · ").append(stringResource(R.string.api_tokens_use_count, token.useCount))
        Text(
            text = meta.toString(),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        val expiryLine = when {
            token.inGrace && token.expiresAt != null ->
                stringResource(R.string.api_tokens_grace_until, formatTokenInstant(token.expiresAt) ?: token.expiresAt)
            token.expiresAt != null ->
                stringResource(R.string.api_tokens_expires, formatTokenInstant(token.expiresAt) ?: token.expiresAt)
            else -> stringResource(R.string.api_tokens_never_expires)
        }
        Text(
            text = expiryLine,
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        Row {
            Spacer(Modifier.weight(1f))
            if (!token.expired && !token.inGrace) {
                TextButton(onClick = onRotate) {
                    Text(stringResource(R.string.api_tokens_rotate))
                }
            }
            TextButton(onClick = onRevoke) {
                Text(
                    stringResource(R.string.api_tokens_revoke),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

/** The 30-day usage view from the same GET response the Web page uses:
 *  total line, a simple per-day bar strip, and per-token counts. */
@Composable
private fun ApiTokenUsageCard(usage: cn.bywave.calendar.data.model.ApiTokenUsage) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = stringResource(R.string.api_tokens_usage_title),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        if (usage.total == 0) {
            Text(
                text = stringResource(R.string.api_tokens_usage_empty),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )
        } else {
            Text(
                text = stringResource(R.string.api_tokens_usage_total, usage.total),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )
            val maxCount = usage.perDay.maxOfOrNull { it.count } ?: 0
            Row(
                modifier = Modifier.fillMaxWidth().height(44.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                usage.perDay.forEach { day ->
                    val frac = if (maxCount > 0) day.count.toFloat() / maxCount else 0f
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height((44f * frac).dp.coerceAtLeast(if (day.count > 0) 3.dp else 1.dp))
                            .background(
                                if (day.count > 0) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.surface,
                                RoundedCornerShape(topStart = 2.dp, topEnd = 2.dp),
                            ),
                    )
                }
            }
            usage.perToken.filter { it.count > 0 }.forEach { row ->
                Row(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = row.label,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = stringResource(R.string.api_tokens_use_count, row.count),
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                    )
                }
            }
        }
    }
}

/** The show-once secret card after a create / rotate. The plain token
 *  sits in a read-only field (selectable) with a Copy button; Done
 *  drops the only in-memory copy. */
@Composable
private fun NewApiTokenCard(
    label: String,
    plain: String,
    onDone: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = stringResource(R.string.api_tokens_new_token_heading, label),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        OutlinedTextField(
            value = plain,
            onValueChange = {},
            readOnly = true,
            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            text = stringResource(R.string.api_tokens_new_token_hint),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = {
                clipboard.setText(AnnotatedString(plain))
                copied = true
            }) {
                Text(
                    stringResource(
                        if (copied) R.string.api_tokens_copied else R.string.api_tokens_copy,
                    ),
                )
            }
            Spacer(Modifier.size(8.dp))
            TextButton(onClick = onDone) {
                Text(stringResource(R.string.action_done))
            }
        }
    }
}

/** The create form. Which step-up fields render follows the GET
 *  response, exactly like the Web page: password field when the
 *  account has (or may have) a password, MFA field when MFA is on.
 *  Scope defaults to read-only; expiry defaults to 365 (0 = never). */
@Composable
private fun CreateApiTokenCard(
    data: ApiTokensResponse,
    onCreate: suspend (label: String, writeScope: Boolean, expiryDays: Int, password: String?, mfaCode: String?) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var label by remember { mutableStateOf("") }
    var writeScope by remember { mutableStateOf(false) }
    var expiryDays by remember { mutableStateOf("365") }
    var password by remember { mutableStateOf("") }
    var mfaCode by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    val expiryValue = expiryDays.toIntOrNull()
    val expiryValid = expiryValue != null && expiryValue in 0..3650
    // Local gating mirrors the server's step-up rules so a blank
    // required field doesn't cost a round-trip; the server stays the
    // authority and its verdicts surface via errorMsg.
    val stepUpReady = when {
        data.passwordSet == true ->
            password.isNotBlank() && (!writeScope || !data.mfaEnabled || mfaCode.isNotBlank())
        data.passwordSet == false -> mfaCode.isNotBlank()
        else -> password.isNotBlank() || mfaCode.isNotBlank()
    }
    val canSubmit = !working && label.isNotBlank() && expiryValid && stepUpReady

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = stringResource(R.string.api_tokens_create),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        OutlinedTextField(
            value = label,
            onValueChange = { label = it },
            label = { Text(stringResource(R.string.api_tokens_label_placeholder)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            text = stringResource(R.string.api_tokens_scope),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected = !writeScope, onClick = { writeScope = false })
            Text(stringResource(R.string.api_tokens_scope_read))
            Spacer(Modifier.size(16.dp))
            RadioButton(selected = writeScope, onClick = { writeScope = true })
            Text(stringResource(R.string.api_tokens_scope_write))
        }
        if (writeScope) {
            Text(
                text = stringResource(R.string.api_tokens_scope_write_hint),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )
        }
        OutlinedTextField(
            value = expiryDays,
            onValueChange = { v -> expiryDays = v.filter { it.isDigit() }.take(4) },
            label = { Text(stringResource(R.string.api_tokens_expiry_label)) },
            singleLine = true,
            isError = expiryDays.isNotEmpty() && !expiryValid,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            text = stringResource(R.string.api_tokens_expiry_hint),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        if (data.passwordSet != false) {
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text(stringResource(R.string.api_tokens_current_password)) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (data.mfaEnabled) {
            OutlinedTextField(
                value = mfaCode,
                onValueChange = { mfaCode = it },
                label = { Text(stringResource(R.string.api_tokens_mfa_code)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Text(
            text = stringResource(R.string.api_tokens_step_up_hint),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        errorMsg?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Button(
            onClick = {
                working = true
                errorMsg = null
                scope.launch {
                    try {
                        onCreate(
                            label.trim(),
                            writeScope,
                            expiryValue ?: 365,
                            password.ifBlank { null },
                            mfaCode.trim().ifBlank { null },
                        )
                    } catch (e: Exception) {
                        errorMsg = apiTokenErrorText(context, e, R.string.api_tokens_create_failed, data.limit)
                    } finally {
                        working = false
                    }
                }
            },
            enabled = canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (working) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(stringResource(R.string.api_tokens_create))
        }
    }
}

/** ISO 8601 instant → the user's locale date+time, or null when the
 *  server sent nothing parseable (the row just omits the line). */
private fun formatTokenInstant(iso: String?): String? {
    if (iso.isNullOrBlank()) return null
    return runCatching {
        DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
            .withLocale(Locale.getDefault())
            .format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
    }.getOrNull()
}
