// RootView.swift
// The top-level branch: still bootstrapping (silent refresh) → splash.
// Signed in → CalendarView. Otherwise → SetupView.

import SwiftUI

struct RootView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        Group {
            if state.isBootstrapping {
                BootSplashView()
            } else if state.isSignedIn {
                CalendarView()
                    .transition(.opacity)
            } else {
                SetupView()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: state.isSignedIn)
        .animation(.easeOut(duration: 0.2), value: state.isBootstrapping)
    }
}

private struct BootSplashView: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [
                Color(red: 0.97, green: 0.98, blue: 0.99),
                Color(red: 0.93, green: 0.94, blue: 1.0),
                Color(red: 0.93, green: 0.91, blue: 0.99),
            ], startPoint: .topLeading, endPoint: .bottomTrailing)
                .ignoresSafeArea()
            VStack(spacing: 18) {
                RoundedRectangle(cornerRadius: 16)
                    .fill(LinearGradient(colors: [
                        Color(red: 0.31, green: 0.27, blue: 0.9),
                        Color(red: 0.49, green: 0.23, blue: 0.93),
                    ], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 64, height: 64)
                    .overlay {
                        Image(systemName: "calendar")
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .shadow(color: Color(red: 0.31, green: 0.27, blue: 0.9).opacity(0.25), radius: 12, y: 6)
                ProgressView()
                    .controlSize(.regular)
                Text("ByWave Calendar")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
