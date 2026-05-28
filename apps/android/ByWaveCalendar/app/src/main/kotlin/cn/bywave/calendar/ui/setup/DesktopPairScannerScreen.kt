// Wrapper around ScannerScreen specifically for the "scan a desktop's
// pair-init QR and approve it" flow. The desktop's QR encodes a plain
// HTTPS URL `<server>/desktop-pair/<code>` (so a phone with no APP
// installed can still scan it with the system camera and approve via
// the web flow). When the user is logged in to the APP, scanning here
// short-circuits the browser bounce: we extract <code> + POST to
// /api/v1/devices/desktop-pair-approve with our access token.
//
// Showing a result sheet (success / error / not-a-desktop-pair-qr)
// before popping back gives the user feedback that the desktop is
// actually logging in now.

package cn.bywave.calendar.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.DesktopPairApproveRequest
import kotlinx.coroutines.launch

private sealed class ApproveResult {
    object Idle : ApproveResult()
    object Sending : ApproveResult()
    object Success : ApproveResult()
    data class Error(val message: String) : ApproveResult()
    /** QR didn't match the desktop-pair URL pattern — likely the
     *  pair-claim QR (which belongs in the setup screen, not here)
     *  or some random barcode. Tell the user, let them try again. */
    object NotDesktopPair : ApproveResult()
}

@Composable
fun DesktopPairScannerScreen(
    onClose: () -> Unit,
) {
    var result by remember { mutableStateOf<ApproveResult>(ApproveResult.Idle) }
    val scope = rememberCoroutineScope()

    // ScannerScreen fires onResult exactly once (it locks after first
    // detection). After we settle the approve call, the AlertDialog
    // handles the rest of the flow.
    ScannerScreen(
        onResult = { raw ->
            val code = extractDesktopPairCode(raw)
            if (code == null) {
                result = ApproveResult.NotDesktopPair
                return@ScannerScreen
            }
            result = ApproveResult.Sending
            scope.launch {
                try {
                    val profiles = BywaveApp.instance.profiles
                    val profile = profiles.active()
                        ?: throw IllegalStateException("未登录，请先登录后再扫码")
                    val client = ApiClient.forProfile(profile, profiles)
                    client.api.desktopPairApprove(DesktopPairApproveRequest(code = code))
                    result = ApproveResult.Success
                } catch (e: Exception) {
                    result = ApproveResult.Error(e.localizedMessage ?: "批准失败")
                }
            }
        },
        onCancel = onClose,
    )

    // Result sheet — covers the success / error / not-recognized cases.
    when (val r = result) {
        ApproveResult.Idle -> Unit
        ApproveResult.Sending -> AlertDialog(
            onDismissRequest = {},
            title = { Text("正在批准…", fontWeight = FontWeight.SemiBold) },
            text = { Text("正在让电脑端登录，请稍候。") },
            confirmButton = {},
        )
        ApproveResult.Success -> AlertDialog(
            onDismissRequest = onClose,
            title = { Text("✓ 已批准", fontWeight = FontWeight.SemiBold) },
            text = { Text("电脑端正在自动登录。可以回到电脑前继续操作。") },
            confirmButton = { TextButton(onClick = onClose) { Text("完成") } },
        )
        is ApproveResult.Error -> AlertDialog(
            onDismissRequest = onClose,
            title = { Text("批准失败", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.error) },
            text = { Text(r.message) },
            confirmButton = { TextButton(onClick = onClose) { Text("关闭") } },
        )
        ApproveResult.NotDesktopPair -> AlertDialog(
            onDismissRequest = onClose,
            title = { Text("二维码无法识别", fontWeight = FontWeight.SemiBold) },
            text = {
                Column(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                ) {
                    Text("这个二维码不像电脑端的登录码。请确认在电脑端看到的二维码上扫描。")
                    Text(
                        "提示：电脑端「登录 ByWave Calendar」→「用手机扫码登录」会显示一个二维码。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = { TextButton(onClick = onClose) { Text("关闭") } },
        )
    }
}

/** Pull the 8-char pair code out of a `https://<server>/desktop-pair/<CODE>`
 *  URL. Returns null when the scanned text doesn't look like a desktop-pair
 *  URL — callers handle that as "wrong QR." */
private fun extractDesktopPairCode(raw: String): String? {
    // Be lenient: accept http:// + https://, with or without trailing slash,
    // any port, any path-prefix before /desktop-pair/. Server's emitted
    // form is always https://server/desktop-pair/CODE, but a deployment
    // behind a path proxy could vary.
    val regex = Regex("""https?://[^\s/]+(?:/[^\s/]+)*/desktop-pair/([A-Z0-9]{6,16})""", RegexOption.IGNORE_CASE)
    return regex.find(raw)?.groupValues?.getOrNull(1)?.uppercase()
}
