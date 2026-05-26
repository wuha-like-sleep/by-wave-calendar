// Stable per-install client device UUID.
//
// The server uses this field to dedup re-logins from the same physical
// phone — without it, every "sign out + sign in" creates a brand new
// `devices` row, growing forever and giving the user no way to revoke
// just one. iOS gets the same stable id from iCloud Keychain (so a user
// who restores their phone keeps the same id); on Android we don't have
// the equivalent of iCloud Keychain available APP-side, so we settle for
// "stable across upgrades, regenerated on uninstall" via DataStore.
//
// We deliberately do NOT use ANDROID_ID — Google's official guidance is
// to treat it as device-tracking PII. A random UUID gives the server
// what it needs (dedup) without leaking anything cross-app.

package cn.bywave.calendar.util

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import java.util.UUID

private val Context.clientDeviceIdStore by preferencesDataStore(name = "client_device_id")
private val KEY_ID = stringPreferencesKey("id")

object ClientDeviceId {
    /** Returns the stable id, generating + persisting one on first call.
     *  Blocks briefly on the DataStore read (one row, sub-ms in practice).
     *  Safe to call from any thread — DataStore is internally synchronized. */
    fun get(context: Context): String = runBlocking {
        val ds = context.applicationContext.clientDeviceIdStore
        val existing = ds.data.first()[KEY_ID]
        if (!existing.isNullOrBlank()) return@runBlocking existing
        val fresh = UUID.randomUUID().toString()
        ds.edit { it[KEY_ID] = fresh }
        fresh
    }
}
