package cn.bywave.calendar.desktop.ui.theme

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Vector brand mark: crisp on Retina and scaled Windows displays. */
@Composable
fun BrandMark(size: Dp = 36.dp) {
    Canvas(Modifier.size(size)) {
        val u = this.size.width / 32f
        drawRoundRect(Brush.linearGradient(listOf(Color(0xFF6366F1), Color(0xFF4338CA))), cornerRadius = CornerRadius(7 * u))
        drawRoundRect(Color.White, Offset(8 * u, 11 * u), Size(16 * u, 14 * u), CornerRadius(2 * u))
        drawRect(Color(0xFF312E81), Offset(8 * u, 11 * u), Size(16 * u, 4 * u))
        drawCircle(Color.White, 1.5f * u, Offset(12 * u, 9 * u))
        drawCircle(Color.White, 1.5f * u, Offset(20 * u, 9 * u))
    }
}
