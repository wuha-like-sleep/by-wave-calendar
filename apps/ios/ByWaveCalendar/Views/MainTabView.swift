// MainTabView.swift
// Signed-in root navigation — THREE shapes for three canvases,
// because one bar cannot serve all of them:
//
// 1. Normal iPhone (compact width, ordinary aspect): the standard
//    bottom tab bar （日历 / 邀请 / 购物清单 / 设置）.
// 2. iPhone Duo FOLDED (compact width, canvas ≈466×678pt, aspect
//    ≈0.69 — no normal iPhone is that wide for its height): the
//    bottom bar does NOT dock onto the Duo's side edge strip by
//    itself (verified on the owner's device: build 30's bar stayed
//    floating at the bottom while MEL Loop's and other apps' rails
//    sit on the side). So folded Duo gets an explicit vertical
//    rail on the trailing edge with the same four destinations.
// 3. Expanded canvas (regular width: unfolded Duo, iPad): no tab
//    bar and no rail — navigation belongs to the calendar's
//    split-view sidebar; two navigation systems would fight.
//
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

    /// iPhone Duo folded canvas ≈466×678pt (aspect ≈0.69); every
    /// normal iPhone in portrait is ≤0.56 (the widest, the original
    /// SE, is 375×667). iPad portrait would match the aspect but is
    /// regular width, so the compact check keeps it out.
    private static func isDuoFolded(size: CGSize, compact: Bool) -> Bool {
        compact
            && size.height > size.width
            && size.width >= 420
            && size.width / size.height >= 0.62
    }

    var body: some View {
        GeometryReader { geo in
            let duoRail = Self.isDuoFolded(
                size: geo.size,
                compact: horizontalSizeClass == .compact,
            )
            HStack(spacing: 0) {
                TabView(selection: $selection) {
                    CalendarView()
                        .tabItem { Label("日历", systemImage: "calendar") }
                        .tag(Tab.calendar)
                        .tabBarConditionallyHidden(tabBarHidden || duoRail)

                    InvitationsView(openToken: invitationOpenToken, showsDoneButton: false)
                        .id(invitationOpenToken ?? "")
                        .tabItem { Label("邀请", systemImage: "envelope") }
                        .tag(Tab.invitations)
                        .badge(state.pendingInvitationCount)
                        .tabBarConditionallyHidden(tabBarHidden || duoRail)

                    NavigationStack {
                        ShoppingListsView()
                    }
                    .tabItem { Label("购物清单", systemImage: "cart") }
                    .tag(Tab.shopping)
                    .tabBarConditionallyHidden(tabBarHidden || duoRail)

                    SettingsView(showsDoneButton: false)
                        .tabItem { Label("设置", systemImage: "gearshape") }
                        .tag(Tab.settings)
                        .tabBarConditionallyHidden(tabBarHidden || duoRail)
                }
                if duoRail {
                    VStack {
                        Spacer()
                        sideRail
                        Spacer()
                    }
                    .padding(.trailing, 8)
                }
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
    }

    /// The Duo-folded side rail: the same four destinations as the
    /// tab bar, stacked vertically in a floating glass pill on the
    /// trailing edge — where the owner's other apps put their bars
    /// on this device. Content keeps the remaining width, which
    /// lands close to a normal iPhone's, so the compact layouts
    /// inside each tab need no third variant.
    private var sideRail: some View {
        VStack(spacing: 10) {
            railButton(.calendar, icon: "calendar", label: "日历")
            railButton(
                .invitations,
                icon: "envelope",
                label: "邀请",
                accessibilityName: "我收到的邀请",
                badge: state.pendingInvitationCount,
            )
            railButton(.shopping, icon: "cart", label: "购物清单")
            railButton(.settings, icon: "gearshape", label: "设置")
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 5)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26))
        .overlay(
            RoundedRectangle(cornerRadius: 26)
                .strokeBorder(Color.primary.opacity(0.08)),
        )
        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
    }

    private func railButton(
        _ tab: Tab,
        icon: String,
        label: String,
        accessibilityName: String? = nil,
        badge: Int = 0,
    ) -> some View {
        let selected = selection == tab
        return Button {
            selection = tab
        } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
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
                Text(label)
                    .font(.system(size: 9))
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
        .accessibilityLabel(Text(accessibilityName ?? label))
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
