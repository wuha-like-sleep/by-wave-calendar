// Persistent profile storage. Single-profile in v0.2 (mirroring Android
// v0.1-v0.4 where multi-account also came late); v0.6+ will switch to
// a List<Profile> the way Android does in ProfileStore.kt.
//
// Storage: ~/.bywave-calendar/profile.json with 0600 permissions when
// the OS supports it (Mac/Linux). Encryption is not used — the file
// is already inside the user's home dir, which standard OS permissions
// protect. Encrypting it would require us to either prompt for a
// master password every launch (UX hell) or store the key alongside
// it (security theater). Mobile uses Keychain/EncryptedSharedPrefs
// because the FS isn't isolated on those platforms; on desktop the
// home dir IS the isolation.

package cn.bywave.calendar.desktop.data.auth

import cn.bywave.calendar.desktop.data.model.Profile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions

object ProfileStore {
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
        explicitNulls = false
    }
    private val storeDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar")
    private val storeFile: Path = storeDir.resolve("profile.json")

    // accessToken is in-memory only — it expires in 1h and we'll
    // refresh via /auth/refresh anyway. Keeping it off disk means a
    // stolen profile.json (e.g. backup leak) only buys the attacker
    // refresh tokens, which the user can revoke from settings.
    private val _profile = MutableStateFlow(load())
    val profile: StateFlow<Profile?> = _profile.asStateFlow()

    @Volatile
    private var accessToken: String? = null

    fun accessToken(): String? = accessToken

    fun setAccessToken(token: String) {
        accessToken = token
    }

    /** Save a freshly-paired profile. Overwrites any existing single-
     *  profile entry. Multi-profile lands in v0.6+. */
    fun save(profile: Profile) {
        Files.createDirectories(storeDir)
        // Best-effort 0600 on POSIX. Windows ignores the call; access
        // is governed by NTFS ACLs which default to user-only anyway.
        try {
            val perms = PosixFilePermissions.fromString("rw-------")
            if (!Files.exists(storeFile)) {
                Files.createFile(storeFile, PosixFilePermissions.asFileAttribute(perms))
            } else {
                Files.setPosixFilePermissions(storeFile, perms)
            }
        } catch (_: UnsupportedOperationException) {
            // Windows / non-POSIX — fine, NTFS ACLs handle it.
        } catch (_: Exception) { /* fs perms are nice-to-have, not required */ }
        Files.writeString(storeFile, json.encodeToString(Profile.serializer(), profile))
        _profile.value = profile
    }

    fun clear() {
        accessToken = null
        try { Files.deleteIfExists(storeFile) } catch (_: Exception) {}
        _profile.value = null
    }

    fun updateRefreshToken(newRefresh: String) {
        val current = _profile.value ?: return
        save(current.copy(refreshToken = newRefresh))
    }

    private fun load(): Profile? {
        return try {
            if (!Files.exists(storeFile)) return null
            json.decodeFromString(Profile.serializer(), Files.readString(storeFile))
        } catch (e: Exception) {
            // Corrupt file shouldn't lock the user out of the APP —
            // we just behave as if there's no saved profile. They'll
            // re-pair via QR.
            System.err.println("[ProfileStore] failed to parse profile.json — ignoring: ${e.message}")
            null
        }
    }
}
