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
