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
// Showing a result sheet (success / error / not-a-pair-QR) before
// popping back gives the user feedback that login actually happened.

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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.DesktopPairApproveRequest
import kotlinx.coroutines.launch

/** Which pair flow the scanned URL represents. Drives both the
 *  approve endpoint and the post-success copy. */
internal enum class PairKind { DESKTOP, WEB }

internal data class ParsedPair(val code: String, val kind: PairKind)

private sealed class ApproveResult {
    object Idle : ApproveResult()
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

    // Hoisted here because the approve flow below runs inside a
    // non-composable coroutine lambda where stringResource() can't be
    // called. Captured by value into that lambda.
    val notSignedInMsg = stringResource(R.string.pairscan_not_signed_in)
    val approveFailedMsg = stringResource(R.string.pairscan_approve_failed)

    // ScannerScreen fires onResult exactly once (it locks after first
    // detection). After we settle the approve call, the AlertDialog
    // handles the rest of the flow.
    ScannerScreen(
        onResult = { raw ->
            val parsed = extractPairCode(raw)
            if (parsed == null) {
                result = ApproveResult.NotDesktopPair
                return@ScannerScreen
            }
            result = ApproveResult.Sending
            scope.launch {
                try {
                    val profiles = BywaveApp.instance.profiles
                    val profile = profiles.active()
                        ?: throw IllegalStateException(notSignedInMsg)
                    val client = ApiClient.forProfile(profile, profiles)
                    when (parsed.kind) {
                        PairKind.DESKTOP -> client.api.desktopPairApprove(
                            DesktopPairApproveRequest(code = parsed.code))
                        PairKind.WEB -> client.api.webPairApprove(
                            DesktopPairApproveRequest(code = parsed.code))
                    }
                    result = ApproveResult.Success(parsed.kind)
                } catch (e: Exception) {
                    result = ApproveResult.Error(e.localizedMessage ?: approveFailedMsg)
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

/** Pull the 8-char pair code out of either:
 *    https://<server>/desktop-pair/<CODE>   (desktop app pair)
 *    https://<server>/web-pair/<CODE>       (web /login scan-login)
 *
 *  Returns the code + which kind was matched, or null when the
 *  scanned text doesn't look like either — callers handle that as
 *  "wrong QR."
 *
 *  Lenient on scheme (http/https), port, and path-prefix to survive
 *  reverse-proxy deployments. The exact "/desktop-pair/" or "/web-pair/"
 *  literal must appear immediately before the code segment. */
internal fun extractPairCode(raw: String): ParsedPair? {
    val desktopRegex = Regex("""https?://[^\s/]+(?:/[^\s/]+)*/desktop-pair/([A-Z0-9]{6,16})""", RegexOption.IGNORE_CASE)
    desktopRegex.find(raw)?.let { m ->
        return ParsedPair(code = m.groupValues[1].uppercase(), kind = PairKind.DESKTOP)
    }
    val webRegex = Regex("""https?://[^\s/]+(?:/[^\s/]+)*/web-pair/([A-Z0-9]{6,16})""", RegexOption.IGNORE_CASE)
    webRegex.find(raw)?.let { m ->
        return ParsedPair(code = m.groupValues[1].uppercase(), kind = PairKind.WEB)
    }
    return null
}
