// Shared empty / placeholder state.
//
// Before this, "no events" / "no results" states were a bare centered
// Text in muted gray — functional but flat, and each screen rolled its
// own. This gives them a consistent shape: an optional muted icon above
// a primary line, with an optional secondary hint and action slot. It
// keeps the same understated tone (no big illustrations) so it still
// reads calm rather than "error".

package cn.bywave.calendar.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.ui.theme.Spacing

@Composable
fun EmptyState(
    title: String,
    // Default fills the available space and centers — right for a screen
    // body. Callers embedded in a scrolling column should pass a bounded
    // modifier (e.g. `Modifier.fillMaxWidth()`) so we don't try to fill
    // an unbounded height.
    modifier: Modifier = Modifier.fillMaxSize(),
    icon: ImageVector? = null,
    subtitle: String? = null,
    action: (@Composable () -> Unit)? = null,
) {
    Box(
        modifier = modifier.padding(Spacing.xxl),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (icon != null) {
                Icon(
                    icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    modifier = Modifier.size(40.dp),
                )
            }
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    textAlign = TextAlign.Center,
                )
            }
            if (action != null) {
                action()
            }
        }
    }
}
