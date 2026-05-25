// Profile — one bound account (server + user) on this device.
// Mirrors iOS Profile.swift. Every Profile has its own:
//   - refresh token (long-lived, server-side hashed)
//   - in-memory access token (re-minted on demand from refresh)
//   - Room cache filtered by profile id (rows tagged with profileId)
//
// id is a client-generated UUID — distinct from the server's user id
// or device id, because two different ByWave Calendar servers could
// theoretically issue the same user id. Using a local UUID keeps
// profiles disambiguated even across servers.

package cn.bywave.calendar.data.auth

import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable
data class Profile(
    val id: String = UUID.randomUUID().toString(),
    val serverUrl: String,
    val email: String,
    val displayName: String? = null,
    /** Long-lived refresh token, encrypted at rest. */
    val refreshToken: String,
    /** Wall-clock millis of last activation — used to sort the switcher. */
    val lastUsedAt: Long = System.currentTimeMillis(),
) {
    val initial: String
        get() = email.firstOrNull()?.uppercase() ?: "?"
}
