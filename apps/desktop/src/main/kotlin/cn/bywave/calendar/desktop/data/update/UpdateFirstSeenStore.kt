// 宽限期的「第一次发现」时刻，按 versionCode 持久化到
// ~/.bywave-calendar/update-first-seen（单行 "<versionCode>:<millis>"），
// 与 AppearancePrefs / LastCalendarPrefs 的纯文件偏好保持一致。
//
// 宽限口径（与安卓一致，判定在 shared 的 Rollout.forceState）：被强升
// 命中后，从第一次发现这个版本起 graceDays 天内只提醒、过后才强升。
// 这个「第一次」绝不能刷新 —— 每次检查都重置的话宽限永远不到期。

package cn.bywave.calendar.desktop.data.update

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

object UpdateFirstSeenStore {
    private val storeDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar")
    private val storeFile: Path = storeDir.resolve("update-first-seen")

    /** 这个 versionCode 第一次被发现的时刻。文件里存的是别的版本
     *  （或不存在/读坏）就以现在为第一次并落盘；存的就是这个版本
     *  则原样返回，不刷新。读写失败一律按「现在」处理 —— 宁可让
     *  宽限从这次重新算，也不能因为一个文件坏掉把用户锁在强升外
     *  （或反过来，第一天就把人锁死）。 */
    fun firstSeenMillis(versionCode: Int): Long {
        val now = System.currentTimeMillis()
        val stored = runCatching {
            if (!Files.exists(storeFile)) return@runCatching null
            val parts = Files.readString(storeFile).trim().split(":")
            if (parts.size == 2) parts[0].toInt() to parts[1].toLong() else null
        }.getOrNull()
        if (stored != null && stored.first == versionCode) return stored.second
        runCatching {
            Files.createDirectories(storeDir)
            Files.writeString(storeFile, "$versionCode:$now")
        }
        return now
    }
}
