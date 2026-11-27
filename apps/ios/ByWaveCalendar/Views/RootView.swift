// RootView.swift
// The top-level branch: still bootstrapping (silent refresh) → splash.
// Signed in → CalendarView. Otherwise → SetupView.

import SwiftUI

struct RootView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if state.isBootstrapping {
                BootSplashView()
                    .transition(.opacity)
            } else if state.isSignedIn {
                CalendarView()
                    // 换了账号就整个重新挂载日历：CalendarView 的日程、日历列表、
                    // 同步时间都存在它自己的 @State 里，不重新挂载的话，
                    // 换账号之后手上还是上一个账号的日程，要等下一次轮询（最长 60 秒）才换。
                    .id(state.activeProfileId)
                    .transition(.opacity)
            } else {
                SetupView()
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: state.isSignedIn)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: state.isBootstrapping)
        .onOpenURL { url in
            // Invitation deep link: bywave://invitations/<token> —
            // stash the token; CalendarView consumes it once the user
            // is signed in and on screen.
            if url.scheme == "bywave", url.host == "invitations" {
                let token = url.pathComponents.last(where: { $0 != "/" })
                if let token, !token.isEmpty {
                    state.pendingInvitationToken = token
                }
                return
            }
            // Only real files count as import handovers — the bywave://
            // auth callback is handled by ASWebAuthenticationSession,
            // never by URL, so nothing else should land here.
            if url.isFileURL { state.pendingImportURL = url }
        }
    }
}

private struct BootSplashView: View {
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        ZStack {
            // Adaptive gradient — light haze on light mode, near-black
            // on dark so the purple icon still pops in the middle.
            Theme.surfaceGradient(for: colorScheme)
                .ignoresSafeArea()
            VStack(spacing: 18) {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Theme.brandGradient)
                    .frame(width: 64, height: 64)
                    .overlay {
                        Image(systemName: "calendar")
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .shadow(color: Theme.brandShadow, radius: 12, y: 6)
                ProgressView()
                    .controlSize(.regular)
                Text("ByWave Calendar")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
