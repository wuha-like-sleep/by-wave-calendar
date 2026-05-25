// SetupViewModel — v0.5 saves new logins as Profile entries via
// ProfileStore.upsertAndActivate(). Supports both "first account" and
// "add another account" flows; the difference is just whether
// ProfileStore.profiles is empty when we get here.

package cn.bywave.calendar.ui.setup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.model.LoginRequest
import cn.bywave.calendar.data.model.LoginResponse
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
    val mfaToken: String? = null,
) {
    val canSubmit: Boolean
        get() = ServerUrl.looksValid(server) && email.isNotBlank() && password.isNotBlank()
}

class SetupViewModel : ViewModel() {
    private val profiles = BywaveApp.instance.profiles
    private val _state = MutableStateFlow(SetupUiState())
    val state: StateFlow<SetupUiState> = _state.asStateFlow()

    fun onServerChange(v: String) = _state.update { it.copy(server = v, errorMessage = null) }
    fun onEmailChange(v: String) = _state.update { it.copy(email = v, errorMessage = null) }
    fun onPasswordChange(v: String) = _state.update { it.copy(password = v, errorMessage = null) }

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
                val api = ApiClient.forSetup(server)
                val resp = api.login(LoginRequest(email = s.email, password = s.password))

                if (resp.mfaPending == true && !resp.mfaToken.isNullOrEmpty()) {
                    _state.update { it.copy(busy = false, mfaToken = resp.mfaToken) }
                    return@launch
                }

                completeLogin(server, s.email, resp) ?: run {
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

    fun verifyMfa(code: String) {
        val token = _state.value.mfaToken ?: return
        if (code.length != 6 || code.any { !it.isDigit() }) {
            _state.update { it.copy(errorMessage = "请输入 6 位验证码") }
            return
        }
        _state.update { it.copy(busy = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val server = ServerUrl.normalize(_state.value.server)
                val api = ApiClient.forSetup(server)
                val resp = api.verifyMfa(MfaVerifyRequest(mfaToken = token, code = code))
                completeLogin(server, _state.value.email, resp) ?: run {
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
    }

    /** Persist a successful login (or MFA verify) as the active profile.
     *  Returns Unit on success, null when tokens were missing. */
    private fun completeLogin(
        server: String,
        email: String,
        resp: LoginResponse,
    ): Unit? {
        val refresh = resp.refreshToken ?: return null
        val access = resp.accessToken ?: return null
        val profile = profiles.upsertAndActivate(
            Profile(
                serverUrl = server,
                email = email,
                refreshToken = refresh,
            ),
        )
        profiles.setAccessToken(profile.id, access)
        return Unit
    }
}
