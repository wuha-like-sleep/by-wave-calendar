// SetupViewModel — v0.8.1 rewrite: now uses the native APP login
// endpoint /auth/login-password (with label/kind/appVersion/clientDeviceId)
// instead of the web cookie endpoint /auth/login that never returned
// tokens. QR scans expect the server's actual JSON envelope
// `{ v: 1, url, code }` and call /devices/pair-claim to redeem the code.

package cn.bywave.calendar.ui.setup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BuildConfig
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.model.LoginRequest
import cn.bywave.calendar.data.model.LoginResponse
import cn.bywave.calendar.data.model.MfaVerifyRequest
import cn.bywave.calendar.data.model.PairClaimRequest
import cn.bywave.calendar.data.model.PairPayload
import cn.bywave.calendar.util.ClientDeviceId
import cn.bywave.calendar.util.ServerUrl
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

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
    private val jsonLenient = Json { ignoreUnknownKeys = true }

    /** Localized string via the Application context (BywaveApp is an
     *  Application, so it's a valid Context — no AndroidViewModel needed). */
    private fun str(resId: Int): String = BywaveApp.instance.getString(resId)

    fun onServerChange(v: String) = _state.update { it.copy(server = v, errorMessage = null) }
    fun onEmailChange(v: String) = _state.update { it.copy(email = v, errorMessage = null) }
    fun onPasswordChange(v: String) = _state.update { it.copy(password = v, errorMessage = null) }

    fun onScanned(raw: String) {
        // The server's QR encodes a JSON envelope:
        //   { "v": 1, "url": "https://rl.lz-ss.com", "code": "ABC123" }
        // Earlier Android builds incorrectly tried to parse a
        // `bywave://?server=…&email=…` URL that the server never emits,
        // which is why every QR scan since v0.1 failed with "二维码格式
        // 不正确". Fixed by mirroring iOS PairingService.parseScanned.
        val payload = runCatching {
            jsonLenient.decodeFromString(PairPayload.serializer(), raw)
        }.getOrNull() ?: run {
            _state.update { it.copy(errorMessage = str(R.string.setupvm_qr_invalid)) }
            return
        }
        // Pre-fill server URL + start the claim. The QR-pair flow doesn't
        // require email/password — the 6-char code IS the proof of authz.
        _state.update {
            it.copy(server = payload.url, errorMessage = null, busy = true)
        }
        viewModelScope.launch {
            try {
                val ctx = BywaveApp.instance
                val api = ApiClient.forSetup(payload.url)
                val resp = api.pairClaim(
                    PairClaimRequest(
                        code = payload.code,
                        label = androidDeviceLabel(),
                        kind = "android",
                        appVersion = BuildConfig.VERSION_NAME,
                        clientDeviceId = ClientDeviceId.get(ctx),
                    ),
                )
                val email = resp.userEmail.orEmpty()
                completeLogin(payload.url, email, resp) ?: run {
                    _state.update {
                        it.copy(busy = false, errorMessage = str(R.string.setupvm_missing_token))
                    }
                    return@launch
                }
                _state.update {
                    it.copy(busy = false, signedIn = true, email = email)
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        busy = false,
                        errorMessage = e.localizedMessage ?: str(R.string.setupvm_qr_login_failed),
                    )
                }
            }
        }
    }

    fun signIn() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(busy = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val ctx = BywaveApp.instance
                val server = ServerUrl.normalize(s.server)
                val api = ApiClient.forSetup(server)
                val resp = api.login(
                    LoginRequest(
                        email = s.email,
                        password = s.password,
                        label = androidDeviceLabel(),
                        kind = "android",
                        appVersion = BuildConfig.VERSION_NAME,
                        clientDeviceId = ClientDeviceId.get(ctx),
                    ),
                )

                if (resp.mfaPending == true && !resp.mfaToken.isNullOrEmpty()) {
                    _state.update { it.copy(busy = false, mfaToken = resp.mfaToken) }
                    return@launch
                }

                completeLogin(server, s.email, resp) ?: run {
                    _state.update { it.copy(busy = false, errorMessage = str(R.string.setupvm_missing_token)) }
                    return@launch
                }
                _state.update { it.copy(busy = false, signedIn = true) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        busy = false,
                        errorMessage = e.localizedMessage ?: str(R.string.setupvm_login_failed),
                    )
                }
            }
        }
    }

    fun verifyMfa(code: String) {
        val token = _state.value.mfaToken ?: return
        if (code.length != 6 || code.any { !it.isDigit() }) {
            _state.update { it.copy(errorMessage = str(R.string.setupvm_mfa_invalid_length)) }
            return
        }
        _state.update { it.copy(busy = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val server = ServerUrl.normalize(_state.value.server)
                val api = ApiClient.forSetup(server)
                val resp = api.verifyMfa(MfaVerifyRequest(mfaToken = token, code = code))
                completeLogin(server, _state.value.email, resp) ?: run {
                    _state.update { it.copy(busy = false, errorMessage = str(R.string.setupvm_mfa_missing_token)) }
                    return@launch
                }
                _state.update { it.copy(busy = false, signedIn = true, mfaToken = null) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(busy = false, errorMessage = e.localizedMessage ?: str(R.string.setupvm_mfa_code_error))
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

    /** Human-readable device label that shows up in the server's
     *  device management page. iOS uses "iPhone of {name}"; we just use
     *  the Android model + manufacturer because Android has no clean
     *  "owner name" API to read. */
    private fun androidDeviceLabel(): String {
        val brand = android.os.Build.MANUFACTURER.replaceFirstChar { it.uppercaseChar() }
        val model = android.os.Build.MODEL
        return "$brand $model".take(60)
    }
}
