// SettingsView.swift
// Top-level Settings hub. v0.9.1 restructured into a NavigationLink
// menu so the previously-cluttered single-form is now organized as
// four sub-pages:
//   - 账号       → AccountSettingsPage (email/name + native change-password / delete)
//   - 同步       → SyncSettingsPage (system calendar mirror, notifications, server / device info)
//   - 外观       → AppearanceSettingsPage (theme mode picker)
//   - 关于       → AboutSettingsPage (version + privacy/terms/repo links)
// Plus a top-level Sign-out / Revoke section at the bottom so it's
// still one tap away.
//
// Account-management actions that need server forms not yet ported
// to native (MFA setup / Passkey register / SSO bind) keep using the
// SFSafariViewController web bridge — earmarked for v0.9.2.

import SwiftUI
import SafariServices

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var revoking = false
    @State private var showRevokeAlert = false
    @State private var errorMessage: String?
    /// Web sheet — used by 关于 page links + the not-yet-native account
    /// flows (MFA / Passkey / SSO). Set to a URL to present; cleared
    /// on dismiss.
    @State private var webURL: URL?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        AccountSettingsPage(webURL: $webURL)
                    } label: {
                        navRow(icon: "person.crop.circle", title: "账号",
                               subtitle: state.currentUserEmail ?? "未登录",
                               tint: state.themeAccent)
                    }
                    NavigationLink {
                        SyncSettingsPage()
                    } label: {
                        navRow(icon: "arrow.triangle.2.circlepath",
                               title: "同步与通知",
                               subtitle: "系统日历 · 提醒 · 当前服务器",
                               tint: .blue)
                    }
                    NavigationLink {
                        AppearanceSettingsPage()
                    } label: {
                        navRow(icon: "paintpalette.fill", title: "外观",
                               subtitle: state.appearance.label,
                               tint: .purple)
                    }
                    NavigationLink {
                        AboutSettingsPage(webURL: $webURL)
                    } label: {
                        navRow(icon: "info.circle.fill", title: "关于",
                               subtitle: "v\(PairingService.appVersion) (\(Self.buildNumber))",
                               tint: .gray)
                    }
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
            .sheet(item: $webURL) { url in
                SafariWebView(url: url).ignoresSafeArea()
            }
            .alert("出错了", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } },
            )) {
                Button("好") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    /// Reusable row used by the top-level menu. Tinted icon + title +
    /// subtitle line. Matches iOS Settings convention so it feels native.
    private func navRow(icon: String, title: String, subtitle: String, tint: Color) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 7)
                    .fill(tint.opacity(0.95))
                    .frame(width: 30, height: 30)
                Image(systemName: icon)
                    .foregroundStyle(.white)
                    .font(.system(size: 14, weight: .semibold))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
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
                dismiss()
            } label: {
                Label("只退出登录（保留服务器端的绑定）", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .disabled(revoking)
        }
    }

    static var buildNumber: String {
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
            struct DevicesResp: Decodable {
                let devices: [DeviceRow]
                struct DeviceRow: Decodable { let id: String; let prefix: String }
            }
            let resp: DevicesResp = try await client.get("/devices")
            guard let refresh = Keychain.read(.refreshToken),
                  let prefix = parsePrefix(refresh)
            else {
                throw APIError.notSignedIn
            }
            guard let mine = resp.devices.first(where: { $0.prefix == prefix }) else {
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
        let parts = token.split(separator: "_")
        guard parts.count >= 3, parts[0] == "bwd" else { return nil }
        return String(parts[1])
    }
}

// MARK: - 账号 sub-page

/// User identity + native password-change / native delete / Safari
/// bridge for MFA / Passkey / SSO bind.
struct AccountSettingsPage: View {
    @EnvironmentObject var state: AppState
    @Binding var webURL: URL?
    @State private var showingChangePassword = false
    @State private var showingDeleteAccount = false
    @State private var showingProfileSwitcher = false
    @State private var showingMfa = false
    @State private var openingWebFor: AccountAction?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("身份") {
                LabeledContent("邮箱") {
                    Text(state.currentUserEmail ?? "—").foregroundStyle(.secondary)
                }
                if let name = state.currentUserName, !name.isEmpty {
                    LabeledContent("昵称") {
                        Text(name).foregroundStyle(.secondary)
                    }
                }
                // Account switcher — shows the # of other accounts after
                // the chevron so the user knows how many are stashed.
                Button {
                    showingProfileSwitcher = true
                } label: {
                    HStack {
                        Label("切换账号", systemImage: "arrow.left.arrow.right.circle")
                            .foregroundStyle(.primary)
                        Spacer()
                        if state.profiles.count > 1 {
                            Text("\(state.profiles.count) 个账号")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }

            Section {
                Button {
                    showingChangePassword = true
                } label: {
                    Label("修改密码", systemImage: "key.fill")
                        .foregroundStyle(.primary)
                }
            } header: {
                Text("安全")
            } footer: {
                Text("修改密码后所有其它设备 / 网页会话立即失效，本设备保持登录。")
                    .font(.footnote)
            }

            Section {
                Button {
                    showingMfa = true
                } label: {
                    Label("二次验证 (MFA)", systemImage: "lock.shield")
                        .foregroundStyle(.primary)
                }
                accountBridgeRow(.passkeys, label: "Passkey 管理", systemImage: "person.badge.key.fill")
                accountBridgeRow(.ssoBind, label: "第三方账户绑定", systemImage: "link")
            } header: {
                Text("更多账号设置")
            } footer: {
                Text("Passkey / SSO 绑定暂时在浏览器里完成（自动登录，不用再输密码）。")
                    .font(.footnote)
            }

            Section {
                Button(role: .destructive) {
                    showingDeleteAccount = true
                } label: {
                    Label("删除账户", systemImage: "trash")
                }
            } footer: {
                Text("删除账户会同时清除所有日历、事件、订阅、邀请、绑定的设备和 CalDAV 应用密码 — 无法恢复。")
                    .font(.footnote)
            }
        }
        .navigationTitle("账号")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingChangePassword) {
            NavigationStack {
                ChangePasswordPage(onDone: { showingChangePassword = false })
                    .environmentObject(state)
            }
        }
        .sheet(isPresented: $showingDeleteAccount) {
            NavigationStack {
                DeleteAccountPage(onDone: { showingDeleteAccount = false })
                    .environmentObject(state)
            }
        }
        .sheet(isPresented: $showingProfileSwitcher) {
            ProfileSwitcherView().environmentObject(state)
        }
        .sheet(isPresented: $showingMfa) {
            NavigationStack {
                MfaSettingsPage(onDone: { showingMfa = false })
                    .environmentObject(state)
            }
        }
        .alert("出错了", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } },
        )) {
            Button("好") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    @ViewBuilder
    private func accountBridgeRow(_ action: AccountAction, label: String, systemImage: String) -> some View {
        Button {
            Task { await openAccountManagement(action) }
        } label: {
            HStack {
                Label(label, systemImage: systemImage).foregroundStyle(.primary)
                Spacer()
                if openingWebFor == action {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up.right.square")
                        .foregroundStyle(.tertiary).font(.footnote)
                }
            }
        }
        .disabled(openingWebFor != nil)
    }

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
}

// MARK: - 修改密码 native page

/// Native password-change form. Posts /api/v1/account/password
/// (added server-side in v0.9.1). On success the APP stays signed in
/// (current device's refresh token is preserved), but all OTHER
/// sessions get killed — user gets logged out of the web.
struct ChangePasswordPage: View {
    let onDone: () -> Void
    @EnvironmentObject var state: AppState

    @State private var current: String = ""
    @State private var newPassword: String = ""
    @State private var confirmPassword: String = ""
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var successMessage: String?

    private var canSubmit: Bool {
        !saving && !current.isEmpty && newPassword.count >= 8 && newPassword == confirmPassword
    }

    var body: some View {
        Form {
            Section("当前密码") {
                SecureField("当前密码", text: $current)
                    .textContentType(.password)
            }
            Section {
                SecureField("新密码（至少 8 位）", text: $newPassword)
                    .textContentType(.newPassword)
                SecureField("再次输入新密码", text: $confirmPassword)
                    .textContentType(.newPassword)
                if !newPassword.isEmpty && !confirmPassword.isEmpty && newPassword != confirmPassword {
                    Label("两次输入的密码不一致", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
            } header: {
                Text("新密码")
            } footer: {
                Text("至少 8 位。修改后其它设备 / 网页会话会立即失效，本机保持登录。")
                    .font(.footnote)
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
            }
            if let successMessage {
                Section { Text(successMessage).foregroundStyle(.green).font(.callout) }
            }
        }
        .navigationTitle("修改密码")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { onDone() }.disabled(saving)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: { Task { await save() } }) {
                    if saving { ProgressView().controlSize(.small) }
                    else { Text("保存").bold() }
                }
                .disabled(!canSubmit)
            }
        }
    }

    private func save() async {
        saving = true
        errorMessage = nil
        successMessage = nil
        defer { saving = false }
        do {
            struct Body: Encodable { let currentPassword: String; let newPassword: String }
            struct Resp: Decodable { let ok: Bool }
            let _: Resp = try await APIClient(state: state).post(
                "/account/password",
                body: Body(currentPassword: current, newPassword: newPassword),
            )
            successMessage = "密码已更新 ✓"
            // Small delay so user sees the success message, then close.
            try? await Task.sleep(nanoseconds: 800_000_000)
            onDone()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 删除账户 native page

struct DeleteAccountPage: View {
    let onDone: () -> Void
    @EnvironmentObject var state: AppState

    @State private var password: String = ""
    @State private var confirmation: String = ""
    @State private var saving = false
    @State private var errorMessage: String?

    private let confirmPhrase = "删除我的账号"

    private var canSubmit: Bool {
        !saving && !password.isEmpty && confirmation == confirmPhrase
    }

    var body: some View {
        Form {
            Section {
                Label {
                    Text("删除账户不可恢复。所有日历、事件、订阅、邀请、绑定的设备和 CalDAV 应用密码都会被永久清除。")
                        .font(.callout)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }
            }
            Section("密码确认") {
                SecureField("当前密码", text: $password)
                    .textContentType(.password)
            }
            Section {
                TextField("输入「\(confirmPhrase)」", text: $confirmation)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            } header: {
                Text("二次确认")
            } footer: {
                Text("精确输入「\(confirmPhrase)」六个字以确认操作。")
                    .font(.footnote)
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
            }
        }
        .navigationTitle("删除账户")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { onDone() }.disabled(saving)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive, action: { Task { await delete() } }) {
                    if saving { ProgressView().controlSize(.small) }
                    else { Text("永久删除").bold() }
                }
                .disabled(!canSubmit)
            }
        }
    }

    private func delete() async {
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            struct Body: Encodable { let password: String; let confirm: String }
            struct Resp: Decodable { let ok: Bool }
            let _: Resp = try await APIClient(state: state).post(
                "/account/delete",
                body: Body(password: password, confirm: confirmation),
            )
            // Account is gone server-side. Clean up locally.
            state.signOut()
            onDone()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 同步与通知 sub-page

struct SyncSettingsPage: View {
    @EnvironmentObject var state: AppState
    @State private var ekMirrorEnabled: Bool = EventKitMirror.shared.isEnabled
    @State private var ekPermissionDenied = false
    @State private var notifEnabled: Bool = LocalNotifications.shared.isEnabled
    @State private var notifPermissionDenied = false
    @State private var notifLeadMinutes: Int = LocalNotifications.shared.leadMinutes

    var body: some View {
        Form {
            Section {
                LabeledContent("服务器") {
                    Text(state.serverURL?.absoluteString ?? "—")
                        .foregroundStyle(.secondary).font(.callout)
                        .lineLimit(1).truncationMode(.middle)
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
        .navigationTitle("同步与通知")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func handleEkToggle(_ enabled: Bool) async {
        if enabled {
            switch EventKitMirror.shared.permission {
            case .granted:
                EventKitMirror.shared.isEnabled = true
                ekPermissionDenied = false
            case .denied:
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
            EventKitMirror.shared.tearDown()
            EventKitMirror.shared.isEnabled = false
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
}

// MARK: - 外观 sub-page

struct AppearanceSettingsPage: View {
    @EnvironmentObject var state: AppState
    var body: some View {
        Form {
            Section {
                Picker("主题", selection: $state.appearance) {
                    ForEach(AppearanceMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("主题")
            } footer: {
                Text("跟随系统时会读 iOS 设置 → 显示与亮度。强制浅色 / 深色会忽略系统设定。")
                    .font(.footnote)
            }
            Section {
                LabeledContent("主色") {
                    HStack(spacing: 8) {
                        Circle().fill(state.themeAccent).frame(width: 18, height: 18)
                        Text(state.themeAccentHex).font(.callout.monospaced()).foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("品牌色")
            } footer: {
                Text("APP 的强调色跟随服务器 — 管理员可在网页后台 → 管理 → 设置 → 主题 切换。")
                    .font(.footnote)
            }
        }
        .navigationTitle("外观")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - 关于 sub-page

struct AboutSettingsPage: View {
    @EnvironmentObject var state: AppState
    @Binding var webURL: URL?

    var body: some View {
        Form {
            Section("应用") {
                LabeledContent("版本") {
                    Text("\(PairingService.appVersion) (\(SettingsView.buildNumber))")
                        .foregroundStyle(.secondary).font(.callout)
                }
            }
            // Legal text bundled inside the APP — no Safari, no server
            // URL. Open-source friendly: a fork built from this code
            // doesn't leak the original author's domain into every user's
            // settings. The server's /privacy + /terms pages still exist
            // for WEB users (where the operator can customize them).
            Section {
                NavigationLink {
                    LegalPage(title: "隐私政策", markdownSource: LegalContent.privacy)
                } label: {
                    Label("隐私政策", systemImage: "hand.raised.fill")
                        .foregroundStyle(.primary)
                }
                NavigationLink {
                    LegalPage(title: "使用条款", markdownSource: LegalContent.terms)
                } label: {
                    Label("使用条款", systemImage: "doc.text.fill")
                        .foregroundStyle(.primary)
                }
            } header: {
                Text("法律")
            } footer: {
                Text("APP 本身的政策；服务器运营者另有具体政策时，请咨询服务器管理员。")
                    .font(.footnote)
            }
            Section("项目") {
                aboutLinkRow(label: "GitHub 仓库", url: URL(string: "https://github.com/wuha-like-sleep/by-wave-calendar")!)
            }
        }
        .navigationTitle("关于")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// External link — opens in SafariViewController (only used for the
    /// GitHub repo now; the legal pages render natively above).
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
}

// MARK: - Account-management web bridge

/// Each row in 账号管理 maps to a web page anchor. The server's
/// /app/auth/from-native validator only accepts paths starting with
/// "/app/", so they're all relative.
enum AccountAction: Equatable {
    case changePassword  // now native; kept here for completeness
    case mfa
    case passkeys
    case ssoBind
    case deleteAccount   // now native too

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
