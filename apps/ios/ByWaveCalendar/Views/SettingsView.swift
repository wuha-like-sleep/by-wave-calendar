// SettingsView.swift
// Dedicated settings screen — accessible from CalendarView's toolbar
// ellipsis. Replaces the old "menu with sign out" pattern. Sections:
//   - Account (email, server URL, label)
//   - Sync stats (last refresh, cached events count — placeholder)
//   - App (version, build, log out)
//   - Danger zone (revoke this device)
//
// Sign-out clears local tokens; revoke also tells the server to nuke
// this device's refresh token so it can't refresh after.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var revoking = false
    @State private var showRevokeAlert = false
    @State private var errorMessage: String?
    // EventKit mirror state. Mirrored from EventKitMirror.shared so the
    // toggle UI updates in real time; we re-write it back on toggle.
    @State private var ekMirrorEnabled: Bool = EventKitMirror.shared.isEnabled
    @State private var ekPermissionDenied = false
    // Local notifications mirror — Settings owns the UI; the scheduler
    // lives in LocalNotifications.shared and gets called from
    // CalendarView.load(). Persisted in UserDefaults.
    @State private var notifEnabled: Bool = LocalNotifications.shared.isEnabled
    @State private var notifPermissionDenied = false
    @State private var notifLeadMinutes: Int = LocalNotifications.shared.leadMinutes

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                connectionSection
                eventKitSection
                notificationsSection
                aboutSection
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
                }
                signOutSection
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .alert("解绑当前设备？", isPresented: $showRevokeAlert) {
                Button("取消", role: .cancel) {}
                Button("解绑", role: .destructive) {
                    Task { await revokeThisDevice() }
                }
            } message: {
                Text("解绑后这个 APP 立即失去访问权限，需要重新扫码或用密码登录。服务器端的事件不受影响。")
            }
        }
    }

    private var accountSection: some View {
        Section("帐号") {
            LabeledContent("邮箱") {
                Text(state.currentUserEmail ?? "—").foregroundStyle(.secondary)
            }
            if let name = state.currentUserName, !name.isEmpty {
                LabeledContent("昵称") {
                    Text(name).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var connectionSection: some View {
        Section {
            LabeledContent("服务器") {
                Text(state.serverURL?.absoluteString ?? "—")
                    .foregroundStyle(.secondary)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            LabeledContent("设备名") {
                Text(PairingService.suggestedLabel())
                    .foregroundStyle(.secondary).font(.callout)
            }
        } header: {
            Text("连接")
        } footer: {
            Text("在网页 /app/settings#devices 可以看到所有绑定的设备。")
                .font(.footnote)
        }
    }

    private var eventKitSection: some View {
        Section {
            Toggle("同步到系统日历", isOn: $ekMirrorEnabled)
                .onChange(of: ekMirrorEnabled) { _, newValue in
                    Task { await handleEkToggle(newValue) }
                }
            if ekPermissionDenied {
                Label {
                    Text("没有日历权限。打开 设置 → 隐私 → 日历 → ByWaveCalendar 开启。")
                        .font(.caption).foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
            }
        } header: {
            Text("系统日历")
        } footer: {
            Text("开启后，ByWave 的事件会同步到 iOS「日历」APP 的一个名叫「ByWave Calendar」的子日历里。Spotlight / Siri / 通知中心都能看到。这是单向同步：在 iOS 日历里改了不会同步回 ByWave。关闭会删除已同步的镜像。")
                .font(.footnote)
        }
    }

    private func handleEkToggle(_ enabled: Bool) async {
        if enabled {
            // Request permission lazily on first enable.
            switch EventKitMirror.shared.permission {
            case .granted:
                EventKitMirror.shared.isEnabled = true
                ekPermissionDenied = false
            case .denied:
                // System dialog will not re-appear; user must go to Settings.
                ekMirrorEnabled = false
                ekPermissionDenied = true
            case .notDetermined:
                let granted = await EventKitMirror.shared.requestAccess()
                if granted {
                    EventKitMirror.shared.isEnabled = true
                    ekPermissionDenied = false
                } else {
                    ekMirrorEnabled = false
                    ekPermissionDenied = true
                }
            }
        } else {
            // Tear down the mirror calendar + clear mapping so the next
            // enable starts fresh. User can also leave the calendar in
            // place by just clearing the toggle — but I think the cleaner
            // behavior is "off means gone".
            EventKitMirror.shared.tearDown()
            EventKitMirror.shared.isEnabled = false
        }
    }

    private var notificationsSection: some View {
        Section {
            Toggle("事件开始前提醒", isOn: $notifEnabled)
                .onChange(of: notifEnabled) { _, newValue in
                    Task { await handleNotifToggle(newValue) }
                }
            if notifEnabled {
                Picker("提前", selection: $notifLeadMinutes) {
                    Text("5 分钟").tag(5)
                    Text("10 分钟").tag(10)
                    Text("15 分钟").tag(15)
                    Text("30 分钟").tag(30)
                    Text("1 小时").tag(60)
                    Text("2 小时").tag(120)
                }
                .onChange(of: notifLeadMinutes) { _, newValue in
                    LocalNotifications.shared.leadMinutes = newValue
                    // Re-schedule now so the change takes effect without
                    // waiting for the next CalendarView.load(). We don't
                    // have the events list here — just clear existing
                    // pending. CalendarView's next load reschedules.
                    Task { await LocalNotifications.shared.clearAll() }
                }
            }
            if notifPermissionDenied {
                Label {
                    Text("没有通知权限。打开 设置 → 通知 → ByWaveCalendar 开启。")
                        .font(.caption).foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
            }
        } header: {
            Text("提醒通知")
        } footer: {
            Text("APP 在本地排好通知队列，事件开始前震动 + 弹横幅。完全离线 — 不需要服务器推送配置。一次最多排 32 个最近的事件。")
                .font(.footnote)
        }
    }

    private func handleNotifToggle(_ enabled: Bool) async {
        if enabled {
            let p = await LocalNotifications.shared.permission()
            switch p {
            case .granted:
                LocalNotifications.shared.isEnabled = true
                notifPermissionDenied = false
            case .denied:
                notifEnabled = false
                notifPermissionDenied = true
            case .notDetermined:
                let granted = await LocalNotifications.shared.requestPermission()
                if granted {
                    LocalNotifications.shared.isEnabled = true
                    notifPermissionDenied = false
                } else {
                    notifEnabled = false
                    notifPermissionDenied = true
                }
            }
        } else {
            LocalNotifications.shared.isEnabled = false
            await LocalNotifications.shared.clearAll()
        }
    }

    private var aboutSection: some View {
        Section("关于") {
            LabeledContent("版本") {
                Text("\(PairingService.appVersion) (\(buildNumber))")
                    .foregroundStyle(.secondary).font(.callout)
            }
            // Privacy + Terms live on the connected server, not bundled in
            // the APP — that way they always reflect the server operator's
            // current policy (you on your self-hosted instance, not the
            // open-source project's defaults).
            if let serverURL = state.serverURL {
                Link(destination: serverURL.appendingPathComponent("/privacy")) {
                    LabeledContent("隐私政策") {
                        Image(systemName: "arrow.up.right.square")
                    }
                }
                Link(destination: serverURL.appendingPathComponent("/terms")) {
                    LabeledContent("使用条款") {
                        Image(systemName: "arrow.up.right.square")
                    }
                }
            }
            Link(destination: URL(string: "https://github.com/wuha-like-sleep/by-wave-calendar")!) {
                LabeledContent("项目主页") {
                    Image(systemName: "arrow.up.right.square")
                }
            }
        }
    }

    private var signOutSection: some View {
        Section {
            Button(role: .destructive) {
                showRevokeAlert = true
            } label: {
                if revoking {
                    HStack { ProgressView().controlSize(.small); Text("解绑中…") }
                } else {
                    Label("解绑并退出登录", systemImage: "trash")
                }
            }
            .disabled(revoking)
            Button {
                state.signOut()
            } label: {
                Label("只退出登录（保留服务器端的绑定）", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .disabled(revoking)
        }
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    }

    // Hits DELETE /api/v1/devices/me — but we don't have a /me endpoint
    // yet (server lists devices for the user but doesn't expose which
    // one is "this"). Workaround: list my devices, find the one whose
    // refresh token prefix matches our stored token prefix, then revoke.
    private func revokeThisDevice() async {
        revoking = true
        defer { revoking = false }
        do {
            let client = APIClient(state: state)
            // Fetch the device list and find the row matching our stored
            // refresh token's prefix. The server returns the prefix in
            // the list response specifically for this purpose.
            struct DevicesResp: Decodable {
                let devices: [DeviceRow]
                struct DeviceRow: Decodable { let id: String; let prefix: String }
            }
            let resp: DevicesResp = try await client.get("/devices")
            // Read our stored refresh token to find its prefix.
            guard let refresh = Keychain.read(.refreshToken),
                  let prefix = parsePrefix(refresh)
            else {
                throw APIError.notSignedIn
            }
            guard let mine = resp.devices.first(where: { $0.prefix == prefix }) else {
                // Couldn't identify ourselves — clear locally anyway.
                state.signOut()
                dismiss()
                return
            }
            try await client.delete("/devices/\(mine.id)")
            state.signOut()
            dismiss()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func parsePrefix(_ token: String) -> String? {
        // bwd_<8-char-prefix>_<32-char-secret>
        let parts = token.split(separator: "_")
        guard parts.count >= 3, parts[0] == "bwd" else { return nil }
        return String(parts[1])
    }
}
