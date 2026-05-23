// ByWaveCalendarApp.swift
// Top-level SwiftUI App entry. Owns the AppState singleton and decides
// between SetupView (no server configured yet) and CalendarView (signed in).

import SwiftUI

@main
struct ByWaveCalendarApp: App {
    // The single source of truth for the whole app. SwiftUI views observe
    // this and re-render when login state changes.
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .preferredColorScheme(nil) // follow system; will add a setting later
                .tint(Color(red: 79/255, green: 70/255, blue: 229/255)) // brand-600
        }
    }
}
