// Wrapper around ScannerScreen for "scan a pair-init QR and approve it".
// Two QR sources are accepted:
//
//   1. Desktop app pair QR — encodes <server>/desktop-pair/<code>.
//      Phone POSTs /api/v1/devices/desktop-pair-approve. Server flips
//      the pending desktop pair to approved; desktop's poll picks up
//      refresh + access tokens.
//
//   2. Web /login page scan-login QR — encodes <server>/web-pair/<code>.
//      Phone POSTs /api/v1/devices/web-pair-approve. Server flips the
//      pending web pair to approved; the browser's poll picks up the
//      approval and the server plants a bwc_sid session cookie on the
//      polling browser.
//
// Branching on the URL prefix means one Settings entry covers both —
// the user doesn't need to choose "scan desktop QR" vs "scan web QR".
//
// ⚠️ 这个界面上的动作是全 APP 后果最重的一个：批准之后，对面那台机器拿到
// 的是一套完整的 refresh + access token，等于账号。原来的实现是相机一识别
// 到码就**立刻**发批准请求，屏幕上先出现的是「已批准」而不是「要批准吗」，
// 既不显示批准给了谁，也没有撤销的路。任何人递一张码说「扫一下看菜单」，
// 扫完账号就交出去了 —— 而这是全 APP 唯一一个零确认的动作。
//
// 现在识别成功先停在确认页：说清会发生什么、哪台服务器、哪个账号、配对码
// 是什么，用户点「批准登录」才发请求。取消就直接退出，不发任何东西。

package cn.bywave.calendar.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.DesktopPairApproveRequest
import kotlinx.coroutines.launch

/** Which pair flow the scanned URL represents. Drives both the
 *  approve endpoint and the post-success copy. */
internal enum class PairKind { DESKTOP, WEB }

internal data class ParsedPair(
    val code: String,
    val kind: PairKind,
    /** 码里那台服务器的 host（带端口）。只用于显示和「是不是同一台服务器」
     *  的提示 —— 批准请求永远发往当前账号自己的服务器。 */
    val host: String,
)

/**
 * 扫到一张码之后**允许**发生的事，全部在这里。
 *
 * 注意这个类型里没有、也不许有「已批准 / 立刻批准」这一项 —— 扫码这一步
 * 能产出的最大动作就是「问用户要不要批准」。DesktopPairScanDecisionTest
 * 会把这几个分支数出来比对，有人再加一条自动批准的路就会红。
 */
internal sealed class ScanDecision {
    /** 认出来了，停下来问人。 */
    data class Confirm(val parsed: ParsedPair) : ScanDecision()
    /** 不是登录码。 */
    object NotPair : ScanDecision()
    /** 没登录，批准这件事根本无从谈起。 */
    object NotSignedIn : ScanDecision()
}

/** 扫码回调里唯一做的事：把原始文本变成一个决定。纯函数，没有副作用。 */
internal fun decideAfterScan(raw: String, signedIn: Boolean): ScanDecision {
    val parsed = extractPairCode(raw) ?: return ScanDecision.NotPair
    if (!signedIn) return ScanDecision.NotSignedIn
    return ScanDecision.Confirm(parsed)
}

private sealed class ApproveResult {
    object Idle : ApproveResult()
    /** 已经认出是一张登录码，等用户拍板。**还没有发出任何请求。** */
    data class Confirm(val parsed: ParsedPair) : ApproveResult()
    object Sending : ApproveResult()
    data class Success(val kind: PairKind) : ApproveResult()
    data class Error(val message: String) : ApproveResult()
    /** QR didn't match either pair URL pattern — likely the pair-claim
     *  QR (which belongs in the setup screen, not here) or some random
     *  barcode. Tell the user, let them try again. */
    object NotDesktopPair : ApproveResult()
}

@Composable
fun DesktopPairScannerScreen(
    onClose: () -> Unit,
) {
    var result by remember { mutableStateOf<ApproveResult>(ApproveResult.Idle) }
    val scope = rememberCoroutineScope()
    val profiles = remember { BywaveApp.instance.profiles }
    val active = profiles.active()

    // Hoisted here because the approve flow below runs inside a
    // non-composable coroutine lambda where stringResource() can't be
    // called. Captured by value into that lambda.
    val notSignedInMsg = stringResource(R.string.pairscan_not_signed_in)
    val approveFailedMsg = stringResource(R.string.pairscan_approve_failed)

    // ScannerScreen fires onResult exactly once (it locks after first
    // detection). 这里只把结果**认出来**，不做任何有副作用的事。
    ScannerScreen(
        onResult = { raw ->
            result = when (val decision = decideAfterScan(raw, signedIn = active != null)) {
                is ScanDecision.Confirm -> ApproveResult.Confirm(decision.parsed)
                ScanDecision.NotPair -> ApproveResult.NotDesktopPair
                ScanDecision.NotSignedIn -> ApproveResult.Error(notSignedInMsg)
            }
        },
        onCancel = onClose,
    )

    when (val r = result) {
        ApproveResult.Idle -> Unit

        is ApproveResult.Confirm -> {
            val parsed = r.parsed
            val accountLabel = listOfNotNull(
                active?.displayName?.takeIf { it.isNotBlank() },
                active?.email?.takeIf { it.isNotBlank() },
            ).joinToString(" · ").ifBlank { "—" }
            val myHost = hostOf(active?.serverUrl)
            AlertDialog(
                onDismissRequest = onClose,
                title = {
                    Text(stringResource(R.string.pairscan_confirm_title), fontWeight = FontWeight.SemiBold)
                },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            if (parsed.kind == PairKind.WEB)
                                stringResource(R.string.pairscan_confirm_web_body)
                            else
                                stringResource(R.string.pairscan_confirm_desktop_body),
                        )
                        DetailRow(stringResource(R.string.pairscan_confirm_account), accountLabel)
                        DetailRow(stringResource(R.string.pairscan_confirm_server), parsed.host)
                        DetailRow(stringResource(R.string.pairscan_confirm_code), parsed.code)
                        if (myHost.isNotBlank() && !parsed.host.equals(myHost, ignoreCase = true)) {
                            Text(
                                stringResource(R.string.pairscan_confirm_host_mismatch, parsed.host, myHost),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        Text(
                            stringResource(R.string.pairscan_confirm_warning),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        // 服务端的 desktop-pair-init 是匿名的，没记发起方的设备
                        // / IP / 时间，也没有给 APP 查这些的接口。有什么显示
                        // 什么，没有的就直说，别让人以为「没写=没问题」。
                        Text(
                            stringResource(R.string.pairscan_confirm_no_detail),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        result = ApproveResult.Sending
                        scope.launch {
                            result = approve(parsed, approveFailedMsg, notSignedInMsg)
                        }
                    }) {
                        Text(
                            stringResource(R.string.pairscan_confirm_approve),
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                },
                dismissButton = {
                    TextButton(onClick = onClose) { Text(stringResource(R.string.action_cancel)) }
                },
            )
        }

        ApproveResult.Sending -> AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.pairscan_approving_title), fontWeight = FontWeight.SemiBold) },
            text = { Text(stringResource(R.string.pairscan_approving_body)) },
            confirmButton = {},
        )
        is ApproveResult.Success -> AlertDialog(
            onDismissRequest = onClose,
            title = { Text(stringResource(R.string.pairscan_approved_title), fontWeight = FontWeight.SemiBold) },
            text = {
                Text(
                    if (r.kind == PairKind.WEB)
                        stringResource(R.string.pairscan_approved_web_body)
                    else
                        stringResource(R.string.pairscan_approved_desktop_body),
                )
            },
            confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.pairscan_done)) } },
        )
        is ApproveResult.Error -> AlertDialog(
            onDismissRequest = onClose,
            title = { Text(stringResource(R.string.pairscan_failed_title), fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.error) },
            text = { Text(r.message) },
            confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.pairscan_close)) } },
        )
        ApproveResult.NotDesktopPair -> AlertDialog(
            onDismissRequest = onClose,
            title = { Text(stringResource(R.string.pairscan_unrecognized_title), fontWeight = FontWeight.SemiBold) },
            text = {
                Column(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                ) {
                    Text(stringResource(R.string.pairscan_unrecognized_body))
                    Text(
                        stringResource(R.string.pairscan_unrecognized_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.pairscan_close)) } },
        )
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * 真正发批准请求。只有用户点过「批准登录」才会走到这里。
 *
 * 错误文案在这里收口：原来直接把 e.localizedMessage 摆给用户，那是
 * "java.net.UnknownHostException: Unable to resolve host …" 这种东西。
 * 服务端明确回了 message 的才显示服务端那句（那句是给用户看的，且已
 * 本地化），其余一律走通用文案。
 */
private suspend fun approve(
    parsed: ParsedPair,
    approveFailedMsg: String,
    notSignedInMsg: String,
): ApproveResult = try {
    val profiles = BywaveApp.instance.profiles
    val profile = profiles.active()
    if (profile == null) {
        ApproveResult.Error(notSignedInMsg)
    } else {
        val client = ApiClient.forProfile(profile, profiles)
        when (parsed.kind) {
            PairKind.DESKTOP -> client.api.desktopPairApprove(
                DesktopPairApproveRequest(code = parsed.code))
            PairKind.WEB -> client.api.webPairApprove(
                DesktopPairApproveRequest(code = parsed.code))
        }
        ApproveResult.Success(parsed.kind)
    }
} catch (e: Exception) {
    val fromServer = (e as? retrofit2.HttpException)
        ?.let { serverErrorMessage(it) }
        ?.takeIf { it.isNotBlank() && it != e.localizedMessage }
    ApproveResult.Error(fromServer ?: approveFailedMsg)
}

/** "https://cal.example.com:8443/x" -> "cal.example.com:8443"。取不出来给空串。 */
internal fun hostOf(url: String?): String {
    if (url.isNullOrBlank()) return ""
    return Regex("""^\s*https?://([^\s/?#]+)""", RegexOption.IGNORE_CASE)
        .find(url)?.groupValues?.get(1)
        ?: url.trim().substringBefore('/').ifBlank { "" }
}

/** Pull the 8-char pair code out of either:
 *    https://<server>/desktop-pair/<CODE>   (desktop app pair)
 *    https://<server>/web-pair/<CODE>       (web /login scan-login)
 *
 *  Returns the code + which kind was matched + 码里那台服务器的 host，
 *  or null when the scanned text doesn't look like either — callers
 *  handle that as "wrong QR."
 *
 *  Lenient on scheme (http/https), port, and path-prefix to survive
 *  reverse-proxy deployments. The exact "/desktop-pair/" or "/web-pair/"
 *  literal must appear immediately before the code segment. */
internal fun extractPairCode(raw: String): ParsedPair? {
    val desktopRegex = Regex("""https?://([^\s/]+)(?:/[^\s/]+)*/desktop-pair/([A-Z0-9]{6,16})""", RegexOption.IGNORE_CASE)
    desktopRegex.find(raw)?.let { m ->
        return ParsedPair(code = m.groupValues[2].uppercase(), kind = PairKind.DESKTOP, host = m.groupValues[1])
    }
    val webRegex = Regex("""https?://([^\s/]+)(?:/[^\s/]+)*/web-pair/([A-Z0-9]{6,16})""", RegexOption.IGNORE_CASE)
    webRegex.find(raw)?.let { m ->
        return ParsedPair(code = m.groupValues[2].uppercase(), kind = PairKind.WEB, host = m.groupValues[1])
    }
    return null
}
