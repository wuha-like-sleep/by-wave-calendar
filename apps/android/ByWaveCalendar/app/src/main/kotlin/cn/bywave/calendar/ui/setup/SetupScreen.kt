// Email/password sign-in. QR-scan path is stubbed for v0.1 — we'll wire
// it up in v0.2 with CameraX + ML Kit (deps already on the classpath).
//
// Mirrors iOS SetupView.swift's "quick sign-in" branch.

package cn.bywave.calendar.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R

@Composable
fun SetupScreen(
    onSignedIn: () -> Unit,
    onScanQr: () -> Unit,
    vm: SetupViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()

    // 被动登出（改了密码 / 这台设备被后台移除）的说明。ProfileStore 一直
    // 在记这个原因，注释也写着「配对页读它显示提示」，但全仓没有任何地方
    // 读过——用户是被凭空踢回登录页的，屏幕上没有一个字解释发生了什么，
    // 只能怀疑是自己密码记错了。
    val profiles = androidx.compose.runtime.remember { cn.bywave.calendar.BywaveApp.instance.profiles }
    val signedOutReason by profiles.signedOutReason.collectAsState()

    // Navigate away once login succeeds. We watch the success flag in
    // a LaunchedEffect so the ViewModel doesn't need a NavController.
    androidx.compose.runtime.LaunchedEffect(state.signedIn) {
        if (state.signedIn) {
            profiles.clearSignedOutReason()
            onSignedIn()
        }
    }

    Scaffold { innerPadding ->
        SetupContent(
            state = state,
            signedOutReason = signedOutReason,
            innerPadding = innerPadding,
            onServerChange = vm::onServerChange,
            onEmailChange = vm::onEmailChange,
            onPasswordChange = vm::onPasswordChange,
            onSignIn = vm::signIn,
            onScanQr = onScanQr,
        )
    }

    // MFA dialog — visible whenever the VM has an mfaToken stashed.
    if (state.mfaToken != null) {
        MfaDialog(
            busy = state.busy,
            errorMessage = state.errorMessage,
            onSubmit = vm::verifyMfa,
            onCancel = vm::dismissMfa,
        )
    }
}

@Composable
private fun SetupContent(
    state: SetupUiState,
    @androidx.annotation.StringRes signedOutReason: Int?,
    innerPadding: PaddingValues,
    onServerChange: (String) -> Unit,
    onEmailChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSignIn: () -> Unit,
    onScanQr: () -> Unit,
) {
    // imePadding 不能少。APP 是 edge-to-edge 的（MainActivity 调了
    // enableEdgeToEdge），系统就不再替我们把窗口缩到键盘上方了——键盘弹出来
    // 之后，「登录」按钮被压在键盘底下，而外面这层滚动的高度没变，往上
    // 划也划不出来。这是第一次打开 APP 就会撞上的死路。
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(innerPadding)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Text(
            text = stringResource(R.string.setup_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.setup_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // 被动登出的说明放在输入框上面：用户一睁眼就该知道为什么要重登。
        if (signedOutReason != null) {
            Text(
                text = stringResource(signedOutReason),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Spacer(Modifier.height(8.dp))

        OutlinedTextField(
            value = state.server,
            onValueChange = onServerChange,
            label = { Text(stringResource(R.string.setup_server_label)) },
            placeholder = { Text(stringResource(R.string.setup_server_hint)) },
            singleLine = true,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )

        OutlinedTextField(
            value = state.email,
            onValueChange = onEmailChange,
            label = { Text(stringResource(R.string.setup_email_label)) },
            placeholder = { Text(stringResource(R.string.setup_email_hint)) },
            singleLine = true,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        )

        OutlinedTextField(
            value = state.password,
            onValueChange = onPasswordChange,
            label = { Text(stringResource(R.string.setup_password_label)) },
            singleLine = true,
            enabled = !state.busy,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )

        if (state.errorMessage != null) {
            Text(
                text = state.errorMessage,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Spacer(Modifier.height(4.dp))

        Button(
            onClick = onSignIn,
            enabled = !state.busy && state.canSubmit,
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) {
            if (state.busy) {
                CircularProgressIndicator(
                    modifier = Modifier.height(20.dp),
                    color = MaterialTheme.colorScheme.onPrimary,
                    strokeWidth = 2.dp,
                )
                Spacer(Modifier.height(0.dp))
                Text(
                    text = "  " + stringResource(R.string.setup_signing_in),
                )
            } else {
                Text(stringResource(R.string.setup_signin))
            }
        }

        Spacer(Modifier.height(8.dp))

        // QR scan (v0.3) — opens ScannerScreen, which on success fills
        // server URL + email into the form so the user just types
        // their password.
        androidx.compose.material3.OutlinedButton(
            onClick = onScanQr,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            enabled = !state.busy,
        ) {
            Text(stringResource(R.string.setup_qr_scan))
        }
        Text(
            text = stringResource(R.string.setup_qr_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
    }
}
