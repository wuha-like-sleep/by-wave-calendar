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
import java.awt.Toolkit
import java.awt.TrayIcon

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
            System.err.println("[Notifier] failed: ${it.message}")
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
        val icon = trayIcon ?: run {
            // A 1x1 transparent image is enough — we don't want a visible
            // tray presence, just the API to flash a balloon. Some WMs
            // require a non-null image.
            val img = Toolkit.getDefaultToolkit().createImage(ByteArray(0))
            val ti = TrayIcon(img, "ByWave Calendar")
            ti.isImageAutoSize = true
            runCatching { tray.add(ti) }
            trayIcon = ti
            ti
        }
        icon.displayMessage(title, body, TrayIcon.MessageType.INFO)
    }
}
