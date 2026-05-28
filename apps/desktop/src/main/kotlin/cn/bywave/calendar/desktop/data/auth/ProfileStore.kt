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
)

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
    private val accessTokens = mutableMapOf<String, String>()

    init { load() }

    // ---- Read ----

    /** Bearer token for the currently-active profile. */
    fun accessToken(): String? = _activeId.value?.let { accessTokens[it] }

    /** Set the access token for the currently-active profile. */
    fun setAccessToken(token: String) {
        val id = _activeId.value ?: return
        accessTokens[id] = token
    }

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
        recomputeActive()
        persist()
    }

    /** Remove the given profile. If it was active, fall back to the
     *  first remaining profile (or null when the list empties).
     *  Also wipes the event cache so removed-then-re-added accounts
     *  don't see ghost events from before. */
    fun remove(id: String) {
        val list = _profiles.value
        val newList = list.filterNot { it.deviceId == id }
        accessTokens.remove(id)
        // Cache cleanup is best-effort; don't block sign-out on it.
        try {
            cn.bywave.calendar.desktop.data.cache.EventCache.clear(id)
        } catch (_: Exception) { /* swallow */ }
        _profiles.value = newList
        if (_activeId.value == id) {
            _activeId.value = newList.firstOrNull()?.deviceId
        }
        recomputeActive()
        persist()
    }

    /** Remove the currently-active profile. Back-compat with v0.2-v0.5
     *  call sites that only know about single-profile sign-out. */
    fun clear() {
        _activeId.value?.let { remove(it) }
    }

    /** Refresh-rotated token. Updates the active profile's stored
     *  refreshToken on disk (the server occasionally rotates them). */
    fun updateRefreshToken(newRefresh: String) {
        val id = _activeId.value ?: return
        val list = _profiles.value.toMutableList()
        val idx = list.indexOfFirst { it.deviceId == id }
        if (idx < 0) return
        list[idx] = list[idx].copy(refreshToken = newRefresh)
        _profiles.value = list
        recomputeActive()
        persist()
    }

    // ---- Internals ----

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
                System.err.println("[ProfileStore] failed to parse profiles.json — ignoring: ${it.message}")
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
                System.err.println("[ProfileStore] legacy profile.json unreadable — starting fresh: ${it.message}")
            }
        }
    }

    private fun persist() {
        Files.createDirectories(storeDir)
        // Best-effort 0600 on POSIX.
        try {
            val perms = PosixFilePermissions.fromString("rw-------")
            if (!Files.exists(storeFile)) {
                Files.createFile(storeFile, PosixFilePermissions.asFileAttribute(perms))
            } else {
                Files.setPosixFilePermissions(storeFile, perms)
            }
        } catch (_: UnsupportedOperationException) {
            // Windows / non-POSIX — NTFS ACLs handle it.
        } catch (_: Exception) { /* fs perms are nice-to-have */ }
        val body = ProfilesFile(
            activeId = _activeId.value,
            profiles = _profiles.value,
            lastServerUrl = _lastServerUrl.value,
        )
        Files.writeString(storeFile, json.encodeToString(ProfilesFile.serializer(), body))
    }
}
