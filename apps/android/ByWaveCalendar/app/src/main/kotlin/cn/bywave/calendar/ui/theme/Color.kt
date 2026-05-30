// Brand palette. Mirrors the iOS Theme.swift values so a user running
// both APPs sees the same accent purple.
//
// We define one `Purple500` shade for accent and let Material 3's color
// scheme builder (lightColorScheme / darkColorScheme) derive the
// container / on-* variants. Don't try to hand-tune every role; M3
// expects to do that math.

package cn.bywave.calendar.ui.theme

import androidx.compose.ui.graphics.Color

/** Brand accent — sampled from the icon gradient midpoint. */
val BrandPurple = Color(0xFF6640E9)
val BrandPurpleDark = Color(0xFFB39DFF)  // Lighter shade for dark theme onPrimary contrast.

val SurfaceLight = Color(0xFFFAFAFA)
val SurfaceDark = Color(0xFF111114)

// ---- Semantic accents ----
// These two used to be hardcoded literals at their (single) call sites
// (the week-view "now" line and the multi-account avatar dot). Naming
// them here keeps the brand math in one place and documents intent.
// Both are already legible on light + dark surfaces, so we use one value
// for both schemes; if that changes, switch to a colorScheme role.

/** "Now" indicator line + dot in WeekView. A slightly desaturated red so
 *  it reads as a marker, not an error. */
val NowLineRed = Color(0xFFE5484D)

/** Small badge on the avatar hinting "more than one account". */
val MultiAccountGreen = Color(0xFF22C55E)
