// 外观偏好 —— 浅色 / 深色 / 跟随系统。持久化到
// ~/.bywave-calendar/appearance(单行 "light" | "dark" | "system"),
// 与 ReminderPrefs / I18n 的纯文件持久化保持一致。
//
// 为什么默认是 LIGHT 而不是 SYSTEM:1.0.15 把「跟随系统」硬接上去后,
// 深色系统的用户被直接丢进一套从未经过设计验证的暗色配色里,反馈是
// 「影响正常阅读」。外观属于个人偏好,不该由一次版本升级替用户决定 ——
// 所以默认沿用 1.0.14 之前的浅色,想要深色的人去设置里主动开。
//
// 以 StateFlow 暴露,设置页切换后整棵 Compose 树立即重绘,无需重启。

package cn.bywave.calendar.desktop.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

object AppearancePrefs {

    enum class Mode(val code: String) {
        LIGHT("light"),
        DARK("dark"),
        SYSTEM("system"),
        ;

        companion object {
            fun fromCode(code: String?): Mode = entries.firstOrNull { it.code == code } ?: LIGHT
        }
    }

    private val storeDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar")
    private val storeFile: Path = storeDir.resolve("appearance")

    private val _mode = MutableStateFlow(Mode.LIGHT)
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
            System.err.println("[AppearancePrefs] failed to persist: ${it.message}")
        }
    }
}
