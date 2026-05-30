// Theme.swift
// Centralized semantic colors so every view picks the same tokens
// for "subtle background" / "grid line" / "card surface" etc., and
// so light + dark modes both look right without each view
// re-deriving constants like `Color.gray.opacity(0.1)` (which
// looks fine on a white screen and disappears on a black one).
//
// Everything here either:
//   1. Maps to a UIKit system color (auto-adapts to color scheme,
//      respects Increase Contrast / Smart Invert accessibility), or
//   2. Branches on @Environment(\.colorScheme) to pick a hand-tuned
//      light / dark variant.
//
// Don't introduce new `Color.gray.opacity(...)` constants in views —
// add a token here instead so the dark-mode behavior stays consistent.

import SwiftUI

enum Theme {
    // MARK: - Spacing scale
    //
    // A small, deliberate set of gaps so views stop hand-rolling
    // 2/6/14/22 one-offs. Use these for the *structural* gaps that most
    // affect perceived rhythm — section spacing, the gap between a card's
    // body and the next card, padding inside a primary control. Fine
    // optical nudges (a 3pt shadow inset, a 1pt hairline offset) can stay
    // literal; this scale is for the layout grid, not micro-tuning.
    enum Spacing {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
    }

    // MARK: - Corner radii
    //
    // Before this, corners were drawn at 4/7/10/12/14/18/24 with no
    // system — a card here, a button there, all slightly different.
    // Collapse to four roles. `card` is the most visible offender to fix
    // first (every list/grid card should match); `button` is the primary
    // CTA pill. `control` covers smaller inputs/menus; `chip` the little
    // count/status pills.
    enum Radius {
        static let control: CGFloat = 10
        static let card: CGFloat = 12
        static let button: CGFloat = 14
        static let chip: CGFloat = 12
    }

    // MARK: - Surfaces (backgrounds you paint behind content)

    /// Text-field background. Reads as "depressed" against the parent
    /// surface in both light and dark mode. Replaces the old
    /// `Color.gray.opacity(0.1)` we used in SetupView's fields.
    static let fieldBackground = Color(.secondarySystemBackground)

    /// Slight tint behind a region of content — e.g. the all-day strip
    /// in WeekView, the weekday-name row in MonthView. Subtler than
    /// `fieldBackground`; reads as "this row is a different zone".
    static let subtleSurface = Color(.secondarySystemBackground)

    /// Card / pill body fill (e.g. each month card in YearView).
    static let card = Color(.secondarySystemBackground)

    /// Chip / inactive-state pill fill — slightly stronger than `card`
    /// so chips read against a `card` parent. Used by the event-count
    /// badge in YearView and the "用浏览器登录" outlined button.
    static let chip = Color(.tertiarySystemFill)

    // MARK: - Lines (dividers, grid edges, card borders)

    /// Hairline used for hour-of-day rows in WeekView, day-cell borders
    /// in MonthView, card borders in YearView. Adapts: near-black on
    /// light, near-white on dark, both at low alpha.
    static let gridLine = Color(.separator)

    /// Heavier separator — used where a 0.5pt line wouldn't survive
    /// e.g. atop a colored surface.
    static let strongLine = Color(.opaqueSeparator)

    // MARK: - Dim content (visible but secondary glyphs / dots)

    /// Faded dots in YearView's mini-month for "no event" days that
    /// are still inside the month. Replaces `Color.gray.opacity(0.28)`.
    static let dimContent = Color(.tertiaryLabel)

    /// Dots for days that are outside the displayed month entirely.
    /// Replaces `Color.gray.opacity(0.12)`.
    static let veryDimContent = Color(.quaternaryLabel)

    // MARK: - Brand (the iOS app icon's purple gradient)

    /// #4F46E5 — start of the purple → violet brand gradient.
    static let brandStart = Color(red: 0.31, green: 0.27, blue: 0.9)
    /// #7C3AED — end of the brand gradient.
    static let brandEnd = Color(red: 0.49, green: 0.23, blue: 0.93)

    /// Diagonal brand gradient — the splash logo + setup hero use this.
    static let brandGradient = LinearGradient(
        colors: [brandStart, brandEnd],
        startPoint: .topLeading,
        endPoint: .bottomTrailing,
    )

    /// Horizontal brand gradient — primary action buttons use this.
    static let brandGradientHorizontal = LinearGradient(
        colors: [brandStart, brandEnd],
        startPoint: .leading,
        endPoint: .trailing,
    )

    /// Brand drop-shadow color — purple at low alpha, looks good on
    /// both light backgrounds (subtle halo) and dark (slight glow).
    static let brandShadow = brandStart.opacity(0.25)

    // MARK: - Adaptive surface gradient (splash + login backgrounds)

    /// Subtle page-wide gradient. On light mode: faint blue/purple
    /// haze (matches the brand). On dark: deep neutral so the brand
    /// purple icon still pops in the center.
    static func surfaceGradient(for scheme: ColorScheme) -> LinearGradient {
        if scheme == .dark {
            return LinearGradient(colors: [
                Color(white: 0.07),
                Color(white: 0.03),
            ], startPoint: .topLeading, endPoint: .bottomTrailing)
        } else {
            return LinearGradient(colors: [
                Color(red: 0.97, green: 0.98, blue: 0.99),
                Color(red: 0.93, green: 0.94, blue: 1.0),
                Color(red: 0.93, green: 0.91, blue: 0.99),
            ], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }
}
