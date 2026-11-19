// 外观偏好 —— 浅色 / 深色 / 跟随系统。持久化到
// ~/.bywave-calendar/appearance(单行 "light" | "dark" | "system"),
// 与 ReminderPrefs / I18n 的纯文件持久化保持一致。
//
// 默认是 SYSTEM(跟随系统)。这个文件只有用户在设置里点过单选才会被
// 写出来,所以「文件不存在 / 内容无效」就等于从没做过选择,这时用默认;
// 文件里写着什么就用什么 —— 显式选过浅色或深色的人,升级后仍然是他们
// 选的那个,不会被新默认顶掉。
//
// 历史:1.0.15 把「跟随系统」硬接上去后,深色系统的用户被直接丢进一套
// 从未经过设计验证的暗色配色里,反馈是「影响正常阅读」,1.0.17 因此改回
// 默认浅色 + 显式开关。如今深浅双色板都已成套手调过,产品上决定默认
// 回到跟随系统;当年那个「替用户决定」的顾虑由上面的文件机制兜底 ——
// 只有从没表过态的人会拿到新默认。
//
// 以 StateFlow 暴露,设置页切换后整棵 Compose 树立即重绘,无需重启。

package cn.bywave.calendar.desktop.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import cn.bywave.calendar.desktop.util.DebugLog

object AppearancePrefs {

    enum class Mode(val code: String) {
        LIGHT("light"),
        DARK("dark"),
        SYSTEM("system"),
        ;

        companion object {
            fun fromCode(code: String?): Mode = entries.firstOrNull { it.code == code } ?: SYSTEM
        }
    }

    private val storeDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar")
    private val storeFile: Path = storeDir.resolve("appearance")

    private val _mode = MutableStateFlow(Mode.SYSTEM)
    val mode: StateFlow<Mode> = _mode.asStateFlow()

    /** Call once at boot, before the first @Composable mounts. */
    fun init() {
        runCatching {
            if (Files.exists(storeFile)) {
                _mode.value = Mode.fromCode(Files.readString(storeFile).trim())
            }
        }
    }

    fun setMode(m: Mode) {
        if (_mode.value == m) return
        _mode.value = m
        runCatching {
            Files.createDirectories(storeDir)
            Files.writeString(storeFile, m.code)
        }.onFailure {
            DebugLog.d("AppearancePrefs") { "failed to persist: ${it.message}" }
        }
    }
}
