// 系统「减少动态效果」信号（桌面版）。
//
// Compose Desktop 没有现成的减少动态开关可读，这里按平台各探
// 一处系统设置：Windows 读「动画效果」（SPI_GETCLIENTAREAANIMATION），
// macOS 读通用辅助功能的 reduceMotion。探不到、调用失败、其他
// 平台一律按 false 处理（保持连续）——只有用户在系统里明确关了
// 动画，才让 now-line 回退到每分钟跳格，与安卓读动画缩放、
// iOS 读 accessibilityReduceMotion 的口径一致。读法与时区读取器
// 一样走 JNA + 安全回退，不让一次探针失败影响画线。
//
// 组合时读一次即可：这类系统设置改了通常也要重开窗口才全面
// 生效，与安卓 Motion.kt 的读法一致。

package cn.bywave.calendar.desktop.ui.calendar

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.sun.jna.Library
import com.sun.jna.Memory
import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.win32.StdCallLibrary
import java.util.Locale

/** 系统是否要求减少动态效果。 */
@Composable
internal fun rememberReduceMotion(): Boolean = remember { systemReduceMotion() }

internal fun systemReduceMotion(): Boolean = try {
    val os = System.getProperty("os.name").lowercase(Locale.ROOT)
    when {
        os.startsWith("windows") -> windowsReduceMotion()
        os.startsWith("mac") -> macReduceMotion()
        else -> false
    }
} catch (_: Exception) {
    false
} catch (_: LinkageError) {
    false
}

// SPI_GETCLIENTAREAANIMATION：pvParam 指向一个 BOOL，
// Windows 设置里的「动画效果」关掉时为 FALSE。
private const val SPI_GETCLIENTAREAANIMATION = 0x1042

private interface User32ReduceMotion : StdCallLibrary {
    fun SystemParametersInfoW(
        uiAction: Int,
        uiParam: Int,
        pvParam: Pointer,
        fWinIni: Int,
    ): Boolean

    companion object {
        val INSTANCE: User32ReduceMotion =
            Native.load("user32", User32ReduceMotion::class.java)
    }
}

private fun windowsReduceMotion(): Boolean {
    val value = Memory(4)
    value.clear()
    val ok = User32ReduceMotion.INSTANCE.SystemParametersInfoW(
        SPI_GETCLIENTAREAANIMATION, 0, value, 0,
    )
    if (!ok) return false
    return value.getInt(0) == 0
}

private interface CoreFoundationReduceMotion : Library {
    fun CFStringCreateWithCString(alloc: Pointer?, cStr: String, encoding: Int): Pointer?
    fun CFPreferencesCopyAppValue(key: Pointer, applicationID: Pointer): Pointer?
    fun CFBooleanGetValue(boolean: Pointer): Boolean
    fun CFRelease(value: Pointer)
}

private fun macReduceMotion(): Boolean {
    val foundation = Native.load(
        "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
        CoreFoundationReduceMotion::class.java,
    )
    // kCFStringEncodingUTF8，与时区读取器里用的编码一致。
    val utf8 = 0x08000100
    val key = foundation.CFStringCreateWithCString(null, "reduceMotion", utf8) ?: return false
    val app = foundation.CFStringCreateWithCString(null, "com.apple.universalaccess", utf8)
    if (app == null) {
        foundation.CFRelease(key)
        return false
    }
    return try {
        val value = foundation.CFPreferencesCopyAppValue(key, app) ?: return false
        try {
            foundation.CFBooleanGetValue(value)
        } finally {
            foundation.CFRelease(value)
        }
    } finally {
        foundation.CFRelease(key)
        foundation.CFRelease(app)
    }
}
