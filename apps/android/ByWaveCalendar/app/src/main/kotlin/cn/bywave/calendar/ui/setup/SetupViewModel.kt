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

    fun signIn() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(busy = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val server = ServerUrl.normalize(s.server)
                val client = ApiClient.forServer(server, tokens)
                val resp = client.api.login(LoginRequest(email = s.email, password = s.password))

                if (resp.mfaPending == true) {
                    // MFA flow deferred to v0.2 — for now we tell the
                    // user to use the web to disable MFA temporarily.
                    _state.update {
                        it.copy(
                            busy = false,
                            errorMessage = "此账号开启了二次验证，v0.1 暂不支持，请使用网页登录或暂时关闭 MFA。",
                        )
                    }
                    return@launch
                }

                val rt = resp.refreshToken
                val at = resp.accessToken
                if (rt.isNullOrEmpty() || at.isNullOrEmpty()) {
                    _state.update { it.copy(busy = false, errorMessage = "服务器响应缺少 token") }
                    return@launch
                }

                tokens.serverUrl = server
                tokens.refreshToken = rt
                tokens.accessToken = at
                tokens.userEmail = s.email

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
}
