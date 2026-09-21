// Setup / sign-in screen for the desktop app. Two phases:
//
//   1. Server URL form. User types their own ByWave deployment URL
//      (e.g. https://example.com). On submit we POST /desktop-pair-init
//      to generate a one-time code. Empty default — the desktop client
//      is server-agnostic so other people who self-host ByWave Calendar
//      can use the same binary against their own server.
//
//   2. QR + polling. We render the approveUrl as a QR code; the user
//      scans with their phone (any phone — opens approveUrl in a
//      browser where they're already logged in), taps "批准". We poll
//      /desktop-pair-status every 2s; when the response flips to
//      approved we hand the tokens to ProfileStore + transition.
//
// State machine is intentionally tiny: enum + a few mutableStateOf.
// No ViewModel because Compose Desktop doesn't have AndroidX VM, and
// for a single screen with linear state a plain object scoped to the
// composable is plenty.

package cn.bywave.calendar.desktop.ui.auth

import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.model.Profile
import cn.bywave.calendar.desktop.ui.theme.Dimens
import cn.bywave.calendar.desktop.util.userFacingError
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class Phase { ServerUrl, GeneratingCode, ShowingQr, Approved }

@Composable
fun SetupScreen(
    onSignedIn: () -> Unit,
) {
    var phase by remember { mutableStateOf(Phase.ServerUrl) }
    // Pre-fill from ProfileStore.lastServerUrl — the last URL the user
    // successfully paired with (or typed before crash). Empty on first
    // launch ever (per the open-source / server-agnostic policy: we
    // never hardcode the maintainer's own deployment).
    // Observe locale so the screen re-renders on language switch. Status
    // strings set imperatively below are resolved via I18n.t() at the time
    // they're assigned (transient pairing feedback; the panels themselves
    // observe locale for their static copy).
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val lastUrl by ProfileStore.lastServerUrl.collectAsState()
    var serverUrl by remember(lastUrl) { mutableStateOf(lastUrl) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var pollMessage by remember { mutableStateOf(cn.bywave.calendar.desktop.i18n.I18n.t("setup.pollWaiting")) }
    var code by remember { mutableStateOf<String?>(null) }
    var approveUrl by remember { mutableStateOf<String?>(null) }
    var client by remember { mutableStateOf<ApiClient?>(null) }
    val scope = rememberCoroutineScope()

    fun beginPairing() {
        errorMessage = null
        // Auto-prepend https:// when the user types a bare hostname. Mirrors
        // Android v0.9.1's behavior — common UX win because most users type
        // "example.com" not "https://example.com".
        var normalized = serverUrl.trim().removeSuffix("/")
        if (normalized.isEmpty()) {
            errorMessage = cn.bywave.calendar.desktop.i18n.I18n.t("setup.errorEmptyUrl")
            return
        }
        if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
            normalized = "https://$normalized"
        }
        // Persist immediately — even if pair-init fails the URL is still
        // pre-filled on next launch (saves users from re-typing).
        ProfileStore.rememberServerUrl(normalized)
        phase = Phase.GeneratingCode
        val c = ApiClient(normalized)
        client = c
        scope.launch {
            try {
                val resp = c.desktopPairInit()
                code = resp.code
                approveUrl = resp.approveUrl
                phase = Phase.ShowingQr
            } catch (e: Exception) {
                errorMessage = userFacingError(e, "setup.errorConnect")
                phase = Phase.ServerUrl
            }
        }
    }

    // Poll while the QR is visible. Cancels automatically when the user
    // navigates away from this composable, or when phase changes.
    LaunchedEffect(phase, code) {
        if (phase != Phase.ShowingQr) return@LaunchedEffect
        val c = client ?: return@LaunchedEffect
        val codeNow = code ?: return@LaunchedEffect
        while (true) {
            when (val s = c.desktopPairStatus(codeNow)) {
                is ApiClient.PairStatus.Pending -> { pollMessage = cn.bywave.calendar.desktop.i18n.I18n.t("setup.pollWaiting") }
                is ApiClient.PairStatus.Approved -> {
                    val r = s.resp
                    val profile = Profile(
                        serverUrl = c.serverUrl,
                        userId = r.userId.orEmpty(),
                        email = r.userEmail.orEmpty(),
                        displayName = r.userName,
                        deviceId = r.deviceId.orEmpty(),
                        refreshToken = r.refreshToken.orEmpty(),
                    )
                    ProfileStore.save(profile)
                    r.accessToken?.let(ProfileStore::setAccessToken)
                    // 重新登录成功 = 上一次被踢的事说完了，横幅该收掉。
                    ProfileStore.clearSignedOutReason()
                    phase = Phase.Approved
                    onSignedIn()
                    return@LaunchedEffect
                }
                is ApiClient.PairStatus.Denied -> {
                    errorMessage = cn.bywave.calendar.desktop.i18n.I18n.t("setup.denied")
                    phase = Phase.ServerUrl
                    return@LaunchedEffect
                }
                is ApiClient.PairStatus.Expired -> {
                    errorMessage = cn.bywave.calendar.desktop.i18n.I18n.t("setup.expired")
                    phase = Phase.ServerUrl
                    return@LaunchedEffect
                }
                is ApiClient.PairStatus.Error -> {
                    pollMessage = cn.bywave.calendar.desktop.i18n.I18n.t("setup.pollRetry", mapOf("message" to s.message))
                }
            }
            delay(2_000)
        }
    }

    // 竖向可滚动:二维码那一屏本身就有 ~600dp 高,窗口被拖矮时如果不滚动,
    // 「重新生成」按钮和授权码会被直接切在窗口外面,用户以为按钮没了。
    val outerScroll = rememberScrollState()
    // 被动登出的原因(改密码 / 设备被移除)。存的是 key,在这里才翻译,
    // 所以用户被踢之后再切语言,横幅也跟着变。
    val signedOutKey by ProfileStore.signedOutReasonKey.collectAsState()

    Box(
        modifier = Modifier.fillMaxSize().verticalScroll(outerScroll).padding(48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            signedOutKey?.let { key ->
                SignedOutBanner(
                    message = remember(locale, key) { cn.bywave.calendar.desktop.i18n.I18n.t(key) },
                )
            }
            when (phase) {
                Phase.ServerUrl -> ServerUrlPanel(
                    serverUrl = serverUrl,
                    onServerUrlChange = { serverUrl = it; errorMessage = null },
                    errorMessage = errorMessage,
                    onContinue = { beginPairing() },
                )
                Phase.GeneratingCode -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    CircularProgressIndicator()
                    Text(
                        remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("setup.requestingQr") },
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Phase.ShowingQr -> QrPanel(
                    approveUrl = approveUrl ?: "",
                    code = code ?: "",
                    pollMessage = pollMessage,
                    onRestart = {
                        code = null
                        approveUrl = null
                        phase = Phase.ServerUrl
                    },
                )
                Phase.Approved -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        "✓ " + remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("setup.signedIn") },
                        style = MaterialTheme.typography.headlineSmall,
                    )
                    Text(
                        remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("setup.openingCalendar") },
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** 「你被登出了」横幅。只在服务端吊销这台设备之后出现(改密码 / 重置密码 /
 *  后台移除设备)。放在登录页最上面,因为用户此刻唯一的疑问就是「我刚才好好的
 *  怎么回登录页了」。 */
@Composable
private fun SignedOutBanner(message: String) {
    Row(
        modifier = Modifier
            .widthIn(max = 460.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
}

@Composable
private fun ServerUrlPanel(
    serverUrl: String,
    onServerUrlChange: (String) -> Unit,
    errorMessage: String?,
    onContinue: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    Column(
        modifier = Modifier.width(420.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            t("setup.loginTitle"),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            t("setup.loginSubtitle"),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        OutlinedTextField(
            value = serverUrl,
            onValueChange = onServerUrlChange,
            label = { Text(t("setup.serverUrl")) },
            placeholder = { Text(t("setup.serverUrlPlaceholder")) },
            singleLine = true,
            isError = errorMessage != null,
            supportingText = errorMessage?.let { { Text(it, color = MaterialTheme.colorScheme.error) } },
            modifier = Modifier
                .fillMaxWidth()
                // 桌面端填完地址第一反应是敲回车,不是去点按钮。拦 KeyDown
                // (不是 KeyUp),否则这一下回车会穿透到刚出现的下一屏。
                .onPreviewKeyEvent { e ->
                    if (e.type == KeyEventType.KeyDown &&
                        (e.key == Key.Enter || e.key == Key.NumPadEnter) &&
                        serverUrl.isNotBlank()
                    ) {
                        onContinue(); true
                    } else {
                        false
                    }
                },
        )
        Button(
            onClick = onContinue,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            enabled = serverUrl.isNotBlank(),
        ) { Text(t("setup.generateQr"), style = MaterialTheme.typography.titleSmall) }
    }
}

@Composable
private fun QrPanel(
    approveUrl: String,
    code: String,
    pollMessage: String,
    onRestart: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val qr = remember(approveUrl) { qrBitmap(approveUrl, sizePx = 320) }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text(
            t("setup.qrTitle"),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            t("setup.qrSubtitle"),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.width(380.dp),
        )

        // The QR itself — white card around it gives a quiet zone that
        // helps phone cameras detect the pattern faster.
        Box(
            modifier = Modifier
                .size(360.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Color.White)
                .padding(20.dp),
            contentAlignment = Alignment.Center,
        ) {
            Image(qr, contentDescription = t("setup.qrContentDesc"), modifier = Modifier.size(320.dp))
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(Dimens.spinnerSmall),
                strokeWidth = Dimens.spinnerStroke,
            )
            Text(
                pollMessage,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            cn.bywave.calendar.desktop.i18n.I18n.t("setup.authCode", mapOf("code" to code)),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )

        Spacer(Modifier.height(4.dp))

        TextButton(onClick = onRestart) { Text(t("setup.regenerate")) }
    }
}
