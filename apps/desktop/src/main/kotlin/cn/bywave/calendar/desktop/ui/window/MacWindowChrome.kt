// macOS 标题栏融合 —— 不自绘,收拾原生框。
//
// Windows 那边是把系统标题栏整个换掉;macOS 的原生红绿灯按钮本身
// 就是系统观感的一部分,用户嫌的是「两个画风」而不是这三个钮,所以
// 这里走融合路线:通过 JRootPane 的 apple.awt 客户端属性让内容区
// 延伸到标题栏下方、标题栏透明、系统标题文字隐藏 —— 红绿灯浮在
// 应用自己的底色上,窗口看起来是一整块应用界面。内容顶部由 Main.kt
// 留出 TitleBarInset 高的一条空带给红绿灯让位。
//
// 属性在窗口已显示后设置,现代 JDK(本项目是 21)的 CPlatformWindow
// 会即时应用;万一某个 JDK 版本不认,属性会被静默忽略,窗口退回
// 原生标题栏,应用功能不受影响(顶部会多出一条空带,属观感问题,
// 真机验收清单里有这一项)。

package cn.bywave.calendar.desktop.ui.window

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.util.DebugLog
import java.awt.Window
import javax.swing.JFrame

internal object MacWindowChrome {

    /** 红绿灯按钮纵向占的高度;内容从这条线以下开始排。 */
    val TitleBarInset: Dp = 28.dp

    /** 给主窗口开融合标题栏。成功返回 true,失败保持原生框。 */
    fun apply(window: Window): Boolean = runCatching {
        val frame = window as? JFrame ?: return false
        val rootPane = frame.rootPane ?: return false
        rootPane.putClientProperty("apple.awt.fullWindowContent", true)
        rootPane.putClientProperty("apple.awt.transparentTitleBar", true)
        rootPane.putClientProperty("apple.awt.windowTitleVisible", false)
        DebugLog.d("MacWindowChrome") { "full-size content view enabled" }
        true
    }.onFailure {
        DebugLog.d("MacWindowChrome") { "apply failed, keeping native title bar: ${it.message}" }
    }.getOrDefault(false)
}
