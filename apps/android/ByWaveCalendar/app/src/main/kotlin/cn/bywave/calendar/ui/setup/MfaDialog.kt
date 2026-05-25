// MFA TOTP entry dialog. Surfaced from SetupScreen when login returns
// mfaPending=true. Single 6-digit field with numeric keyboard + auto-
// submit when the 6th digit lands (saves a tap). Mirrors iOS
// SetupView's MFA sheet from v1.2.0.

package cn.bywave.calendar.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

@Composable
fun MfaDialog(
    busy: Boolean,
    errorMessage: String?,
    onSubmit: (String) -> Unit,
    onCancel: () -> Unit,
) {
    var code by remember { mutableStateOf("") }

    // Auto-submit when the user types the 6th digit — same UX as
    // iPhone's SMS code entry. Trims non-digits so paste-from-
    // password-manager (which sometimes includes spaces) works.
    LaunchedEffect(code) {
        val digits = code.filter { it.isDigit() }
        if (digits.length == 6 && !busy) onSubmit(digits)
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        title = { Text("二次验证") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "请输入认证器 App 上当前显示的 6 位验证码。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(4.dp))
                OutlinedTextField(
                    value = code,
                    onValueChange = { v ->
                        // Restrict to digits + max 6 chars.
                        code = v.filter { it.isDigit() }.take(6)
                    },
                    placeholder = { Text("000000") },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (errorMessage != null) {
                    Text(
                        text = errorMessage,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSubmit(code) },
                enabled = !busy && code.length == 6,
            ) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.height(16.dp), strokeWidth = 2.dp)
                } else {
                    Text("验证")
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, enabled = !busy) { Text("取消") }
        },
    )
}
