// ProfileStore — multi-account replacement for TokenStore. All
// profiles + their refresh tokens persist in one EncryptedSharedPrefs
// file as a JSON-encoded array; the access-token-per-profile cache
// stays in memory only (re-minted from refresh on demand).
//
// Architecture mirror of iOS AppState (multi-profile path), v0.10.0.
//
// On first install: zero profiles, callers must drive the user to
// SetupScreen. On subsequent launches: load profiles, pick activeId
// from saved preference, current() returns the active profile.

package cn.bywave.calendar.data.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

class ProfileStore(context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "bwc-profiles-v1",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    /** Reactive profile list — Compose composables and ViewModels
     *  observe this to re-render the switcher and recompute "active"
     *  derived state. */
    private val _profiles = MutableStateFlow<List<Profile>>(emptyList())
    val profiles: StateFlow<List<Profile>> = _profiles.asStateFlow()

    private val _activeId = MutableStateFlow<String?>(null)
    val activeId: StateFlow<String?> = _activeId.asStateFlow()

    /** Per-profile in-memory access tokens. Cleared on signOut / app
     *  process death — never persisted. */
    private val accessTokens = mutableMapOf<String, String>()

    init {
        loadFromDisk()
    }

    // ---- Convenience accessors ----

    fun active(): Profile? = _activeId.value?.let { id ->
        _profiles.value.firstOrNull { it.id == id }
    }

    val isSignedIn: Boolean get() = active() != null

    fun accessToken(profileId: String? = _activeId.value): String? =
        profileId?.let { accessTokens[it] }

    fun setAccessToken(profileId: String, token: String?) {
        if (token == null) accessTokens.remove(profileId)
        else accessTokens[profileId] = token
    }

    // ---- Mutations ----

    /** Insert or replace a profile by serverUrl+email match. Switches
     *  it to active. Migration-friendly: if a profile for this server
     *  already exists with the same email, we update it in place so
     *  re-pairing the same account doesn't pile up duplicates. */
    fun upsertAndActivate(profile: Profile): Profile {
        val current = _profiles.value
        val existingIndex = current.indexOfFirst {
            it.serverUrl == profile.serverUrl && it.email == profile.email
        }
        val toSave = profile.copy(lastUsedAt = System.currentTimeMillis())
        val next = if (existingIndex >= 0) {
            // Preserve the existing UUID — Room rows tagged with the
            // old id stay valid; new refresh token + name overwrite.
            current.toMutableList().also {
                it[existingIndex] = toSave.copy(id = current[existingIndex].id)
            }
        } else {
            current + toSave
        }
        _profiles.value = next
        _activeId.value = if (existingIndex >= 0) current[existingIndex].id else toSave.id
        persist()
        return active()!!
    }

    /** Activate an existing profile by id. */
    fun setActive(id: String) {
        if (_profiles.value.none { it.id == id }) return
        _activeId.value = id
        // Touch lastUsedAt so the switcher sort matches usage order.
        _profiles.value = _profiles.value.map {
            if (it.id == id) it.copy(lastUsedAt = System.currentTimeMillis()) else it
        }
        persist()
    }

    /** Update the refresh token (e.g. after MFA verify rotates it). */
    fun updateRefreshToken(profileId: String, newRefresh: String) {
        _profiles.value = _profiles.value.map {
            if (it.id == profileId) it.copy(refreshToken = newRefresh) else it
        }
        persist()
    }

    /** Remove a profile entirely. If it was the active one, pick the
     *  next most-recently-used as active (or null if none left). */
    /** 上一次被动登出的原因，配对页读它显示提示。用户重新配对成功后清空。 */
    private val _signedOutReason = MutableStateFlow<String?>(null)
    val signedOutReason: StateFlow<String?> = _signedOutReason.asStateFlow()

    fun clearSignedOutReason() { _signedOutReason.value = null }

    /**
     * 服务端吊销了这台设备（改密码 / 重置密码 / 后台移除）。
     *
     * 清掉凭据让启动页自然回到配对页 —— 以前不清，用户杀进程重开、重启手机
     * 都自愈不了，因为启动页只看本地有没有账号记录。唯一出路藏在设置里，
     * 而屏幕上唯一的线索是一行英文 HTTP 401。
     */
    fun markSignedOut(profileId: String, reason: String) {
        _signedOutReason.value = reason
        remove(profileId)
    }

    fun remove(id: String) {
        accessTokens.remove(id)
        val remaining = _profiles.value.filterNot { it.id == id }
        _profiles.value = remaining
        if (_activeId.value == id) {
            _activeId.value = remaining.maxByOrNull { it.lastUsedAt }?.id
        }
        persist()
    }

    /** Nuke everything — called on "sign out from all accounts". */
    fun clearAll() {
        accessTokens.clear()
        _profiles.value = emptyList()
        _activeId.value = null
        prefs.edit().clear().apply()
    }

    // ---- Persistence ----

    private fun loadFromDisk() {
        val raw = prefs.getString(KEY_PROFILES, null)
        val profiles = if (raw.isNullOrEmpty()) emptyList()
                       else runCatching {
                           json.decodeFromString(ListSerializer(Profile.serializer()), raw)
                       }.getOrDefault(emptyList())
        _profiles.value = profiles
        _activeId.value = prefs.getString(KEY_ACTIVE_ID, null)
            ?.takeIf { id -> profiles.any { it.id == id } }
            ?: profiles.maxByOrNull { it.lastUsedAt }?.id
    }

    private fun persist() {
        val encoded = json.encodeToString(ListSerializer(Profile.serializer()), _profiles.value)
        prefs.edit()
            .putString(KEY_PROFILES, encoded)
            .putString(KEY_ACTIVE_ID, _activeId.value)
            .apply()
    }

    private companion object {
        const val KEY_PROFILES = "profiles_json"
        const val KEY_ACTIVE_ID = "active_profile_id"
    }
}
