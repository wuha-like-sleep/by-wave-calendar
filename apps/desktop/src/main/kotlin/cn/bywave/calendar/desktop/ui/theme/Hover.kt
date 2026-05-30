// Desktop hover affordances.
//
// On a mouse-driven desktop, a list row that does nothing on hover feels
// dead — every native macOS / Windows list highlights the row under the
// cursor and shows a hand pointer. Compose's default `clickable` gives a
// press ripple but no hover state, so we add it here once and reuse it on
// the event rows / search results / scope-picker rows.
//
// Implementation note: we drive the highlight off the row's own click
// MutableInteractionSource (collected via collectIsHoveredAsState) and draw
// a translucent onSurface wash on top of the existing card fill. This avoids
// allocating a separate hoverable() node and keeps the press ripple intact.

package cn.bywave.calendar.desktop.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.material3.MaterialTheme

/**
 * Paints a subtle hover / press wash clipped to [shape], driven by
 * [interactionSource]. Pass the SAME MutableInteractionSource you hand to
 * `clickable(interactionSource = …)` so the wash tracks the real hover and
 * press state of the row.
 *
 * The wash is a low-alpha onSurface tint — theme-aware, so it darkens light
 * surfaces and lightens dark ones automatically.
 */
fun Modifier.hoverHighlight(
    interactionSource: MutableInteractionSource,
    shape: Shape = RectangleShape,
): Modifier = composed {
    val hovered by interactionSource.collectIsHoveredAsState()
    val pressed by interactionSource.collectIsPressedAsState()
    val alpha = when {
        pressed -> 0.12f
        hovered -> 0.06f
        else -> 0f
    }
    this.background(
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha),
        shape = shape,
    )
}
