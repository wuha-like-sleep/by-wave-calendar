// Placeholder "you're signed in" screen for v0.2. v0.3 replaces this
// with the real calendar week/month view (ported from Android Compose).
// Kept minimal on purpose — having something here at all proves the
// pair → token → store → main transition works end-to-end.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.auth.ProfileStore
import java.awt.Desktop
import java.net.URI

@Composable
fun MainScreen(
    onSignedOut: () -> Unit,
) {
    val profile by ProfileStore.profile.collectAsState()
    val p = profile

    Box(
        modifier = Modifier.fillMaxSize().padding(48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.width(440.dp),
        ) {
            Text("✓ 已登录", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text(
                p?.email.orEmpty(),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                p?.serverUrl.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "桌面端 v0.2 — 日历视图正在开发中。\n暂时可以打开浏览器使用 web 版。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = {
                    val url = "${p?.serverUrl?.removeSuffix("/")}/app"
                    runCatching {
                        if (Desktop.isDesktopSupported()) Desktop.getDesktop().browse(URI(url))
                    }
                },
                modifier = Modifier.width(240.dp),
            ) { Text("打开网页版日历") }
            OutlinedButton(
                onClick = {
                    ProfileStore.clear()
                    onSignedOut()
                },
                modifier = Modifier.width(240.dp),
            ) { Text("退出登录") }
        }
    }
}
