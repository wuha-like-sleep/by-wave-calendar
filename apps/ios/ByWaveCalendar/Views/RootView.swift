// RootView.swift
// The top-level branch: still bootstrapping (silent refresh) → splash.
// Signed in → CalendarView. Otherwise → SetupView.

import SwiftUI

struct RootView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        Group {
            if state.isBootstrapping {
                BootSplashView()
            } else if state.isSignedIn {
                // iPad / unfolded layouts get a 2-column split: sidebar
                // with view mode + nav, main area shows the active grid.
                // iPhone keeps the single-column CalendarView as-is.
                Group {
                    if horizontalSizeClass == .regular {
                        iPadShell()
                    } else {
                        CalendarView()
                    }
                }
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
        .animation(.easeOut(duration: 0.2), value: state.isSignedIn)
        .animation(.easeOut(duration: 0.2), value: state.isBootstrapping)
    }
}

// iPad / regular-size layout. We use NavigationSplitView's sidebar
// column for quick view-mode switching + settings entry, freeing up
// the main column for full-width day/week/month/year grids.
private struct iPadShell: View {
    @EnvironmentObject var state: AppState
    @State private var showingSettings = false

    var body: some View {
        NavigationSplitView {
            List {
                Section("视图") {
                    NavigationLink("日历") { CalendarView() }
                }
                Section("快捷") {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("设置", systemImage: "gearshape")
                    }
                }
                Section("账号") {
                    if let email = state.currentUserEmail {
                        Text(email).font(.caption).foregroundStyle(.secondary)
                    }
                    Button(role: .destructive) {
                        state.signOut()
                    } label: {
                        Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
            .navigationTitle("ByWave")
        } detail: {
            CalendarView()
        }
        .sheet(isPresented: $showingSettings) { SettingsView() }
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
