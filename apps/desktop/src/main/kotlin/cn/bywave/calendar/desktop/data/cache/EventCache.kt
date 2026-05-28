// Per-profile event cache. Stale-while-revalidate: on load() we
// immediately return the cached snapshot from disk (instant UI) while
// the network call happens in the background. Once the fresh response
// lands, we replace the in-memory state + persist to disk for the next
// launch.
//
// Storage: ~/.bywave-calendar/event-cache/<deviceId>/<window-key>.json
// — keyed by the deviceId of the active profile so we don't leak data
// across accounts on the same machine. window-key encodes the
// (mode, anchor-date) so each view-mode + date has its own cache.

package cn.bywave.calendar.desktop.data.cache

import cn.bywave.calendar.desktop.data.model.EventsResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermissions

@Serializable
data class CachedEvents(
    val savedAtMs: Long,
    val resp: EventsResponse,
)

object EventCache {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }
    private val cacheDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar", "event-cache")

    private fun profileDir(deviceId: String): Path = cacheDir.resolve(sanitize(deviceId))

    /** Window-key is the fetch range, not the view mode. Same date range
     *  + same profile = same cache entry. Slashes / colons are sanitized
     *  so the filename is filesystem-safe. */
    private fun fileFor(deviceId: String, fromIso: String, toIso: String): Path {
        val key = "${sanitize(fromIso)}_${sanitize(toIso)}.json"
        return profileDir(deviceId).resolve(key)
    }

    private fun sanitize(s: String) = s.replace(Regex("[^A-Za-z0-9._-]"), "_")

    /** Read a cached EventsResponse. Returns null on cache miss, parse
     *  error, or any IO failure — caller falls back to a fresh fetch. */
    fun read(deviceId: String, fromIso: String, toIso: String): EventsResponse? {
        return try {
            val f = fileFor(deviceId, fromIso, toIso)
            if (!Files.exists(f)) return null
            val text = Files.readString(f)
            json.decodeFromString(CachedEvents.serializer(), text).resp
        } catch (_: Exception) {
            null
        }
    }

    /** Best-effort write. Cache failures must NEVER block the UI —
     *  if disk is full or perms are broken, the next launch just
     *  re-fetches as if cache miss. 0700 dir / 0600 file on POSIX. */
    fun write(deviceId: String, fromIso: String, toIso: String, resp: EventsResponse) {
        try {
            val dir = profileDir(deviceId)
            Files.createDirectories(dir)
            try {
                Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------"))
            } catch (_: Exception) { /* Windows or non-POSIX */ }
            val payload = CachedEvents(savedAtMs = System.currentTimeMillis(), resp = resp)
            val f = fileFor(deviceId, fromIso, toIso)
            Files.writeString(f, json.encodeToString(CachedEvents.serializer(), payload))
            try {
                Files.setPosixFilePermissions(f, PosixFilePermissions.fromString("rw-------"))
            } catch (_: Exception) { /* fine */ }
        } catch (_: Exception) { /* swallow */ }
    }

    /** Wipe all cache files for a profile. Called when the user
     *  removes that profile so we don't keep stale events around. */
    fun clear(deviceId: String) {
        try {
            val dir = profileDir(deviceId)
            if (!Files.exists(dir)) return
            Files.walk(dir).sorted(Comparator.reverseOrder())
                .forEach { runCatching { Files.deleteIfExists(it) } }
        } catch (_: Exception) { /* swallow */ }
    }
}
