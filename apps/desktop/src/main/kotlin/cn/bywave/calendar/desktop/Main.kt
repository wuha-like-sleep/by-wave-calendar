// Compose Multiplatform Desktop entry. v0.2 wires the real pair-via-
// phone-scan flow + token persistence; v0.3 replaces the post-login
// placeholder with the actual calendar UI.

package cn.bywave.calendar.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.MenuBar
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.ui.auth.SetupScreen
import cn.bywave.calendar.desktop.ui.main.MainScreen
import cn.bywave.calendar.desktop.ui.main.ShortcutAction
import cn.bywave.calendar.desktop.ui.main.ShortcutBus
import cn.bywave.calendar.desktop.ui.main.keyEventToShortcut

// Brand palette mirrors Android Theme.kt — Mac+Win windows feel like
// the same product as mobile clients.
private val BrandPurple = Color(0xFF6640E9)
private val BrandPurpleDark = Color(0xFFB39DFF)

private val LightColors = lightColorScheme(
    primary = BrandPurple,
    secondary = BrandPurple,
    tertiary = BrandPurple,
    surface = Color(0xFFFAFAFA),
)
private val DarkColors = darkColorScheme(
    primary = BrandPurpleDark,
    secondary = BrandPurpleDark,
    tertiary = BrandPurpleDark,
    surface = Color(0xFF111114),
)

fun main() = application {
    // Initialize i18n before the first @Composable mounts so the initial
    // tree renders in the user's chosen language (no flash of English).
    cn.bywave.calendar.desktop.i18n.I18n.init()

    val state = rememberWindowState(width = 1100.dp, height = 720.dp)
    // Track visibility separately so the close button hides the window
    // (macOS standard behavior — app stays in dock, Cmd+Tab still finds
    // it) instead of quitting outright. Real quit goes through the
    // File menu's "退出" item or Cmd+Q.
    //
    // v0.7.6 reliability: ALSO minimize when hiding. On some macOS / JDK
    // combos `AppReopenedListener` doesn't fire for a visible=false
    // (hidden but not minimized) window — leaving users with no way to
    // get the window back short of menu bar. Setting both
    // (isMinimized=true + visible=false → on close) means clicking the
    // dock icon reliably brings the window back via the standard macOS
    // window-restore flow, AppReopened listener still fires as a
    // fallback for older JDKs.
    var visible by remember { mutableStateOf(true) }

    // macOS Dock-icon re-open handler. When the user X-es the window
    // it just hides (visible=false); clicking the dock icon afterwards
    // SHOULD bring the window back without forcing them up to the
    // menu bar's 「显示窗口」item. AppReopenedListener (java.awt.desktop,
    // JDK 9+) fires for the NSApplicationDelegate's
    // applicationShouldHandleReopen event. We register once at app
    // launch — DisposableEffect would be over-engineering since the
    // listener lives for the whole process life.
    //
    // Wrapped in runCatching because non-macOS JREs can throw
    // UnsupportedOperationException when calling Desktop.getDesktop()
    // or addAppEventListener — silently degrade to "user opens via
    // menu bar" on those platforms.
    LaunchedEffect(Unit) {
        runCatching {
            val desktop = java.awt.Desktop.getDesktop()
            if (desktop.isSupported(java.awt.Desktop.Action.APP_EVENT_REOPENED)) {
                desktop.addAppEventListener(object : java.awt.desktop.AppReopenedListener {
                    override fun appReopened(e: java.awt.desktop.AppReopenedEvent?) {
                        // Un-minimize AND show. onCloseRequest sets BOTH
                        // (see comment there); clear both on reopen so
                        // the window comes back to the same position
                        // it was closed from.
                        state.isMinimized = false
                        visible = true
                        System.err.println("[ByWave] dock click → window restored")
                    }
                })
                System.err.println("[ByWave] AppReopenedListener registered")
            } else {
                System.err.println("[ByWave] APP_EVENT_REOPENED not supported on this JDK/OS")
            }
        }.onFailure {
            System.err.println("[ByWave] AppReopenedListener registration failed: ${it.message}")
        }
    }
    Window(
        onCloseRequest = {
            // Hide AND minimize so:
            //   - On macOS dock click after close, applicationShouldHandle-
            //     Reopen fires reliably (the window is genuinely "not
            //     visible" in NSApp's window-list bookkeeping when
            //     both flags are set).
            //   - If AppReopenedListener doesn't fire for some reason,
            //     the minimized state means the user can still click the
            //     dock icon and get the standard macOS un-minimize behavior.
            //   - On Win/Linux this is just minimize-to-taskbar.
            state.isMinimized = true
            visible = false
        },
        visible = visible,
        state = state,
        title = "ByWave Calendar",
        // Translate global key events to ShortcutBus emissions. We
        // return false (don't consume) so text fields still receive
        // the keystroke when relevant — e.g. typing "T" in the title
        // field shouldn't trigger "jump to today". The ShortcutBus
        // collector in MainScreen ignores Escape / arrows etc. when a
        // dialog has focus by virtue of the dialog being the topmost
        // composable; for letter keys we rely on the modifier check
        // in keyEventToShortcut to avoid stealing typing.
        onPreviewKeyEvent = { e ->
            val action = keyEventToShortcut(e)
            if (action != null) ShortcutBus.flow.tryEmit(action)
            false
        },
    ) {
        // Menu bar — gives the user explicit way to re-show the window
        // (if they closed it and the dock icon isn't around) and a
        // clean "退出" path that maps to Cmd+Q. Without this, hiding
        // the window would feel like the app died.
        // MenuBar items can't reactively re-render based on I18n.current
        // (they're plain JVM Swing menus on macOS, not Compose nodes)
        // — but they re-collect labels each application() recomposition.
        // Switching language in-app updates them on the next paint cycle.
        val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
        val tr = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
        MenuBar {
            Menu(tr("menu.appGroup"), mnemonic = 'B') {
                Item(tr("menu.showWindow"), onClick = { visible = true })
                Item(
                    tr("menu.settings"),
                    onClick = { ShortcutBus.flow.tryEmit(ShortcutAction.OpenSettings) },
                    shortcut = androidx.compose.ui.input.key.KeyShortcut(
                        androidx.compose.ui.input.key.Key.Comma,
                        meta = true,
                    ),
                )
                Item(
                    tr("menu.checkUpdate"),
                    onClick = { ShortcutBus.flow.tryEmit(ShortcutAction.CheckUpdate) },
                    shortcut = androidx.compose.ui.input.key.KeyShortcut(
                        androidx.compose.ui.input.key.Key.U,
                        meta = true,
                    ),
                )
                Separator()
                Item(tr("menu.quit"), onClick = ::exitApplication, shortcut = androidx.compose.ui.input.key.KeyShortcut(
                    androidx.compose.ui.input.key.Key.Q,
                    meta = true,
                ))
            }
        }
        // v0.2 stays light-only; v0.3 reads OS dark-mode pref via
        // currentSystemTheme(). The brand palette stays identical
        // between modes — only neutral surfaces flip.
        MaterialTheme(colorScheme = LightColors) {
            Root()
        }
    }
}

/** Top-level router. Two destinations:
 *    SetupScreen — when no profile is active, OR when the user
 *      explicitly clicks "添加账号" while logged in (forceSetup=true).
 *    MainScreen — when at least one profile is active.
 *  Driven by ProfileStore's StateFlow + a local forceSetup latch.
 *  Sign-out is owned by ProfileStore.clear() which removes the active
 *  profile and promotes the next one (or null when the list empties),
 *  so Root recomposes naturally without needing an onSignedOut event. */
@Composable
private fun Root() {
    val profile by ProfileStore.profile.collectAsState()
    // forceSetup is set when the user picks "添加账号" from the switcher
    // — we want SetupScreen even though a profile is already active.
    // The new pair-claim's save() makes the new profile active and
    // onSignedIn() flips this back off, bringing MainScreen back with
    // the freshly-paired account selected.
    var forceSetup by remember { mutableStateOf(false) }

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        if (profile == null || forceSetup) {
            SetupScreen(onSignedIn = { forceSetup = false })
        } else {
            MainScreen(onAddAccount = { forceSetup = true })
        }
    }
}
