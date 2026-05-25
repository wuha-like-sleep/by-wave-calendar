// SetupScreen state holder. Mirrors iOS SetupView's signIn(...) flow:
//   1. Normalize server URL
//   2. POST /api/v1/auth/login with email + password
//   3. If response.mfaPending → push MFA sheet (deferred to v0.2)
//   4. Persist refreshToken + accessToken via TokenStore
//   5. Emit signedIn=true so the composable navigates away

package cn.bywave.calendar.ui.setup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.LoginRequest
import cn.bywave.calendar.data.model.MfaVerifyRequest
import cn.bywave.calendar.util.ServerUrl
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SetupUiState(
    val server: String = "",
    val email: String = "",
    val password: String = "",
    val busy: Boolean = false,
    val errorMessage: String? = null,
    val signedIn: Boolean = false,
    /** Set when /auth/login returned mfaPending=true. Triggers
     *  MfaDialog in the composable. */
    val mfaToken: String? = null,
) {
    val canSubmit: Boolean
        get() = ServerUrl.looksValid(server) && email.isNotBlank() && password.isNotBlank()
}

class SetupViewModel : ViewModel() {
    private val tokens = BywaveApp.instance.tokenStore
    private val _state = MutableStateFlow(SetupUiState())
    val state: StateFlow<SetupUiState> = _state.asStateFlow()

    fun onServerChange(v: String) = _state.update { it.copy(server = v, errorMessage = null) }
    fun onEmailChange(v: String) = _state.update { it.copy(email = v, errorMessage = null) }
    fun onPasswordChange(v: String) = _state.update { it.copy(password = v, errorMessage = null) }

    /**
     * Consume a `bywave://pair?...` URL scanned from the server's
     * "Pair new device" QR. We trade the one-time pair code for a
     * refresh token via /api/v1/devices/pair, then save credentials
     * exactly like the email/password path.
     *
     * v0.3: only fills the server URL + email and asks the user to
     * type their password. v0.4 will redeem the pair code directly.
     */
    fun onScanned(raw: String) {
        val parsed = parsePairUrl(raw) ?: run {
            _state.update { it.copy(errorMessage = "二维码格式不正确") }
            return
        }
        _state.update {
            it.copy(
                server = parsed.server,
                email = parsed.email,
                errorMessage = null,
            )
        }
    }

    private data class PairPayload(val server: String, val email: String)

    private fun parsePairUrl(raw: String): PairPayload? {
        if (!raw.startsWith("bywave://", ignoreCase = true)) return null
        val uri = runCatching { android.net.Uri.parse(raw) }.getOrNull() ?: return null
        val server = uri.getQueryParameter("server") ?: return null
        val email = uri.getQueryParameter("email").orEmpty()
        return PairPayload(server = server, email = email)
    }

    fun signIn() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(busy = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val server = ServerUrl.normalize(s.server)
                val client = ApiClient.forServer(server, tokens)
                val resp = client.api.login(LoginRequest(email = s.email, password = s.password))

                if (resp.mfaPending == true && !resp.mfaToken.isNullOrEmpty()) {
                    // Surface MFA token to the UI — composable shows
                    // MfaDialog and calls verifyMfa(code) on submit.
                    // We pre-save serverUrl now so verifyMfa() doesn't
                    // need to re-normalize.
                    tokens.serverUrl = server
                    _state.update { it.copy(busy = false, mfaToken = resp.mfaToken) }
                    return@launch
                }

                persistTokens(server, s.email, resp.refreshToken, resp.accessToken) ?: run {
                    _state.update { it.copy(busy = false, errorMessage = "服务器响应缺少 token") }
                    return@launch
                }
                _state.update { it.copy(busy = false, signedIn = true) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        busy = false,
                        errorMessage = e.localizedMessage ?: "登录失败，请检查服务器地址、网络、账号密码",
                    )
                }
            }
        }
    }

    /**
     * Submit the 6-digit TOTP from the user's authenticator. Called by
     * MfaDialog. The mfaToken from step-1 binds this code to the same
     * login attempt server-side — it expires in a few minutes.
     */
    fun verifyMfa(code: String) {
        val token = _state.value.mfaToken ?: return
        if (code.length != 6 || code.any { !it.isDigit() }) {
            _state.update { it.copy(errorMessage = "请输入 6 位验证码") }
            return
        }
        _state.update { it.copy(busy = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val server = tokens.serverUrl ?: error("missing server")
                val client = ApiClient.forServer(server, tokens)
                val resp = client.api.verifyMfa(MfaVerifyRequest(mfaToken = token, code = code))

                persistTokens(server, _state.value.email, resp.refreshToken, resp.accessToken) ?: run {
                    _state.update { it.copy(busy = false, errorMessage = "MFA 响应缺少 token") }
                    return@launch
                }
                _state.update { it.copy(busy = false, signedIn = true, mfaToken = null) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(busy = false, errorMessage = e.localizedMessage ?: "验证码错误")
                }
            }
        }
    }

    fun dismissMfa() {
        _state.update { it.copy(mfaToken = null, busy = false) }
        tokens.serverUrl = null  // back out — clean slate
    }

    /** Persist tokens + email after a successful login (or MFA verify).
     *  Returns Unit on success, null when tokens were missing. */
    private fun persistTokens(
        server: String,
        email: String,
        refreshToken: String?,
        accessToken: String?,
    ): Unit? {
        if (refreshToken.isNullOrEmpty() || accessToken.isNullOrEmpty()) return null
        tokens.serverUrl = server
        tokens.refreshToken = refreshToken
        tokens.accessToken = accessToken
        tokens.userEmail = email
        return Unit
    }
}
