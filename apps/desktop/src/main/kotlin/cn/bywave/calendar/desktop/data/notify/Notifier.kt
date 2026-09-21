// Cross-platform desktop notification. Fires a native OS banner — no
// persistent tray icon, no dependencies.
//
// Strategy per OS:
//   - macOS:  `osascript -e 'display notification ... with title ...'`
//             → the standard Notification Center banner. Clean, native,
//             no tray icon cluttering the menu bar. This is our primary
//             platform (signed/notarized DMG), so it gets the nicest path.
//   - Windows / Linux: java.awt SystemTray.displayMessage via a transient
//             TrayIcon. SystemTray is available on both; we add an icon,
//             flash the message, and leave the icon (removing it
//             immediately can swallow the balloon on some WMs).
//
// All calls are best-effort: a failure to notify must never crash or block
// the app. Everything is wrapped in runCatching.

package cn.bywave.calendar.desktop.data.notify

import java.awt.SystemTray
import java.awt.TrayIcon
import cn.bywave.calendar.desktop.util.DebugLog

object Notifier {

    private val isMac: Boolean =
        System.getProperty("os.name", "").lowercase().contains("mac")

    // Lazily-created tray icon for the Win/Linux path. Created once and
    // reused so we don't spawn a new icon per notification.
    private var trayIcon: TrayIcon? = null

    /** Show a native notification. Safe to call from any thread; returns
     *  immediately (the macOS path spawns a detached process). */
    fun notify(title: String, body: String) {
        runCatching {
            if (isMac) notifyMac(title, body) else notifyTray(title, body)
        }.onFailure {
            DebugLog.d("Notifier") { "failed: ${it.message}" }
        }
    }

    private fun notifyMac(title: String, body: String) {
        // AppleScript string-escape: backslash + double-quote. osascript
        // takes the script as a single -e arg, so we only need to escape
        // the quotes/backslashes inside the two string literals.
        fun esc(s: String) = s.replace("\\", "\\\\").replace("\"", "\\\"")
        val script = "display notification \"${esc(body)}\" with title \"${esc(title)}\""
        ProcessBuilder("osascript", "-e", script)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .start()
        // Don't waitFor() — fire and forget so a slow osascript never
        // stalls the scheduler coroutine.
    }

    private fun notifyTray(title: String, body: String) {
        if (!SystemTray.isSupported()) return
        val tray = SystemTray.getSystemTray()
        val existing = trayIcon
        if (existing != null) {
            existing.displayMessage(title, body, TrayIcon.MessageType.INFO)
            return
        }
        // 图标必须是一张真的、已经加载好的位图。
        //
        // 这里原本是 `Toolkit.createImage(ByteArray(0))` —— 一个 0 字节的
        // 图源。createImage 不会当场报错，它返回一个「等着异步解码」的 Image，
        // 而解码永远失败：SystemTray.add() 在 Windows / 多数 Linux 桌面上
        // 会因为拿不到像素抛异常，异常又被 runCatching 吞掉，于是 TrayIcon
        // 根本没进托盘，后面每次 displayMessage() 都是空转。
        // 结果就是：设置里提醒开关写着「开」，Mac 上响、Win/Linux 上一声不吭。
        //
        // 换成自己画一张 16×16 的 ARGB 位图：像素是现成的，不需要解码，
        // add() 不会因为图源失败。整体全透明 + 中间一个小方块，托盘里几乎
        // 看不见，但系统认得。
        val img = java.awt.image.BufferedImage(16, 16, java.awt.image.BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        try {
            g.color = java.awt.Color(0x66, 0x40, 0xE9, 0xFF)   // 品牌紫，和窗口里一致
            g.fillRoundRect(3, 3, 10, 10, 3, 3)
        } finally {
            g.dispose()
        }
        val ti = TrayIcon(img, "ByWave Calendar")
        ti.isImageAutoSize = true
        // add() 失败就别留着这个图标：留着的话下一次会走上面的 early-return
        // 分支，对着一个没进托盘的图标反复 displayMessage，永远不响也永远
        // 不再重试。
        val added = runCatching { tray.add(ti) }.isSuccess
        if (!added) {
            DebugLog.d("Notifier") { "SystemTray.add failed; no tray notification this time" }
            return
        }
        trayIcon = ti
        ti.displayMessage(title, body, TrayIcon.MessageType.INFO)
    }
}
