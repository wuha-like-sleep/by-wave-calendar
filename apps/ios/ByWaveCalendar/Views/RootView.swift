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
                // 不按 horizontalSizeClass 换外壳。以前宽屏（iPad / 展开的 iPhone Duo）
                // 走一套带侧栏的 NavigationSplitView、窄屏走 CalendarView，两边各有
                // 一个 CalendarView：Duo 每次折叠/展开、iPad 每次拖分屏，整棵日历都被
                // 换掉——看到哪天、正在写一半的新事件全部丢失。侧栏里也只有
                // 「设置 / 账号 / 退出」，日历自己的工具栏都有。宽屏的日、周、月格子
                // 本来就按宽度铺开，不需要另一套外壳。
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
