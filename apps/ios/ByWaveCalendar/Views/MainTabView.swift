import SwiftUI

/// The four tabs and their navigation stacks keep the same identity as the
/// sidebar appears or disappears. Only the selected tab owns a navigation bar.
struct MainTabView<CalendarContent: View, CalendarTools: View>: View {
    @EnvironmentObject var state: AppState
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var sidebarCollapsed = false
    let pendingInvitationCount: Int
    @ViewBuilder let calendar: (CalendarNavigationLayout) -> CalendarContent
    @ViewBuilder let calendarTools: () -> CalendarTools

    enum Tab: CaseIterable {
        case calendar, invitations, shopping, settings

        var title: LocalizedStringKey {
            switch self {
            case .calendar: "日历"
            case .invitations: "邀请"
            case .shopping: "购物清单"
            case .settings: "设置"
            }
        }

        var icon: String {
            switch self {
            case .calendar: "calendar"
            case .invitations: "envelope"
            case .shopping: "cart"
            case .settings: "gearshape"
            }
        }

        var label: some View { Label(title, systemImage: icon) }
    }

    @State private var selection: Tab = .calendar
    @State private var invitationOpenToken: String?

    var body: some View {
        GeometryReader { geometry in
            let layout = CalendarNavigationLayout(width: geometry.size.width, regular: sizeClass == .regular,
                                                  accessibilityText: dynamicTypeSize.isAccessibilitySize,
                                                  collapsed: sidebarCollapsed)
            let fallbackRail = needsLegacyRail(size: geometry.size)
            HStack(spacing: 0) {
                if let width = layout.width {
                    VStack(spacing: 0) {
                        if layout.canToggle {
                            Button {
                                sidebarCollapsed.toggle()
                            } label: {
                                Image(systemName: "sidebar.leading")
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel(Text("切换侧边栏"))
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if !layout.showsCalendarTools {
                            ScrollView { railButtons }.scrollIndicators(.hidden)
                        } else {
                            List {
                                Section {
                                    ForEach(Tab.allCases, id: \.self) { destination($0) }
                                }
                                if selection == .calendar { calendarTools() }
                            }
                            .listStyle(.sidebar)
                        }
                    }
                    .frame(width: width)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .background(Color(.secondarySystemGroupedBackground))
                    Divider()
                }
                tabs(layout, hideBar: layout.width != nil || fallbackRail)
                if fallbackRail {
                    ViewThatFits(in: .vertical) {
                        sideRail
                        ScrollView { sideRail }.scrollIndicators(.hidden)
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.trailing, 8)
                }
            }
            .tint(state.themeAccent)
        }
        .onAppear { consumeInvitationToken(state.pendingInvitationToken) }
        .onChange(of: state.pendingInvitationToken) { _, token in consumeInvitationToken(token) }
        .onReceive(NotificationCenter.default.publisher(for: .bwcRemoteDataChanged)) { note in
            if let info = note.userInfo, let token = InvitationPushRouting.token(from: info) {
                consumeInvitationToken(token)
            }
        }
    }

    private func tabs(_ layout: CalendarNavigationLayout, hideBar: Bool) -> some View {
        let visibility: Visibility = hideBar ? .hidden : .automatic
        return TabView(selection: $selection) {
            NavigationStack { calendar(layout) }
                .toolbar(visibility, for: .tabBar)
                .tabItem { Tab.calendar.label }
                .tag(Tab.calendar)
            InvitationsView(openToken: invitationOpenToken, showsDoneButton: false)
                .id(invitationOpenToken)
                .toolbar(visibility, for: .tabBar)
                .tabItem { Tab.invitations.label }
                .tag(Tab.invitations)
                .badge(pendingInvitationCount)
            NavigationStack { ShoppingListsView() }
                .toolbar(visibility, for: .tabBar)
                .tabItem { Tab.shopping.label }
                .tag(Tab.shopping)
            SettingsView(showsDoneButton: false)
                .toolbar(visibility, for: .tabBar)
                .tabItem { Tab.settings.label }
                .tag(Tab.settings)
        }
    }

    private func destination(_ tab: Tab) -> some View {
        Button {
            selection = tab
        } label: {
            tab.label
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .foregroundStyle(selection == tab ? state.themeAccent : Color.primary)
        .listRowBackground(selection == tab ? state.themeAccent.opacity(0.12) : nil)
        .badge(tab == .invitations ? pendingInvitationCount : 0)
        .accessibilityAddTraits(selection == tab ? .isSelected : [])
    }

    private func needsLegacyRail(size: CGSize) -> Bool {
        // With the 27.1 SDK the system places tabs at the device's outer
        // edge, including when the window changes sides in multitasking.
        #if canImport(SwiftUI, _version: 8.1)
        return false
        #else
        guard #available(iOS 27.1, *) else { return false }
        return UIDevice.current.userInterfaceIdiom == .phone && sizeClass == .compact
            && size.height > size.width && size.width >= 420 && size.width / size.height >= 0.62
        #endif
    }

    private var railButtons: some View {
        VStack(spacing: 10) {
            ForEach(Tab.allCases, id: \.self) { railButton($0) }
        }
    }

    private var sideRail: some View {
        railButtons
            .padding(.vertical, 12)
            .padding(.horizontal, 5)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26))
            .overlay(
                RoundedRectangle(cornerRadius: 26)
                    .strokeBorder(Color.primary.opacity(0.08)),
            )
            .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
    }

    private func railButton(_ tab: Tab) -> some View {
        let badge = tab == .invitations ? pendingInvitationCount : 0
        let selected = selection == tab
        return Button {
            selection = tab
        } label: {
            VStack(spacing: 3) {
                Image(systemName: tab.icon)
                    .font(.system(size: 20))
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 {
                            Text("\(badge)")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.red))
                                .offset(x: 10, y: -6)
                        }
                    }
                Text(tab.title)
                    .font(.caption2)
                    .lineLimit(1)
            }
            .foregroundStyle(selected ? state.themeAccent : Color.secondary)
            .frame(width: 54, height: 52)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 15)
                        .fill(state.themeAccent.opacity(0.16))
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(tab.title))
        .accessibilityValue(badge > 0 ? Text(verbatim: String(badge)) : Text(""))
        .accessibilityShowsLargeContentViewer { tab.label }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func consumeInvitationToken(_ token: String?) {
        guard let token else { return }
        state.pendingInvitationToken = nil
        invitationOpenToken = token
        selection = .invitations
    }
}
