// Shared design tokens for the desktop UI.
//
// Before this file the same magic numbers (card corner radius, list-row
// padding, the "surfaceVariant @ 0.5 alpha" card fill, spinner sizes) were
// copy-pasted across DayView / AgendaView / SearchDialog / RecurringScope-
// Picker / SettingsScreen with small drifts (rows were 10dp in one place,
// 12dp in another; spinners 16 vs 18dp). Centralizing them keeps the views
// visually consistent and makes a future restyle a one-line change.
//
// Only values that genuinely repeat live here — one-off layout numbers stay
// inline so this object doesn't become a dumping ground.

package cn.bywave.calendar.desktop.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/** Corner radii, spacing, and component sizes shared across desktop screens. */
object Dimens {
    // ---- Corner radii ----
    /** Cards / surfaces in Settings + dialogs (SectionCard, etc.). */
    val cardRadius = 12.dp
    /** Tappable list rows (event rows, search results, scope picker rows). */
    val rowRadius = 12.dp
    /** Small inline chips (month-cell event chips, week time-grid chips). */
    val chipRadius = 4.dp

    // ---- List-row card fill ----
    /** Alpha applied to surfaceVariant for the soft card fill behind rows. */
    const val cardFillAlpha = 0.5f
    /** Inner padding for a standard tappable list row. */
    val rowPadding = 14.dp

    // ---- Spacing ----
    /** Vertical gap between section blocks / form fields. */
    val sectionGap = 16.dp
    /** Gap between adjacent list rows. */
    val rowGap = 8.dp

    // ---- Progress indicators ----
    /** Inline spinner diameter (toolbar, search-in-progress, QR poll). */
    val spinnerSmall = 18.dp
    /** Stroke width for the small inline spinner. */
    val spinnerStroke = 2.dp

    // ---- Color dot ----
    /** Calendar color dot next to an event title. */
    val colorDot = 10.dp
}

/** Soft card fill shape for a tappable list row. */
val rowShape = RoundedCornerShape(Dimens.rowRadius)
