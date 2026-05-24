// Top-level Compose theme. Every screen wraps its content in
// `ByWaveTheme { ... }` so we don't have to repeat color scheme +
// typography wiring per-screen.
//
// We prefer hand-rolled light/dark schemes over Material You "dynamic
// color" because (a) brand consistency with iOS matters more than
// platform integration for this APP and (b) dynamic color only works
// on Android 12+. Users can still flip light/dark via system settings
// and we'll pick the right scheme automatically.

package cn.bywave.calendar.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColors = lightColorScheme(
    primary = BrandPurple,
    secondary = BrandPurple,
    tertiary = BrandPurple,
    surface = SurfaceLight,
)

private val DarkColors = darkColorScheme(
    primary = BrandPurpleDark,
    secondary = BrandPurpleDark,
    tertiary = BrandPurpleDark,
    surface = SurfaceDark,
)

@Composable
fun ByWaveTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography,
        content = content,
    )
}
