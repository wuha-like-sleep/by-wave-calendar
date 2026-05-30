// Central design tokens — spacing, corner radii, and component sizing.
//
// Before this file, every screen hardcoded its own dp values (cards at
// 12dp here, 8dp there; section gaps of 12/16dp scattered ad-hoc). That
// made the Android UI drift from itself and from iOS. Collecting the
// most-repeated values here lets the screens converge on one rhythm and
// makes a future "tighten everything by 2dp to match iOS" a one-line
// change instead of a 20-file sweep.
//
// Conventions:
//   - `Spacing.*`  — gaps / paddings (4 / 8 / 12 / 16 / 20 / 24).
//   - `Radii.*`    — corner radii for the three card "tiers" we use.
//   - `Sizing.*`   — min touch target + common dot / avatar sizes.
//
// We deliberately keep these as Kotlin objects (not an XML <dimen>
// resource) because the whole UI is Compose — a Kotlin token reads
// `Spacing.md` at the call site, no `dimensionResource()` boilerplate.

package cn.bywave.calendar.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/** Spacing scale. Use these instead of bare `.dp` for paddings + gaps. */
object Spacing {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 24.dp
}

/** Corner radii. `card` is the default rounded surface; `chip` is the
 *  small in-grid event pill; `field` matches text-field / small button. */
object Radii {
    val chip = 4.dp
    val field = 8.dp
    val card = 12.dp

    val cardShape = RoundedCornerShape(card)
    val fieldShape = RoundedCornerShape(field)
    val chipShape = RoundedCornerShape(chip)
}

/** Component sizing. `minTouchTarget` is the Material/WCAG 48dp floor for
 *  anything tappable. `calendarDot` / `avatar` are the recurring circle
 *  sizes used for calendar color dots and profile avatars. */
object Sizing {
    val minTouchTarget = 48.dp
    val calendarDot = 12.dp
    val calendarDotSmall = 10.dp
    val avatar = 36.dp
}
