package cn.bywave.calendar.desktop.ui.theme

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The approved shared mark, identical to the installed app icon. */
@Composable
fun BrandMark(size: Dp = 36.dp) {
    Image(painterResource("brand-icon.png"), contentDescription = null, modifier = Modifier.size(size))
}
