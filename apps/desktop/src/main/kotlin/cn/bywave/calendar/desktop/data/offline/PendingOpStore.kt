// PendingOpStore — 离线写队列的落盘存储。
//
// 一账号一个文件：~/.bywave-calendar/pending-ops/<sha256(账号键)>.json，
// 里面就是 PendingOp 列表的 JSON。写法与 DiskEventCache 同一套：
// 临时文件 + 原子 move、目录 700 / 文件 600、符号链接不跟随。
// 文件很小（几十条条目封顶），@Synchronized 同步读写即可。
//
// 退出登录 / 移除账号都不清这里：没送出去的改动不能因为登出就
// 被扔掉。账号键（serverUrl|email）不变，重新登录就能续传；
// 账号再也不回来，文件就一直躺着，不影响别人。

package cn.bywave.calendar.desktop.data.offline

import cn.bywave.calendar.sync.PendingOp
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest

internal class DiskPendingOpStore(private val root: Path) {
    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(PendingOp.serializer())

    private fun hash(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    private fun file(accountKey: String) = root.resolve(hash(accountKey) + ".json")

    @Synchronized
    fun read(accountKey: String): List<PendingOp> = try {
        val path = file(accountKey)
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path)) {
            emptyList()
        } else {
            json.decodeFromString(serializer, Files.readString(path)).sortedBy { it.seq }
        }
    } catch (_: Exception) {
        emptyList()
    }

    @Synchronized
    fun write(accountKey: String, ops: List<PendingOp>) {
        var temporary: Path? = null
        try {
            if (Files.isSymbolicLink(root)) return
            Files.createDirectories(root)
            runCatching { Files.setPosixFilePermissions(root, PosixFilePermissions.fromString("rwx------")) }
            temporary = Files.createTempFile(root, ".queue-", ".tmp")
            runCatching { Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------")) }
            Files.writeString(temporary, json.encodeToString(serializer, ops))
            val target = file(accountKey)
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (_: Exception) {
            /* 队列落盘失败不能拖垮事件操作本身；内存里那份还在，
               下次入队/重放会再写一次。 */
        } finally {
            temporary?.let { runCatching { Files.deleteIfExists(it) } }
        }
    }
}

object PendingOpStore {
    private val store by lazy {
        DiskPendingOpStore(Paths.get(System.getProperty("user.home"), ".bywave-calendar", "pending-ops"))
    }

    fun read(accountKey: String): List<PendingOp> = store.read(accountKey)
    fun write(accountKey: String, ops: List<PendingOp>) = store.write(accountKey, ops)
}
