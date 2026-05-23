// ProfileSwitcherView.swift
// Google-style account switcher. Lists every Profile in AppState,
// highlights the active one, lets the user tap to switch + swipe-left
// to remove. "+ 添加另一个账号" at the bottom dismisses the switcher
// and shows SetupView wrapped so the result becomes a new profile
// instead of replacing the current one.
//
// AppState.switchProfile() handles re-bootstrapping the access token,
// clearing the EventKit mirror and notifications, and updating the
// theme accent — the view doesn't need to know any of that.

import SwiftUI

struct ProfileSwitcherView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var showingAddProfile = false
    @State private var pendingRemoveId: String?
    @State private var showingRemoveConfirm = false

    private var sortedProfiles: [Profile] {
        state.profiles.sorted(by: { $0.lastUsedAt > $1.lastUsedAt })
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(sortedProfiles) { profile in
                        Button {
                            if profile.id != state.activeProfileId {
                                state.switchProfile(to: profile.id)
                            }
                            dismiss()
                        } label: {
                            profileRow(profile)
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                pendingRemoveId = profile.id
                                showingRemoveConfirm = true
                            } label: {
                                Label("移除", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text("已登录的账号")
                } footer: {
                    Text("点击切换。左滑账号可以从这台手机移除（服务器上的事件不会被删）。")
                        .font(.footnote)
                }

                Section {
                    Button {
                        showingAddProfile = true
                    } label: {
                        Label("添加另一个账号", systemImage: "plus.circle.fill")
                            .foregroundStyle(state.themeAccent)
                    }
                }
            }
            .navigationTitle("切换账号")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .sheet(isPresented: $showingAddProfile) {
                // Wrap SetupView in a flag so AppState.completePairing
                // knows to ADD a new profile instead of replacing the
                // current one. completePairing already handles this —
                // it de-dups by (serverURL, email), so reusing SetupView
                // unchanged is safe: signing into a new account creates
                // a fresh profile, signing into the same one updates it.
                SetupView()
                    .environmentObject(state)
            }
            .alert("移除这个账号？", isPresented: $showingRemoveConfirm) {
                Button("取消", role: .cancel) {}
                Button("移除", role: .destructive) {
                    if let id = pendingRemoveId {
                        state.removeProfile(id: id)
                    }
                    pendingRemoveId = nil
                }
            } message: {
                Text("移除后这台手机上不再保存这个账号的登录信息，服务器上的事件和绑定的设备不会被删除。")
            }
        }
    }

    @ViewBuilder
    private func profileRow(_ profile: Profile) -> some View {
        HStack(spacing: 12) {
            // Avatar circle — first letter of email, on a tinted bg
            // derived from the profile's accent (or default brand
            // purple if it hasn't fetched yet).
            ZStack {
                Circle()
                    .fill(Color(hex: profile.themeAccentHex) ?? state.themeAccent)
                    .frame(width: 36, height: 36)
                Text(initial(for: profile))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.displayLabel)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(profile.displaySubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if profile.id == state.activeProfileId {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(state.themeAccent)
                    .font(.title3)
            }
        }
        .padding(.vertical, 2)
    }

    private func initial(for profile: Profile) -> String {
        if let email = profile.userEmail, let first = email.first {
            return String(first).uppercased()
        }
        if let host = profile.serverURL?.host, let first = host.first {
            return String(first).uppercased()
        }
        return "?"
    }
}
