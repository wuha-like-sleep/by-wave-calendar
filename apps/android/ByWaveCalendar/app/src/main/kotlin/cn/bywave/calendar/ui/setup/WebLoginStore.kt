package cn.bywave.calendar.ui.setup

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Survives process eviction while the user is in the browser; never backed up. */
class WebLoginStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(context, "bwc-web-login",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    @Synchronized fun load(): WebLoginRequest? {
        val value = prefs.getString("pending", null) ?: return null
        val request = runCatching { Json.decodeFromString<WebLoginRequest>(value) }.getOrNull()
        if (request == null || request.isExpired()) { clear(); return null }
        return request
    }
    @Synchronized fun save(request: WebLoginRequest) {
        check(prefs.edit().putString("pending", Json.encodeToString(request)).commit())
    }
    @Synchronized fun clear() { prefs.edit().remove("pending").commit() }
}
