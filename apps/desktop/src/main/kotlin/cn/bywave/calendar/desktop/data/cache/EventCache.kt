package cn.bywave.calendar.desktop.data.cache

import cn.bywave.calendar.desktop.data.model.EventsResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest

@Serializable
data class CachedEvents(
    val savedAtMs: Long,
    val resp: EventsResponse,
    /** 服务端给这个（账号、窗口）的 ETag，下次刷新拿它做条件请求。
     *  带默认值：旧版本写的快照没有这个字段，照常解码、只是第一次
     *  刷新拿不到 304、刷新完就补上了。 */
    val etag: String? = null,
    /** 这个（账号、窗口）的增量同步令牌（/events/sync 的
     *  nextSyncToken）。它只对同文件里这份快照基线有效：快照在、
     *  令牌就在，基线换了（全量重写）令牌随新基线一起换。带默认
     *  值同上：旧快照没有这个字段，第一次刷新走初始同步补上。 */
    val syncToken: String? = null,
)

/** Bounded, disposable snapshots. Network responses remain authoritative. */
internal class DiskEventCache(private val root: Path, private val now: () -> Long = System::currentTimeMillis) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun directory(profile: String) = root.resolve(hash(profile))
    private fun file(profile: String, from: String, to: String) = directory(profile).resolve(hash("$from\n$to") + ".json")

    @Synchronized fun read(profile: String, from: String, to: String): EventsResponse? =
        readEntry(profile, from, to)?.resp

    /** 连 ETag 一起读：条件请求要拿快照里存的令牌去问服务端。 */
    @Synchronized fun readEntry(profile: String, from: String, to: String): CachedEvents? = try {
        val path = file(profile, from, to)
        if (Files.isSymbolicLink(directory(profile)) || Files.isSymbolicLink(path) || !Files.isRegularFile(path) || Files.size(path) > MAX_BYTES) null
        else {
            val cached = json.decodeFromString(CachedEvents.serializer(), Files.readString(path))
            val age = now() - cached.savedAtMs
            if (age < -300_000 || age > MAX_AGE_MS) { Files.deleteIfExists(path); null } else cached
        }
    } catch (_: Exception) { null }

    @Synchronized fun write(profile: String, from: String, to: String, response: EventsResponse, etag: String? = null, syncToken: String? = null) {
        var temporary: Path? = null
        try {
            val dir = directory(profile)
            if (Files.isSymbolicLink(dir)) return
            Files.createDirectories(dir)
            runCatching { Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------")) }
            val text = json.encodeToString(CachedEvents.serializer(), CachedEvents(now(), response, etag, syncToken))
            if (text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return
            temporary = Files.createTempFile(dir, ".snapshot-", ".tmp")
            runCatching { Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------")) }
            Files.writeString(temporary, text)
            val target = file(profile, from, to)
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING)
            }
            Files.list(dir).use { entries ->
                entries.filter { it.fileName.toString().endsWith(".json") }.toList()
                    .sortedByDescending { Files.getLastModifiedTime(it).toMillis() }
                    .drop(MAX_WINDOWS).forEach { Files.deleteIfExists(it) }
            }
        } catch (_: Exception) { /* A cache failure must never fail an event operation. */ }
        finally { temporary?.let { runCatching { Files.deleteIfExists(it) } } }
    }

    /** 只抹掉这个窗口的同步令牌，快照本体与保存时间不动。同步
     *  通道失败（令牌 410、老服务端没这条路由、响应解不开）后
     *  调用：下次刷新不再拿着废令牌重试增量，而是走初始同步或
     *  ETag 全量。文件不在 / 已损坏时静默无操作；万一写坏了，
     *  readEntry 解码失败按缓存未命中处理，不会卡住用户。 */
    @Synchronized fun clearSyncToken(profile: String, from: String, to: String) {
        try {
            val path = file(profile, from, to)
            if (Files.isSymbolicLink(directory(profile)) || Files.isSymbolicLink(path) || !Files.isRegularFile(path)) return
            val cached = json.decodeFromString(CachedEvents.serializer(), Files.readString(path))
            if (cached.syncToken == null) return
            Files.writeString(path, json.encodeToString(CachedEvents.serializer(), cached.copy(syncToken = null)))
        } catch (_: Exception) { /* A cache failure must never fail an event operation. */ }
    }

    @Synchronized fun clear(profile: String) {
        val paths = mutableListOf(directory(profile))
        // Clean old-version snapshots on sign-out/invalidation, without ever
        // allowing a server-provided ID to select a parent directory.
        if (profile.matches(Regex("[A-Za-z0-9_-]{1,160}"))) paths.add(root.resolve(profile))
        for (dir in paths) runCatching {
            if (Files.exists(dir)) Files.walk(dir).use { entries ->
                entries.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            }
        }
    }

    companion object {
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
        const val MAX_WINDOWS = 32
        private const val MAX_BYTES = 10L * 1024 * 1024
    }
}

object EventCache {
    private val cache by lazy { DiskEventCache(Paths.get(System.getProperty("user.home"), ".bywave-calendar", "event-cache")) }
    fun read(deviceId: String, fromIso: String, toIso: String) = cache.read(deviceId, fromIso, toIso)
    fun readEntry(deviceId: String, fromIso: String, toIso: String) = cache.readEntry(deviceId, fromIso, toIso)
    fun write(deviceId: String, fromIso: String, toIso: String, resp: EventsResponse, etag: String? = null, syncToken: String? = null) = cache.write(deviceId, fromIso, toIso, resp, etag, syncToken)
    fun clearSyncToken(deviceId: String, fromIso: String, toIso: String) = cache.clearSyncToken(deviceId, fromIso, toIso)
    fun clear(deviceId: String) = cache.clear(deviceId)
}
