package cn.bywave.calendar.desktop.ui.calendar

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalWindowInfo
import java.time.ZoneId

/** Use the JVM display zone, including an explicit -Duser.timezone override.
 * OS timezone changes require a desktop app restart: TimeZone caches the
 * detected ID, so repeated systemDefault() reads are not OS notifications. */
@Composable
internal fun rememberDisplayTimeZone(): ZoneId {
    var zone by remember { mutableStateOf(ZoneId.systemDefault()) }
    val focused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(focused) {
        zone = ZoneId.systemDefault()
    }
    return zone
}
