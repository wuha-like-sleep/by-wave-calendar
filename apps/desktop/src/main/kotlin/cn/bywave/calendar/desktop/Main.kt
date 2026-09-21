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
import cn.bywave.calendar.desktop.util.DebugLog

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
// 暗色配色:1.0.15 只改了 surface 一个颜色就启用,其余中性色留给
// Material 默认值 —— 卡片(surfaceVariant 低透明度铺底)、网格线
// (outlineVariant)在近黑底上几乎糊成一片,用户反馈「看不清」。
// 现在把每个中性角色显式定死,保证:
//   正文 onSurface / 次要文字 onSurfaceVariant 对 surface 的对比度
//   都在 WCAG AA(≥4.5:1)以上;卡片和网格线对底色有可见落差。
private val DarkColors = darkColorScheme(
    primary = BrandPurpleDark,
    onPrimary = Color(0xFF2A1A5E),        // 深紫压在浅紫上(今日圆点)
    secondary = BrandPurpleDark,
    tertiary = BrandPurpleDark,
    background = Color(0xFF121216),
    onBackground = Color(0xFFEDEDF2),
    surface = Color(0xFF17171C),          // 比 background 略亮 → 卡片能浮起来
    onSurface = Color(0xFFEDEDF2),        // 对 surface ≈ 14:1
    // 下面两个值是按「乘完 alpha 之后的实际对比度」反推的,不是拍脑袋:
    // 卡片用 surfaceVariant×0.35、网格线用 outlineVariant×0.5 铺底,
    // 1.0.16 的取值算出来只有 1.1~1.3:1 —— 这就是截图里顶栏/表头/网格
    // 糊成一片黑的原因。现在分别做到 ≈1.3:1 和 ≈1.9:1。
    surfaceVariant = Color(0xFF565664),   // ×0.35 → #2D2D35,对 surface 1.31:1
    onSurfaceVariant = Color(0xFFC3C3CE), // 次要文字,对 surface ≈ 10:1
    outline = Color(0xFF8A8A98),
    outlineVariant = Color(0xFF767683),   // ×0.5 → #464650,对 surface 1.92:1
    errorContainer = Color(0xFF5C1A1A),
    onErrorContainer = Color(0xFFFFD9D6),
    primaryContainer = Color(0xFF3A2A78),
    onPrimaryContainer = Color(0xFFE7DDFF),
)

fun main() = application {
    // Initialize i18n before the first @Composable mounts so the initial
    // tree renders in the user's chosen language (no flash of English).
    cn.bywave.calendar.desktop.i18n.I18n.init()
    // Load reminder prefs (enabled + lead time) before the scheduler starts.
    cn.bywave.calendar.desktop.data.notify.ReminderPrefs.init()
    // 外观偏好要在第一帧之前读,否则会闪一下浅色再切深色。
    cn.bywave.calendar.desktop.data.AppearancePrefs.init()

    val state = rememberWindowState(width = 1100.dp, height = 720.dp)
    // 这台机器是不是 macOS —— 关窗行为在 Mac 和 Win/Linux 上必须不一样,
    // 见下面 onCloseRequest 的注释。
    val isMac = remember {
        System.getProperty("os.name").orEmpty().lowercase().contains("mac")
    }
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
                        DebugLog.d("ByWave") { "dock click → window restored" }
                    }
                })
                DebugLog.d("ByWave") { "AppReopenedListener registered" }
            } else {
                DebugLog.d("ByWave") { "APP_EVENT_REOPENED not supported on this JDK/OS" }
            }
        }.onFailure {
            DebugLog.d("ByWave") { "AppReopenedListener registration failed: ${it.message}" }
        }
    }
    Window(
        onCloseRequest = {
            // macOS:关窗 = 隐藏,进程留在 Dock 里(系统惯例)。同时置
            // isMinimized,因为:
            //   - 两个标志都置上时 NSApp 才真的认为窗口「不可见」,点 Dock
            //     图标才稳定触发 applicationShouldHandleReopen。
            //   - 万一 AppReopenedListener 没触发,最小化状态还留着系统
            //     自带的「点 Dock 图标还原」这条后路。
            //
            // Windows / Linux:必须真的退出。这两个平台没有 Dock,菜单栏
            // 又是画在窗口里面的 —— visible=false 之后连任务栏条目都没了,
            // 用户点 X 之后 App 既看不见也点不回来,只能去任务管理器杀进程,
            // 而且下次双击图标还会撞上「已经有一个实例在跑」。所以这里按
            // 平台分岔,别再统一成隐藏。
            if (isMac) {
                state.isMinimized = true
                visible = false
            } else {
                exitApplication()
            }
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
        // 最小窗口尺寸。Compose 的 WindowState 只管「打开时多大」,不管
        // 「能被拖到多小」—— 没有这一行的时候用户可以把窗口拖到一两百
        // 像素宽,顶栏的设置/刷新/搜索图标会被直接切掉(Row 溢出是静默
        // 裁剪,不报错也不换行),侧栏 260dp 又把剩下的宽度吃光,日历区
        // 变成一条缝。960×620 是顶栏紧凑模式 + 侧栏 + 周视图七列都还能
        // 看清的下限。
        //
        // 放在 Window 内容里而不是 rememberWindowState:这是 AWT 层的属性,
        // Compose 没有对应的 DSL 参数。LaunchedEffect(Unit) 保证只设一次。
        LaunchedEffect(Unit) {
            window.minimumSize = java.awt.Dimension(960, 620)
        }

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
                // Quick-add from the menu bar — brings the window forward
                // and opens the new-event dialog. The ShortcutBus collector
                // in MainScreen stays mounted while the window is hidden, so
                // the emitted New action is received even from a hidden app.
                Item(
                    tr("menu.newEvent"),
                    onClick = {
                        visible = true
                        ShortcutBus.flow.tryEmit(ShortcutAction.New)
                    },
                    shortcut = androidx.compose.ui.input.key.KeyShortcut(
                        androidx.compose.ui.input.key.Key.N,
                        meta = true,
                    ),
                )
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
        // 外观由用户在「设置 → 外观」选:浅色(默认)/ 深色 / 跟随系统。
        // 1.0.15 曾直接跟随系统,把深色用户丢进未经验证的暗色配色里,
        // 1.0.17 改回默认浅色 + 显式开关(见 AppearancePrefs 的注释)。
        val appearance by cn.bywave.calendar.desktop.data.AppearancePrefs.mode.collectAsState()
        val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
        val dark = when (appearance) {
            cn.bywave.calendar.desktop.data.AppearancePrefs.Mode.DARK -> true
            cn.bywave.calendar.desktop.data.AppearancePrefs.Mode.LIGHT -> false
            cn.bywave.calendar.desktop.data.AppearancePrefs.Mode.SYSTEM -> systemDark
        }
        MaterialTheme(colorScheme = if (dark) DarkColors else LightColors) {
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
