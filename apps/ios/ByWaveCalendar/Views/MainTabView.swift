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

    private var tabBarVisibility: Visibility {
        horizontalSizeClass == .regular ? .hidden : .visible
    }

    var body: some View {
        TabView(selection: $selection) {
            CalendarView()
                .tabItem { Label("日历", systemImage: "calendar") }
                .tag(Tab.calendar)
                .toolbarVisibility(tabBarVisibility, for: .tabBar)

            InvitationsView(openToken: invitationOpenToken, showsDoneButton: false)
                .id(invitationOpenToken ?? "")
                .tabItem { Label("我收到的邀请", systemImage: "envelope") }
                .tag(Tab.invitations)
                .badge(state.pendingInvitationCount)
                .toolbarVisibility(tabBarVisibility, for: .tabBar)

            NavigationStack {
                ShoppingListsView()
            }
            .tabItem { Label("购物清单", systemImage: "cart") }
            .tag(Tab.shopping)
            .toolbarVisibility(tabBarVisibility, for: .tabBar)

            SettingsView(showsDoneButton: false)
                .tabItem { Label("设置", systemImage: "gearshape") }
                .tag(Tab.settings)
                .toolbarVisibility(tabBarVisibility, for: .tabBar)
        }
        // Invitation deep link stashed by RootView — consume it
        // once: jump to the invitations tab on that invitation.
        .onChange(of: state.pendingInvitationToken) { _, token in
            guard let token else { return }
            state.pendingInvitationToken = nil
            invitationOpenToken = token
            selection = .invitations
        }
    }
}
