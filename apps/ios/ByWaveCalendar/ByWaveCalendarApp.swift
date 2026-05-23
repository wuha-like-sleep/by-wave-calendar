// ByWaveCalendarApp.swift
// Top-level SwiftUI App entry. Owns the AppState singleton and decides
// between SetupView (no server configured yet) and CalendarView (signed in).

import SwiftUI

@main
struct ByWaveCalendarApp: App {
    // The single source of truth for the whole app. SwiftUI views observe
    // this and re-render when login state changes.
    @StateObject private var state = AppState()

    // Bridge to UIKit's UIApplicationDelegate — only used for APNs push
    // registration + receiving silent pushes. Everything else stays
    // pure SwiftUI.
    @UIApplicationDelegateAdaptor(PushService.self) var pushService

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                // User-chosen appearance override (Settings → 外观). nil
                // means "follow system" — the @Published appearance on
                // AppState drives this so changes take effect immediately
                // without an app restart.
                .preferredColorScheme(state.appearance.colorScheme)
                .tint(Color(red: 79/255, green: 70/255, blue: 229/255)) // brand-600
                .onAppear {
                    // PushService needs AppState (for serverURL + tokens)
                    // to POST the push token back to the server. Wire it
                    // here once the SwiftUI tree exists.
                    pushService.appState = state
                }
        }
    }
}
