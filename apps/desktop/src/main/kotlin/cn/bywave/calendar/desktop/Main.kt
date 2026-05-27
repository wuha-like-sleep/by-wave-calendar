// Compose Multiplatform Desktop entry — v0.1 stub. Just opens a window
// with the brand splash + a "open web app" button so we have something
// real to install + sign + notarize end-to-end. Login screen, QR pair,
// and calendar views come in v0.2+.
//
// Design intent: even at v0.1 the window should feel like the same
// product as iOS / Android — same brand color, same vocabulary, same
// "Catalyst app loaded our SwiftUI on Mac" vibe. So the splash here
// mirrors layout.ejs and SwiftUI ByWaveCalendarApp.

package cn.bywave.calendar.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import java.awt.Desktop
import java.net.URI

// Brand palette pulled from Android Theme.kt — keeps Mac+Win window
// chrome visually consistent with the mobile apps.
private val BrandPurple = Color(0xFF6640E9)
private val BrandPurpleDark = Color(0xFFB39DFF)

private val LightColors = lightColorScheme(
    primary = BrandPurple,
    secondary = BrandPurple,
    tertiary = BrandPurple,
)
private val DarkColors = darkColorScheme(
    primary = BrandPurpleDark,
    secondary = BrandPurpleDark,
    tertiary = BrandPurpleDark,
)

fun main() = application {
    val state = rememberWindowState(
        width = 1100.dp,
        height = 720.dp,
    )
    Window(
        onCloseRequest = ::exitApplication,
        state = state,
        title = "ByWave Calendar",
    ) {
        // System dark-mode detection lives in awt's UIManager. For v0.1
        // we just default to light; v0.2 will respect the OS setting via
        // Compose Desktop's currentSystemTheme().
        MaterialTheme(colorScheme = LightColors) {
            App()
        }
    }
}

@Composable
private fun App() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.linearGradient(
                    colors = listOf(
                        Color(0xFFF8FAFC),
                        Color(0xFFEEF2FF),
                        Color(0xFFEDE9FE),
                    ),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp),
            modifier = Modifier.padding(32.dp),
        ) {
            // Brand mark — purple rounded square. Same shape as iOS app
            // icon. v0.2 will replace with actual asset rendered from
            // resources/icons/icon-256.png.
            Box(
                modifier = Modifier
                    .size(96.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(
                        Brush.linearGradient(
                            colors = listOf(BrandPurple, Color(0xFF7C3AED)),
                        ),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "📅",
                    style = MaterialTheme.typography.displayMedium,
                )
            }

            Text(
                "ByWave Calendar",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                color = Color(0xFF0F172A),
            )

            Text(
                "桌面端 v${BuildInfo.VERSION} — 早期预览",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF64748B),
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(8.dp))

            Text(
                "登录与日历视图正在开发中。\n现在可以先打开浏览器使用 web 端。",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF475569),
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(16.dp))

            Button(
                onClick = { openInBrowser("https://rl.lz-ss.com/app") },
                colors = ButtonDefaults.buttonColors(
                    containerColor = BrandPurple,
                ),
                modifier = Modifier.width(240.dp),
            ) {
                Text("在浏览器打开 web 版")
            }

            OutlinedButton(
                onClick = { openInBrowser("https://rl.lz-ss.com/download") },
                modifier = Modifier.width(240.dp),
            ) {
                Text("查看其他下载选项")
            }
        }
    }
}

/** Cross-platform "open URL in default browser" — uses java.awt.Desktop
 *  which delegates to NSWorkspace on Mac / ShellExecute on Win / xdg-open
 *  on Linux. Failure is silent because the user can always copy the URL. */
private fun openInBrowser(url: String) {
    runCatching {
        if (Desktop.isDesktopSupported()) {
            Desktop.getDesktop().browse(URI(url))
        }
    }
}

/** Build-time constants. Generated would be nicer (BuildConfig-style),
 *  but for a stub literal is fine — bump in lockstep with build.gradle.kts
 *  version. v0.2 will codegen this from Gradle. */
internal object BuildInfo {
    const val VERSION = "0.1.0"
}
