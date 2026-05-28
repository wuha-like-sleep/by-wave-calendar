// Main calendar screen — top toolbar (prev / today / next + week label),
// sidebar with the user's calendar list (color swatches), week grid
// taking the rest of the window. v0.3 is read-only; v0.4 adds the
// EventDetailSheet / edit / create flow.
//
// Layout: Column { TopBar; Row { Sidebar (260dp); WeekView (fillMaxSize) } }
// — same shell shape iOS / Android use, just with a real sidebar on
// desktop because we have the screen real estate.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.ui.calendar.CalendarState
import cn.bywave.calendar.desktop.ui.calendar.WeekView
import cn.bywave.calendar.desktop.ui.calendar.formatWeekAnchor
import cn.bywave.calendar.desktop.ui.calendar.parseHex

@Composable
fun MainScreen(
    onSignedOut: () -> Unit,
) {
    val profile by ProfileStore.profile.collectAsState()
    val p = profile

    // Build the API client + state once per profile. If profile flips
    // (sign-out clears it; we'd already have unmounted by then), the
    // key change forces a rebuild.
    val scope = rememberCoroutineScope()
    val state = remember(p?.serverUrl, p?.userId) {
        if (p == null) null else CalendarState(ApiClient(p.serverUrl), scope)
    }

    LaunchedEffect(state) { state?.load() }

    if (p == null || state == null) {
        // Brief flicker window between sign-out and Root's recomposition;
        // showing a tiny spinner avoids a flash of empty content.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val ui by state.ui.collectAsState()

    Column(modifier = Modifier.fillMaxSize()) {
        TopBar(
            weekLabel = formatWeekAnchor(ui.weekStart),
            loading = ui.loading,
            onPrev = { state.previousWeek() },
            onToday = { state.today() },
            onNext = { state.nextWeek() },
            onRefresh = { state.load() },
            onSignOut = {
                ProfileStore.clear()
                onSignedOut()
            },
        )
        HorizontalDivider()

        Row(modifier = Modifier.fillMaxSize()) {
            Sidebar(
                email = p.email,
                serverUrl = p.serverUrl,
                calendars = ui.calendars,
            )
            VerticalDivider()
            Box(modifier = Modifier.fillMaxSize()) {
                WeekView(
                    weekStart = ui.weekStart,
                    events = ui.events,
                    calendars = ui.calendars,
                )
                if (ui.error != null) {
                    ErrorBanner(message = ui.error!!, onRetry = { state.load() })
                }
            }
        }
    }
}

@Composable
private fun TopBar(
    weekLabel: String,
    loading: Boolean,
    onPrev: () -> Unit,
    onToday: () -> Unit,
    onNext: () -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "ByWave Calendar",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.width(24.dp))

        IconButton(onClick = onPrev) {
            Icon(Icons.Default.ChevronLeft, contentDescription = "上一周")
        }
        OutlinedButton(onClick = onToday) { Text("今天") }
        IconButton(onClick = onNext) {
            Icon(Icons.Default.ChevronRight, contentDescription = "下一周")
        }

        Spacer(Modifier.width(16.dp))
        Text(weekLabel, style = MaterialTheme.typography.titleSmall)

        Spacer(Modifier.weight(1f))

        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
            )
            Spacer(Modifier.width(8.dp))
        }
        IconButton(onClick = onRefresh) {
            Icon(Icons.Default.Refresh, contentDescription = "刷新")
        }
        IconButton(onClick = onSignOut) {
            Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = "退出登录")
        }
    }
}

@Composable
private fun Sidebar(
    email: String,
    serverUrl: String,
    calendars: List<cn.bywave.calendar.desktop.data.model.CalendarMeta>,
) {
    Column(
        modifier = Modifier
            .width(260.dp)
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Text(
            email,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            serverUrl,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.outline,
        )
        Spacer(Modifier.height(20.dp))

        Text(
            "我的日历",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))

        if (calendars.isEmpty()) {
            Text(
                "暂无日历",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (cal in calendars) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(12.dp)
                                .clip(CircleShape)
                                .background(parseHex(cal.color)),
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            cal.name,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ErrorBanner(message: String, onRetry: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))
        OutlinedButton(onClick = onRetry) { Text("重试") }
    }
}
