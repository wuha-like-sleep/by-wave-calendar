// Encrypted refresh-token + server-URL store. Equivalent to the iOS
// Keychain.swift wrapper.
//
// We use EncryptedSharedPreferences because:
//   - Tokens must survive app restart but should be unreadable if the
//     device is rooted / cloned.
//   - Plain SharedPreferences sits in clear text inside /data/data/...
//     which is fine for unrooted phones but trivially extractable on
//     a rooted attacker's device.
//   - Android Keystore (the "real" secure-element path) would require
//     us to wrap every value in EncryptedFile or build a tiny AES
//     layer. EncryptedSharedPreferences does exactly that under the
//     hood and ships in androidx.security.
//
// Single-tenant for v0.1 — only one server / one profile. Multi-account
// support comes in v0.2 (mirroring iOS Profile.swift); we'll switch to
// JSON-serialized Profile records under a single encrypted entry.

package cn.bywave.calendar.data.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TokenStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "bwc-secure-v1",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER_URL, null)
        set(value) = prefs.edit().also {
            if (value == null) it.remove(KEY_SERVER_URL) else it.putString(KEY_SERVER_URL, value)
        }.apply()

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH_TOKEN, null)
        set(value) = prefs.edit().also {
            if (value == null) it.remove(KEY_REFRESH_TOKEN) else it.putString(KEY_REFRESH_TOKEN, value)
        }.apply()

    var userEmail: String?
        get() = prefs.getString(KEY_USER_EMAIL, null)
        set(value) = prefs.edit().also {
            if (value == null) it.remove(KEY_USER_EMAIL) else it.putString(KEY_USER_EMAIL, value)
        }.apply()

    /** Cached in-memory; cleared on signOut(). Not persisted because
     *  access tokens are short-lived (~15min) — re-mint from refresh on
     *  every cold start. */
    @Volatile var accessToken: String? = null

    /** True if we have credentials sufficient to attempt a refresh. */
    val isSignedIn: Boolean
        get() = serverUrl != null && refreshToken != null

    fun signOut() {
        accessToken = null
        prefs.edit().clear().apply()
    }

    private companion object {
        const val KEY_SERVER_URL = "server_url"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        const val KEY_USER_EMAIL = "user_email"
    }
}
