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
import SafariServices

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var revoking = false
    @State private var showRevokeAlert = false
    @State private var errorMessage: String?
    // Account-management web sheet — set to a URL when the user taps one
    // of the rows under 「账号管理」. Cleared on dismiss.
    @State private var webURL: URL?
    // True while we're hitting POST /api/v1/auth/web-session to mint the
    // one-shot link — disables the row buttons + shows a spinner.
    @State private var openingWebFor: AccountAction?
    @State private var showDeleteAccountWarning = false
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
                accountManagementSection
                connectionSection
                appearanceSection
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
            .alert("删除账户？", isPresented: $showDeleteAccountWarning) {
                Button("取消", role: .cancel) {}
                Button("继续", role: .destructive) {
                    Task { await openAccountManagement(.deleteAccount) }
                }
            } message: {
                Text("删除账户会同时清除所有日历、事件、订阅、邀请、绑定的设备和 CalDAV 应用密码 — 无法恢复。继续会跳转到浏览器要你输入密码确认。")
            }
            .sheet(item: $webURL) { url in
                // SFSafariViewController auto-uses the system Safari engine
                // so any Passkey / Touch ID / Face ID prompts work natively.
                SafariWebView(url: url)
                    .ignoresSafeArea()
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

    // 账号管理 — each row opens the corresponding web page inside an
    // in-app Safari view, signed in via a one-shot token. So password
    // change / MFA setup / Passkey management / account deletion all
    // happen inside the APP without typing a password.
    private var accountManagementSection: some View {
        Section {
            accountRow(action: .changePassword, label: "修改密码", systemImage: "key.fill")
            accountRow(action: .mfa, label: "二次验证 (MFA)", systemImage: "lock.shield")
            accountRow(action: .passkeys, label: "Passkey 管理", systemImage: "person.badge.key.fill")
            accountRow(action: .ssoBind, label: "第三方账户绑定", systemImage: "link")
            accountRow(action: .deleteAccount, label: "删除账户", systemImage: "trash", role: .destructive)
        } header: {
            Text("账号管理")
        } footer: {
            Text("修改密码 / MFA / Passkey / 删除账户都在浏览器里完成 — 点击会自动登录到对应网页，处理完返回 APP 即可。")
                .font(.footnote)
        }
    }

    @ViewBuilder
    private func accountRow(action: AccountAction, label: String, systemImage: String, role: ButtonRole? = nil) -> some View {
        Button(role: role) {
            if action == .deleteAccount {
                showDeleteAccountWarning = true
            } else {
                Task { await openAccountManagement(action) }
            }
        } label: {
            HStack {
                Label(label, systemImage: systemImage)
                Spacer()
                if openingWebFor == action {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up.right.square")
                        .foregroundStyle(.tertiary)
                        .font(.footnote)
                }
            }
        }
        .disabled(openingWebFor != nil)
    }

    // Hit POST /api/v1/auth/web-session, then present the returned URL.
    // Errors fall back to the inline errorMessage banner.
    private func openAccountManagement(_ action: AccountAction) async {
        openingWebFor = action
        defer { openingWebFor = nil }
        do {
            let client = APIClient(state: state)
            struct Body: Encodable { let next: String }
            struct Resp: Decodable { let url: String }
            let resp: Resp = try await client.post("/auth/web-session", body: Body(next: action.path))
            guard let u = URL(string: resp.url) else {
                errorMessage = "服务器返回的 URL 无效"
                return
            }
            webURL = u
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // 外观 — light / dark / system picker. Persists via AppState's
    // @Published appearance, applied at the root via .preferredColorScheme.
    // No app restart needed; SwiftUI re-renders with the new scheme.
    private var appearanceSection: some View {
        Section {
            Picker("主题", selection: $state.appearance) {
                ForEach(AppearanceMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
        } header: {
            Text("外观")
        } footer: {
            Text("跟随系统时会读 iOS 设置 → 显示与亮度。")
                .font(.footnote)
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
            // open-source project's defaults). All three open inside the
            // APP via SafariViewController so the user doesn't get bounced
            // out to mobile Safari mid-flow.
            if let serverURL = state.serverURL {
                aboutLinkRow(label: "隐私政策", url: serverURL.appendingPathComponent("/privacy"))
                aboutLinkRow(label: "使用条款", url: serverURL.appendingPathComponent("/terms"))
            }
            aboutLinkRow(label: "项目主页", url: URL(string: "https://github.com/wuha-like-sleep/by-wave-calendar")!)
        }
    }

    private func aboutLinkRow(label: String, url: URL) -> some View {
        Button {
            webURL = url
        } label: {
            HStack {
                Text(label).foregroundStyle(.primary)
                Spacer()
                Image(systemName: "arrow.up.right.square")
                    .foregroundStyle(.tertiary).font(.footnote)
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

// MARK: - Account-management web bridge

/// Each row in 账号管理 maps to a web page anchor. The server's
/// /app/auth/from-native validator only accepts paths starting with
/// "/app/", so they're all relative.
enum AccountAction: Equatable {
    case changePassword
    case mfa
    case passkeys
    case ssoBind
    case deleteAccount

    var path: String {
        switch self {
        case .changePassword: return "/app/settings#password"
        case .mfa:            return "/app/settings/mfa/setup"
        case .passkeys:       return "/app/settings#passkeys"
        case .ssoBind:        return "/app/settings#sso"
        case .deleteAccount:  return "/app/settings#danger-zone"
        }
    }
}

/// SwiftUI wrapper around SFSafariViewController. We use the Safari VC
/// (not ASWebAuthenticationSession or WKWebView) because:
///   - it shares cookies / Passkey credentials with mobile Safari, so a
///     Passkey created in Safari is immediately usable inside the APP,
///   - it ships with a built-in "Done" button users instinctively use,
///   - WKWebView wouldn't trigger Apple's native Passkey UI on its own.
struct SafariWebView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let cfg = SFSafariViewController.Configuration()
        cfg.entersReaderIfAvailable = false
        let vc = SFSafariViewController(url: url, configuration: cfg)
        vc.dismissButtonStyle = .done
        return vc
    }
    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

// URL needs Identifiable conformance for sheet(item:) to bind cleanly.
// absoluteString is unique enough for our usage.
extension URL: Identifiable {
    public var id: String { absoluteString }
}
