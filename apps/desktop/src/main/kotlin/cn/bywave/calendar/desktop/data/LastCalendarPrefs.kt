// 上次保存事件用的日历 —— 新建事件时的默认日历记忆。持久化到
// ~/.bywave-calendar/last-calendar(单行日历 id),与 AppearancePrefs /
// ReminderPrefs 的纯文件持久化保持一致。
//
// 在这之前桌面端每次新建都默认列表第一个日历(服务端返回顺序),
// 事件老是落错日历;网页端编辑器早就用 lastCalendarId 记住了上次
// 的选择。这里只记 id:读的时候调用方要拿当前日历列表核对,记的
// 日历被删了 / 换了账号,就自然回退到第一个,不做别的处理。

package cn.bywave.calendar.desktop.data

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

object LastCalendarPrefs {

    private val storeDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar")
    private val storeFile: Path = storeDir.resolve("last-calendar")

    /** The remembered calendar id, or null when never saved / unreadable. */
    fun get(): String? = runCatching {
        if (Files.exists(storeFile)) {
            Files.readString(storeFile).trim().ifEmpty { null }
        } else {
            null
        }
    }.getOrNull()

    fun set(id: String) {
        if (id.isBlank()) return
        runCatching {
            Files.createDirectories(storeDir)
            Files.writeString(storeFile, id)
        }
    }
}
