// MainTabView.swift
// Signed-in root: a standard tab bar （日历 / 我收到的邀请 /
// 购物清单 / 设置）.
//
// Why a tab bar at all: on iPhone Duo the system docks a standard
// bottom bar onto the folded posture's side edge strip — apps
// without a bar leave that strip empty (the MEL Loop comparison
// the owner pointed at). SwiftUI's TabView is the canonical
// UITabBar, which is exactly what the system docks.
//
// Expanded canvases (regular width: unfolded Duo, iPad) hide the
// tab bar — navigation there belongs to the calendar's split-view
// sidebar, and two navigation systems on one screen would fight.
// Each tab keeps its own stack and the calendar is still a single
// CalendarView instance, so switching tabs or folding never
// rebuilds the calendar (the lesson RootView documents).

import SwiftUI

struct MainTabView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    enum Tab: Hashable {
        case calendar, invitations, shopping, settings
    }

    @State private var selection: Tab = .calendar
    /// Token from a deep link / push: switches to the invitations
    /// tab and opens that invitation. Held here (not cleared after
    /// opening) so the tab's `.id` stays stable; a NEW token
    /// changes the id, remounts the tab and opens the new one.
    @State private var invitationOpenToken: String?

    private var tabBarHidden: Bool { horizontalSizeClass == .regular }

    var body: some View {
        TabView(selection: $selection) {
            CalendarView()
                .tabItem { Label("日历", systemImage: "calendar") }
                .tag(Tab.calendar)
                .tabBarConditionallyHidden(tabBarHidden)

            InvitationsView(openToken: invitationOpenToken, showsDoneButton: false)
                .id(invitationOpenToken ?? "")
                .tabItem { Label("邀请", systemImage: "envelope") }
                .tag(Tab.invitations)
                .badge(state.pendingInvitationCount)
                .tabBarConditionallyHidden(tabBarHidden)

            NavigationStack {
                ShoppingListsView()
            }
            .tabItem { Label("购物清单", systemImage: "cart") }
            .tag(Tab.shopping)
            .tabBarConditionallyHidden(tabBarHidden)

            SettingsView(showsDoneButton: false)
                .tabItem { Label("设置", systemImage: "gearshape") }
                .tag(Tab.settings)
                .tabBarConditionallyHidden(tabBarHidden)
        }
        // 选中态跟随用户的主题强调色（缺省品牌紫），不然标签栏
        // 是系统蓝、日历里是紫，两套颜色打架。
        .tint(state.themeAccent)
        // Invitation deep link stashed by RootView — consume it
        // once: jump to the invitations tab on that invitation.
        .onChange(of: state.pendingInvitationToken) { _, token in
            consumeInvitationToken(token)
        }
        // Cold start / signed-out-then-in: the token can already be
        // stashed BEFORE this view exists, in which case onChange
        // never fires — consume on appear too.
        .onAppear {
            consumeInvitationToken(state.pendingInvitationToken)
        }
    }

    private func consumeInvitationToken(_ token: String?) {
        guard let token else { return }
        state.pendingInvitationToken = nil
        invitationOpenToken = token
        selection = .invitations
    }
}

private extension View {
    /// 条件隐藏标签栏。toolbarVisibility(_:for:) 要 iOS 18 才有，
    /// 本 App 还支持 iOS 17，用 iOS 16 起就有的 toolbar(_:for:)
    /// 达到同一效果（展开态藏、紧凑态露）。
    @ViewBuilder
    func tabBarConditionallyHidden(_ hidden: Bool) -> some View {
        if hidden {
            self.toolbar(.hidden, for: .tabBar)
        } else {
            self
        }
    }
}
