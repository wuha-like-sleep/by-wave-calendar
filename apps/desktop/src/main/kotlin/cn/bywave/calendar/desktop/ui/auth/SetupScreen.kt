// Setup / sign-in screen for the desktop app. Two phases:
//
//   1. Server URL form. User types https://rl.lz-ss.com (or their own
//      ByWave deployment). On submit we POST /desktop-pair-init to
//      generate a one-time code.
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.model.Profile
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class Phase { ServerUrl, GeneratingCode, ShowingQr, Approved }

@Composable
fun SetupScreen(
    onSignedIn: () -> Unit,
) {
    var phase by remember { mutableStateOf(Phase.ServerUrl) }
    var serverUrl by remember { mutableStateOf("https://rl.lz-ss.com") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var pollMessage by remember { mutableStateOf("等待手机扫码…") }
    var code by remember { mutableStateOf<String?>(null) }
    var approveUrl by remember { mutableStateOf<String?>(null) }
    var client by remember { mutableStateOf<ApiClient?>(null) }
    val scope = rememberCoroutineScope()

    fun beginPairing() {
        errorMessage = null
        val normalized = serverUrl.trim().removeSuffix("/")
        if (!normalized.startsWith("http")) {
            errorMessage = "服务器地址要以 https:// 开头"
            return
        }
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
                errorMessage = e.localizedMessage ?: "无法连接服务器"
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
                is ApiClient.PairStatus.Pending -> { pollMessage = "等待手机扫码…" }
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
                    phase = Phase.Approved
                    onSignedIn()
                    return@LaunchedEffect
                }
                is ApiClient.PairStatus.Denied -> {
                    errorMessage = "已在手机上拒绝。如需登录请重新生成二维码。"
                    phase = Phase.ServerUrl
                    return@LaunchedEffect
                }
                is ApiClient.PairStatus.Expired -> {
                    errorMessage = "二维码已过期，请重新生成。"
                    phase = Phase.ServerUrl
                    return@LaunchedEffect
                }
                is ApiClient.PairStatus.Error -> {
                    pollMessage = "网络异常，正在重试… (${s.message})"
                }
            }
            delay(2_000)
        }
    }

    Box(
        modifier = Modifier.fillMaxSize().padding(48.dp),
        contentAlignment = Alignment.Center,
    ) {
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
                Text("正在请求二维码…", color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                Text("✓ 已登录", style = MaterialTheme.typography.headlineSmall)
                Text("正在打开你的日历…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ServerUrlPanel(
    serverUrl: String,
    onServerUrlChange: (String) -> Unit,
    errorMessage: String?,
    onContinue: () -> Unit,
) {
    Column(
        modifier = Modifier.width(420.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            "登录 ByWave Calendar",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            "请输入你的 ByWave 服务器地址。下一步会显示一个二维码，用手机扫码即可完成登录。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        OutlinedTextField(
            value = serverUrl,
            onValueChange = onServerUrlChange,
            label = { Text("服务器地址") },
            placeholder = { Text("https://rl.lz-ss.com") },
            singleLine = true,
            isError = errorMessage != null,
            supportingText = errorMessage?.let { { Text(it, color = MaterialTheme.colorScheme.error) } },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = onContinue,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            enabled = serverUrl.isNotBlank(),
        ) { Text("生成二维码", style = MaterialTheme.typography.titleSmall) }
    }
}

@Composable
private fun QrPanel(
    approveUrl: String,
    code: String,
    pollMessage: String,
    onRestart: () -> Unit,
) {
    val qr = remember(approveUrl) { qrBitmap(approveUrl, sizePx = 320) }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text(
            "用手机扫码登录",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            "用任何手机的相机或浏览器扫描下面的二维码，在手机上点「批准」即可登录此电脑。",
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
            Image(qr, contentDescription = "登录二维码", modifier = Modifier.size(320.dp))
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            Text(
                pollMessage,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            "授权码 $code · 5 分钟内有效",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )

        Spacer(Modifier.height(4.dp))

        TextButton(onClick = onRestart) { Text("重新生成 / 换服务器") }
    }
}
