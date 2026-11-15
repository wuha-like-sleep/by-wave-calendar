package cn.bywave.calendar.desktop.ui.calendar

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalWindowInfo
import cn.bywave.calendar.desktop.data.time.DesktopTimeZone
import java.time.ZoneId

/** Every window observes the same OS-backed clock; focus also requests an
 * immediate check after returning from system settings or waking the computer. */
@Composable
internal fun rememberDisplayTimeZone(): ZoneId {
    val zone by DesktopTimeZone.zone.collectAsState()
    val focused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(focused) {
        if (focused) DesktopTimeZone.refresh()
    }
    return zone
}
