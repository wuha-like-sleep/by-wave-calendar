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
import kotlinx.coroutines.flow.update
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

    /** 被服务端登出、而本机还登着别的账号时，日历页顶上要挂的提示（先进先出，
     *  一次显示一条，关掉一条露出下一条）。落盘：切账号是落盘的，提示要是只在内存里，
     *  切完那一刻进程被杀，下次打开就又成了静默切走。 */
    private val _signedOutNotices = MutableStateFlow<List<SignedOutNotice>>(emptyList())
    val signedOutNotices: StateFlow<List<SignedOutNotice>> = _signedOutNotices.asStateFlow()

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
        // 重新登录回来的账号，关于它的「已被登出」提示就过时了。
        _signedOutNotices.update { AccountRules.noticesAfterSignIn(it, profile.serverUrl, profile.email) }
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

    /** 上一次被动登出的原因，配对页读它显示提示。用户重新登录成功后清空。
     *  只在**一个账号都不剩、真的回到登录页**时才记；还登着别的账号时，说明挂在日历页
     *  （[signedOutNotices]），那时根本不会出现登录页。
     *
     *  存的是**资源 id 不是成品文案**：文案要在显示那一刻按当时的界面语言
     *  取，否则用户在被登出之后改了 APP 语言，这条提示还停在旧语言上。 */
    private val _signedOutReason = MutableStateFlow<Int?>(null)
    val signedOutReason: StateFlow<Int?> = _signedOutReason.asStateFlow()

    fun clearSignedOutReason() { _signedOutReason.value = null }

    /** 用户在日历页关掉了一条「已被登出」提示。 */
    fun dismissSignedOutNotice(notice: SignedOutNotice) {
        _signedOutNotices.update { it - notice }
        persist()
    }

    /**
     * 服务端吊销了这台设备（改密码 / 重置密码 / 后台移除 / 后台停用）。
     *
     * 清掉凭据让启动页自然回到配对页 —— 以前不清，用户杀进程重开、重启手机
     * 都自愈不了，因为启动页只看本地有没有账号记录。唯一出路藏在设置里，
     * 而屏幕上唯一的线索是一行英文 HTTP 401。
     *
     * 本机还登着别的账号时，切到最近用过的那个，**同时**在日历页挂一条提示，写清是哪个
     * 账号被登出、为什么。以前只记了 signedOutReason，而它只在登录页上显示 —— 这时根本
     * 不会回登录页，于是是静默切走：用户以为自己还在原来那个账号里，看到的、新建的
     * 日程其实都是另一个账号的。
     */
    fun markSignedOut(profileId: String, @androidx.annotation.StringRes reason: Int) {
        // 先拿住这个账号，删掉之后就找不到它了：清理钩子要它，日历页的提示要它的邮箱。
        // 已经不在了（几个并发请求前后脚都撞上吊销，前一个已经处理过）就什么都不做。
        val gone = _profiles.value.firstOrNull { it.id == profileId } ?: return
        val tell = AccountRules.tellAfterPassiveSignOut(_profiles.value, gone, _signedOutNotices.value)
        if (tell.reasonOnSetupPage) _signedOutReason.value = reason
        _signedOutNotices.value = tell.notices
        // 删掉并切到最近用过的那个账号（提示一起落盘）。
        remove(profileId)
        // **被服务端踢掉也要清干净本机的东西。** 以前只从账号列表里摘掉：
        // 它排好的提醒照样按时响（通知里带着日程标题），系统「日历」App 里的
        // 镜像日程永久留着 —— 而 App 里已经查无此账号，用户关不掉也删不掉。
        // 自己点「退出登录」那条路早就会清（CalendarViewModel.signOutActive），
        // 被动登出这条没跟上。
        onPassiveRemoval?.invoke(gone)
    }

    /** 被服务端踢掉（不是用户自己退出）时要做的本机清理。由 BywaveApp 在启动时接上 ——
     *  清理要用到数据库、提醒、系统日历，那些都不归账号列表这一层管。 */
    @Volatile var onPassiveRemoval: ((Profile) -> Unit)? = null

    /** 删掉一个账号。删的是当前账号时，换到剩下的里最近用过的那个（一个不剩就是 null）。 */
    fun remove(id: String) {
        accessTokens.remove(id)
        val next = AccountRules.remove(_profiles.value, _activeId.value, id)
        // 先换当前账号再缩列表：中间那一刻「当前账号」始终指着列表里还在的人，
        // 别的线程读 active() 不会读到 null（null 的意思是「一个账号都没了」）。
        _activeId.value = next.activeId
        _profiles.value = next.remaining
        // 以前只有被服务端踢掉那条路会清提示；用户自己在设置里退出最后一个账号走的是这里，
        // 旧提示会跟着空账号列表一起落盘，下次登录进来冒出一条早就过时的「某某已被登出」。
        _signedOutNotices.value = AccountRules.noticesAfterRemoval(_signedOutNotices.value, next.remaining)
        persist()
    }

    /** Nuke everything — called on "sign out from all accounts". */
    fun clearAll() {
        accessTokens.clear()
        _profiles.value = emptyList()
        _activeId.value = null
        _signedOutNotices.value = emptyList()
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
        // 一个账号都没有时日历页不会出现，留着的提示只会在下次登录后冒出来、早已过时。
        _signedOutNotices.value = if (profiles.isEmpty()) emptyList() else {
            prefs.getString(KEY_SIGNED_OUT_NOTICES, null)
                ?.takeIf { it.isNotEmpty() }
                ?.let { raw ->
                    runCatching {
                        json.decodeFromString(ListSerializer(SignedOutNotice.serializer()), raw)
                    }.getOrNull()
                }
                .orEmpty()
        }
    }

    private fun persist() {
        val encoded = json.encodeToString(ListSerializer(Profile.serializer()), _profiles.value)
        val notices = json.encodeToString(ListSerializer(SignedOutNotice.serializer()), _signedOutNotices.value)
        prefs.edit()
            .putString(KEY_PROFILES, encoded)
            .putString(KEY_ACTIVE_ID, _activeId.value)
            .putString(KEY_SIGNED_OUT_NOTICES, notices)
            .apply()
    }

    private companion object {
        const val KEY_PROFILES = "profiles_json"
        const val KEY_ACTIVE_ID = "active_profile_id"
        const val KEY_SIGNED_OUT_NOTICES = "signed_out_notices_json"
    }
}
