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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.ui.auth.SetupScreen
import cn.bywave.calendar.desktop.ui.main.MainScreen
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
    val state = rememberWindowState(width = 1100.dp, height = 720.dp)
    Window(
        onCloseRequest = ::exitApplication,
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
        // v0.2 stays light-only; v0.3 reads OS dark-mode pref via
        // currentSystemTheme(). The brand palette stays identical
        // between modes — only neutral surfaces flip.
        MaterialTheme(colorScheme = LightColors) {
            Root()
        }
    }
}

/** Top-level router. v0.2 has exactly two destinations: Setup (sign-in
 *  via QR) and Main (logged-in placeholder). Driven by ProfileStore's
 *  StateFlow — when we save a profile, this auto-recomposes into Main.
 *  Sign-out clears the profile and we slide back to Setup. */
@Composable
private fun Root() {
    val profile by ProfileStore.profile.collectAsState()
    // forceSetup overrides the StateFlow during the brief moment between
    // "user clicked logout" and "profile is cleared", to avoid a single-
    // frame flicker into the post-login screen.
    var forceSetup by remember { mutableStateOf(false) }

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        if (profile == null || forceSetup) {
            SetupScreen(onSignedIn = { forceSetup = false })
        } else {
            MainScreen(onSignedOut = { forceSetup = true })
        }
    }
}
