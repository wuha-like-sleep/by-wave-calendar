// Persistent profile storage. v0.6+ multi-profile: a list of paired
// ByWave servers plus an "active" pointer. Each profile is keyed by
// its server-issued deviceId (stable across re-launches; rotated only
// when the user re-pairs from scratch).
//
// Storage: ~/.bywave-calendar/profiles.json with 0600 permissions when
// the OS supports it (Mac/Linux). Auto-migrates the v0.2-v0.5 single-
// profile profile.json on first read. Encryption is not used — the
// file is already inside the user's home dir, which standard OS
// permissions protect. Encrypting it would require either prompting
// for a master password every launch (UX hell) or storing the key
// alongside (security theater). Mobile uses Keychain/EncryptedShared-
// Prefs because the FS isn't isolated on those platforms; on desktop
// the home dir IS the isolation.
//
// API shape mirrors Android's ProfileStore — `profile` is the active
// profile (back-compat for call sites that pre-date multi-profile),
// `profiles` is the whole list, `activeId` is the pointer.

package cn.bywave.calendar.desktop.data.auth

import cn.bywave.calendar.desktop.data.model.Profile
import cn.bywave.calendar.desktop.util.DebugLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermissions

@Serializable
private data class ProfilesFile(
    val activeId: String? = null,
    val profiles: List<Profile> = emptyList(),
    /** Last server URL the user typed into SetupScreen — persisted
     *  separately so even after sign-out (which drops the profile)
     *  the next setup pre-fills it. */
    val lastServerUrl: String = "",
    /** 用过的先后顺序，最近用的在最前。被服务端登出之后切去哪个账号由它决定
     *  —— 存盘是因为「最近用过」要跨重启才有意义。老文件没有这个字段，读出来
     *  是空列表，回落到列表顺序。 */
    val recentIds: List<String> = emptyList(),
)

/**
 * 某个账号被服务端登出、而本机还登着别的账号时，界面上要挂出来的那条提示。
 *
 * 以前这种情况是**静默**切到另一个账号：原因只记进了 signedOutReasonKey，
 * 而那个值只有登录页在读 —— 还有别的账号时根本不会回登录页，于是用户以为
 * 自己还在原来那个账号里，看着的却是另一个账号的日历。
 *
 * 存邮箱和 I18n key，不存翻好的整句：提示可能挂很久，期间用户可能切了语言。
 */
data class SignedOutNotice(
    /** 被登出的那个 profile（deviceId），关提示时按它找。 */
    val profileId: String,
    val email: String,
    val serverUrl: String,
    val reasonKey: String,
)

/** 当前账号没了之后该切去哪个。最近用过的优先，没有记录就按列表顺序。
 *
 *  放在顶层是为了能直接测 —— 以前写死成「列表里第一个」，用户刚刚还在用的
 *  那个账号排第三的话，就被切进一个他很久没碰过的账号。 */
internal fun pickFallbackProfileId(remaining: List<String>, recentFirst: List<String>): String? =
    recentFirst.firstOrNull { it in remaining } ?: remaining.firstOrNull()

object ProfileStore {
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
        explicitNulls = false
    }
    private val storeDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar")
    private val storeFile: Path = storeDir.resolve("profiles.json")
    private val legacyFile: Path = storeDir.resolve("profile.json")

    private val _profiles = MutableStateFlow(emptyList<Profile>())
    private val _activeId = MutableStateFlow<String?>(null)
    private val _lastServerUrl = MutableStateFlow("")
    val profiles: StateFlow<List<Profile>> = _profiles.asStateFlow()
    val activeId: StateFlow<String?> = _activeId.asStateFlow()
    /** Empty when never set; SetupScreen reads this to pre-fill the
     *  server URL field after sign-out so users don't re-type. */
    val lastServerUrl: StateFlow<String> = _lastServerUrl.asStateFlow()

    /** Convenience StateFlow combining profiles + activeId into the
     *  currently-active Profile (or null). Updated on every mutation;
     *  back-compat alias for the v0.2-v0.5 single-profile API. */
    private val _profile = MutableStateFlow<Profile?>(null)
    val profile: StateFlow<Profile?> = _profile.asStateFlow()

    // Per-profile access token cache. accessToken is in-memory only —
    // it expires in 1h and we'll refresh via /auth/refresh anyway.
    // Keeping it off disk means a stolen profiles.json (e.g. backup
    // leak) only buys the attacker refresh tokens, which the user can
    // revoke from settings.
    //
    // 按 profile 存、按 profile 取，**不读「当前活动账号」**：ApiClient 绑定的是
    // 建立它的那个账号，切账号之后还在飞的请求不能拿到另一个账号的票。
    private val accessTokens = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** 最近用过的顺序（deviceId），最近的在前。 */
    private val recentIds = mutableListOf<String>()

    init { load() }

    // ---- Read ----

    /** 某个账号的 Bearer token（只在内存里）。 */
    fun accessToken(profileId: String): String? = accessTokens[profileId]

    /** 存某个账号的 access token。账号已经被移除了就不存 —— 不然刚被删掉的
     *  账号会在内存里留一张能用的票。 */
    fun setAccessToken(profileId: String, token: String) {
        if (_profiles.value.none { it.deviceId == profileId }) return
        accessTokens[profileId] = token
    }

    /** 某个账号的 refresh token；账号已经不在了返回 null。 */
    fun refreshToken(profileId: String): String? =
        _profiles.value.firstOrNull { it.deviceId == profileId }?.refreshToken

    // ---- Write ----

    /** Add a new profile (or update an existing one with the same
     *  deviceId) and make it active. Called from SetupScreen on a
     *  successful pair-claim. Each successful pair is a new profile;
     *  if the user re-pairs the same server with a fresh QR, the
     *  server issues a new deviceId so it lands as a separate entry. */
    fun save(profile: Profile) {
        val list = _profiles.value
        val idx = list.indexOfFirst { it.deviceId == profile.deviceId }
        val newList = if (idx >= 0) list.toMutableList().also { it[idx] = profile }
                      else list + profile
        _profiles.value = newList
        _activeId.value = profile.deviceId
        _lastServerUrl.value = profile.serverUrl
        touch(profile.deviceId)
        // 重新登回了被踢掉的那个账号：那条「已被登出」的提示说完了，收掉。
        _signedOutNotices.value = _signedOutNotices.value.filterNot {
            it.email.equals(profile.email, ignoreCase = true) && it.serverUrl == profile.serverUrl
        }
        recomputeActive()
        persist()
    }

    /** Remember a server URL the user typed in SetupScreen even before
     *  the pair-claim completes — so a crashed pair flow still leaves
     *  the URL pre-filled on next launch. */
    fun rememberServerUrl(url: String) {
        val trimmed = url.trim()
        if (trimmed.isEmpty()) return
        if (_lastServerUrl.value == trimmed) return
        _lastServerUrl.value = trimmed
        persist()
    }

    /** Pick a different already-paired profile. */
    fun setActive(id: String) {
        if (_profiles.value.none { it.deviceId == id }) return
        if (_activeId.value == id) return
        _activeId.value = id
        touch(id)
        recomputeActive()
        persist()
    }

    /** 上一次被动登出的原因，存的是 I18n 的 key 不是已翻译好的文案。
     *  **只在本机一个账号都不剩时才设**（那时回登录页，登录页显示它）；
     *  还有别的账号时走 [signedOutNotices]。
     *
     *  存 key 而不是成品字符串，是因为这个值可能在界面上停留很久（用户
     *  被踢回登录页之后可能先去切了语言），存成品字符串的话就会卡在
     *  被踢那一刻的语言上；登录页每次渲染时再 t() 一次才跟得上。 */
    private val _signedOutReasonKey = MutableStateFlow<String?>(null)
    val signedOutReasonKey: StateFlow<String?> = _signedOutReasonKey.asStateFlow()

    fun clearSignedOutReason() { _signedOutReasonKey.value = null }

    /** 还有别的账号时，被登出的那几个账号的提示（主界面顶部显示，可关闭）。 */
    private val _signedOutNotices = MutableStateFlow<List<SignedOutNotice>>(emptyList())
    val signedOutNotices: StateFlow<List<SignedOutNotice>> = _signedOutNotices.asStateFlow()

    fun dismissSignedOutNotice(profileId: String) {
        _signedOutNotices.value = _signedOutNotices.value.filterNot { it.profileId == profileId }
    }

    /**
     * 服务端吊销了**这个账号**在这台设备上的登录（改密码 / 重置密码 / 后台移除设备 / 后台停用）。
     *
     * 清掉凭据。以前刷新失败只是把 401 原样抛出、不碰这里，结果桌面端变成僵尸：
     * 日历照常显示上次同步的内容，新建/编辑/删除全部失败，而没有任何地方告诉
     * 用户「你被登出了」。
     *
     * 按 profileId 删，不是删「当前活动账号」：发现吊销的那个请求属于哪个账号，
     * 就只删那个账号。以前删的是活动账号 —— 切账号之后还在飞的旧请求一旦判成
     * 吊销，删掉的是用户刚切过去、什么事都没有的那个账号。
     *
     * 删完之后：
     *  · 本机还有别的账号 → 切到最近用过的那个，**同时**挂一条可关闭的提示，写明
     *    哪个账号、为什么被登出。以前是静默切走，用户以为自己还在原来那个账号里。
     *  · 一个都不剩 → 回登录页，登录页上显示原因（见 SetupScreen 的横幅）。
     */
    fun markSignedOut(profileId: String, reasonKey: String) {
        // 已经不在了：同一个账号的另一个请求先一步处理过，或者用户刚手动移除。
        val gone = _profiles.value.firstOrNull { it.deviceId == profileId } ?: return
        remove(profileId)
        if (_profiles.value.isEmpty()) {
            // 登录页那条横幅会说明原因；主界面的提示用不上了。
            _signedOutNotices.value = emptyList()
            _signedOutReasonKey.value = reasonKey
        } else {
            _signedOutNotices.value = _signedOutNotices.value.filterNot { it.profileId == profileId } +
                SignedOutNotice(
                    profileId = profileId,
                    email = gone.email.ifBlank { gone.displayName ?: gone.userId },
                    serverUrl = gone.serverUrl,
                    reasonKey = reasonKey,
                )
        }
    }

    /** Remove the given profile. If it was active, fall back to the most
     *  recently used remaining profile (or null when the list empties).
     *  Also wipes the event cache so removed-then-re-added accounts
     *  don't see ghost events from before. */
    fun remove(id: String) {
        val list = _profiles.value
        val newList = list.filterNot { it.deviceId == id }
        accessTokens.remove(id)
        recentIds.remove(id)
        // Cache cleanup is best-effort; don't block sign-out on it.
        try {
            cn.bywave.calendar.desktop.data.cache.EventCache.clear(id)
        } catch (_: Exception) { /* swallow */ }
        _profiles.value = newList
        if (_activeId.value == id) {
            _activeId.value = pickFallbackProfileId(newList.map { it.deviceId }, recentIds)
            _activeId.value?.let { touch(it) }
        }
        recomputeActive()
        persist()
    }

    /** Remove the currently-active profile. Back-compat with v0.2-v0.5
     *  call sites that only know about single-profile sign-out. */
    fun clear() {
        _activeId.value?.let { remove(it) }
    }

    /** Refresh-rotated token. Updates **that profile's** stored
     *  refreshToken on disk (the server occasionally rotates them) — not
     *  the active one's: the refresh may belong to a profile the user has
     *  since switched away from. */
    fun updateRefreshToken(profileId: String, newRefresh: String) {
        val list = _profiles.value.toMutableList()
        val idx = list.indexOfFirst { it.deviceId == profileId }
        if (idx < 0) return
        list[idx] = list[idx].copy(refreshToken = newRefresh)
        _profiles.value = list
        recomputeActive()
        persist()
    }

    // ---- Internals ----

    /** 把 id 挪到「最近用过」的最前面。 */
    private fun touch(id: String) {
        recentIds.remove(id)
        recentIds.add(0, id)
    }

    /** 只给测试用：丢掉内存里的一切，按磁盘重新读一遍（等于重启一次 App）。 */
    internal fun reloadForTest() {
        accessTokens.clear()
        recentIds.clear()
        _profiles.value = emptyList()
        _activeId.value = null
        _lastServerUrl.value = ""
        _signedOutReasonKey.value = null
        _signedOutNotices.value = emptyList()
        _profile.value = null
        load()
    }

    private fun recomputeActive() {
        val id = _activeId.value
        _profile.value = if (id == null) null else _profiles.value.firstOrNull { it.deviceId == id }
    }

    private fun load() {
        // New format first.
        if (Files.exists(storeFile)) {
            runCatching {
                val parsed = json.decodeFromString(ProfilesFile.serializer(), Files.readString(storeFile))
                _profiles.value = parsed.profiles
                _activeId.value = parsed.activeId?.takeIf { id -> parsed.profiles.any { it.deviceId == id } }
                    ?: parsed.profiles.firstOrNull()?.deviceId
                recentIds.clear()
                recentIds.addAll(parsed.recentIds.filter { id -> parsed.profiles.any { it.deviceId == id } }.distinct())
                _activeId.value?.let { touch(it) }
                _lastServerUrl.value = parsed.lastServerUrl.ifEmpty {
                    // Fallback for stores written before lastServerUrl existed:
                    // derive from the active (or first) profile's URL.
                    val activeP = parsed.profiles.firstOrNull { it.deviceId == parsed.activeId }
                        ?: parsed.profiles.firstOrNull()
                    activeP?.serverUrl.orEmpty()
                }
                recomputeActive()
                return
            }.onFailure {
                DebugLog.d("ProfileStore") { "failed to parse profiles.json — ignoring: ${it.message}" }
            }
        }
        // Migration from v0.2-v0.5 single-profile file. Read it,
        // write the new format, then delete the legacy file so we
        // don't keep migrating on each launch.
        if (Files.exists(legacyFile)) {
            runCatching {
                val p = json.decodeFromString(Profile.serializer(), Files.readString(legacyFile))
                _profiles.value = listOf(p)
                _activeId.value = p.deviceId
                recomputeActive()
                persist()
                Files.deleteIfExists(legacyFile)
            }.onFailure {
                DebugLog.d("ProfileStore") { "legacy profile.json unreadable — starting fresh: ${it.message}" }
            }
        }
    }

    private fun persist() {
        Files.createDirectories(storeDir)
        val body = ProfilesFile(
            activeId = _activeId.value,
            profiles = _profiles.value,
            lastServerUrl = _lastServerUrl.value,
            recentIds = recentIds.toList(),
        )
        val serialized = json.encodeToString(ProfilesFile.serializer(), body)

        // Atomic write: serialize to a sibling temp file, then rename over
        // the real file. A crash mid-write can only leave the *temp* file
        // half-written — the real profiles.json (which holds every refresh
        // token) is never observed truncated. Without this, a crash during
        // writeString could zero out the file and force re-login of EVERY
        // paired profile. Create the temp with 0600 from the start so the
        // tokens are never briefly world-readable.
        val tmp = storeDir.resolve("profiles.json.tmp")
        try {
            val perms = PosixFilePermissions.fromString("rw-------")
            Files.deleteIfExists(tmp)
            runCatching {
                Files.createFile(tmp, PosixFilePermissions.asFileAttribute(perms))
            }.onFailure {
                // Non-POSIX (Windows) — createFile without the perm attr;
                // NTFS ACLs inherit from the (user-private) home dir.
                if (!Files.exists(tmp)) Files.createFile(tmp)
            }
            Files.writeString(tmp, serialized)
            // Re-assert 0600 on POSIX in case the FS didn't honor the attr.
            runCatching { Files.setPosixFilePermissions(tmp, perms) }
            // ATOMIC_MOVE so the swap is a single rename syscall. Fall back
            // to a plain move if the FS can't do atomic (rare; e.g. crossing
            // a mount — but tmp is a sibling so same FS in practice).
            try {
                Files.move(tmp, storeFile,
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(tmp, storeFile, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            }
            // Re-assert perms on the destination (REPLACE_EXISTING may keep
            // the old file's perms on some platforms).
            runCatching { Files.setPosixFilePermissions(storeFile, perms) }
        } catch (e: Exception) {
            // Last-resort fallback: direct write so we don't silently lose
            // the user's session on an unexpected FS quirk. Non-atomic, but
            // better than dropping the data entirely.
            DebugLog.d("ProfileStore") { "atomic persist failed (${e.message}); falling back to direct write" }
            runCatching {
                Files.writeString(storeFile, serialized)
                Files.setPosixFilePermissions(storeFile, PosixFilePermissions.fromString("rw-------"))
            }
            runCatching { Files.deleteIfExists(tmp) }
        }
    }
}
