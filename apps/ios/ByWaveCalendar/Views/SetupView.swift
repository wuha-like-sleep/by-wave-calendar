// SetupView.swift
// Login screen — 3 sign-in methods sharing one server URL field:
//   1. 邮箱 + 密码（同 web 登录，MFA 用户走 QR）
//   2. 扫描二维码（在 web 端 /app/settings#devices 生成）
//   3. 手动输入 6 位配对码（兼容相机不可用 / 投屏场景）
//
// All three end up calling AppState.completePairing with refresh +
// access tokens. RootView then flips to CalendarView.

import SwiftUI

private enum LoginMethod: String, CaseIterable, Identifiable {
    // Order matters — first wins as the default selection. Scan-first
    // because it's zero-typing: QR encodes both server URL + code so
    // the user just opens the camera. Password is the secondary path
    // when the user can't reach a web browser to generate a QR.
    case scan = "扫码"
    case password = "密码"
    case code = "配对码"
    var id: String { rawValue }

    /// Whether this method needs the user to type a server URL. Scan
    /// embeds the URL in the QR payload, so we hide the field there.
    var needsServerURL: Bool {
        switch self {
        case .scan: return false
        case .password, .code: return true
        }
    }
}

struct SetupView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.colorScheme) private var colorScheme
    // Used when SetupView is presented as a sheet (e.g. ProfileSwitcher's
    // "添加另一个账号"). At root (first sign-in) this dismiss is a no-op,
    // so it's always safe to call after a successful pairing.
    @Environment(\.dismiss) private var dismiss
    @State private var serverURLInput: String = ""
    @State private var method: LoginMethod = .scan

    // Password method
    @State private var email: String = ""
    @State private var password: String = ""

    // Code method
    @State private var manualCode: String = ""

    @State private var showingScanner = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    /// Set when password login succeeded but server requires a TOTP
    /// 6-digit code. Drives the MFA code entry sheet.
    @State private var pendingMfa: PendingMfa?

    // UserDefaults key for "last server URL" — used to prefill the
    // field on a return visit (sign-out → sign-in same server).
    private static let lastServerURLKey = "bwc.serverURL"

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    hero
                    methodPicker
                    // URL field only appears for methods that need it.
                    // Scan-mode shows nothing here — the QR carries the
                    // server URL, so making the user type it again is
                    // pointless and confusing.
                    if method.needsServerURL {
                        serverURLField
                    }
                    // Body per method
                    Group {
                        switch method {
                        case .scan:     scanForm
                        case .password: passwordForm
                        case .code:     codeForm
                        }
                    }
                    // Browser-based login. Covers Passkey + MFA + SSO
                    // without needing native equivalents — we just hand
                    // off to the server's web login flow via
                    // ASWebAuthenticationSession (auto-closes the sheet
                    // when the server redirects to bywave://). Only
                    // shown when we know a server URL (so the user
                    // doesn't see an "open browser" button that 404s
                    // because the field is empty).
                    if method.needsServerURL {
                        browserLoginButton
                    }
                    if let errorMessage {
                        errorBanner(text: errorMessage)
                    }
                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 22).padding(.top, 28)
            }
            .background(bgGradient)
            .sheet(isPresented: $showingScanner) {
                ScannerView { result in
                    showingScanner = false
                    if case .success(let raw) = result {
                        Task { await pairFromScan(raw) }
                    }
                }
            }
            .sheet(item: $pendingMfa) { item in
                NavigationStack {
                    MfaCodeEntrySheet(
                        serverURL: item.serverURL,
                        mfaToken: item.mfaToken,
                        onComplete: { resp in
                            // Lenient parse — server emits Date.toISOString() with
            // fractional seconds which the default ISO8601DateFormatter
            // rejects. See AppState.parseIsoLenient comment for the
            // session-cripping bug that caused.
            let expDate = AppState.parseIsoLenient(resp.accessTokenExpiresAt) ?? Date().addingTimeInterval(3600)
                            state.completePairing(
                                serverURL: item.serverURL,
                                refreshToken: resp.refreshToken,
                                accessToken: resp.accessToken,
                                accessTokenExpiresAt: expDate,
                                userEmail: resp.userEmail,
                                userName: resp.userName,
                            )
                            pendingMfa = nil
                            dismiss()
                        },
                        onCancel: { pendingMfa = nil },
                    )
                }
            }
            .onAppear {
                // Prefill last-used server URL so returning users don't
                // have to re-type "calendar.example.com" every time. New users
                // get an empty field with helper placeholder.
                if serverURLInput.isEmpty,
                   let last = UserDefaults.standard.string(forKey: Self.lastServerURLKey)
                {
                    serverURLInput = last
                }
            }
            .onChange(of: method) { _, _ in
                // Clear errors when user switches methods — prior error
                // (e.g. "邮箱或密码错误") shouldn't follow them into the
                // scan tab.
                errorMessage = nil
            }
        }
    }

    private func errorBanner(text: String) -> some View {
        // Multi-line banner — replaces the single-line red footnote so
        // longer messages (especially the apps_disabled hint) wrap.
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.orange.opacity(0.4), lineWidth: 0.5),
        )
    }

    // MARK: - Hero
    private var hero: some View {
        VStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 18)
                .fill(Theme.brandGradient)
                .frame(width: 72, height: 72)
                .overlay {
                    Image(systemName: "calendar")
                        .font(.system(size: 32, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .shadow(color: Theme.brandShadow, radius: 12, y: 6)
            Text("ByWave Calendar")
                .font(.title2.bold())
            Text("登录你的服务器，开始同步")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Server URL (shared)
    private var serverURLField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("服务器地址")
                .font(.caption).foregroundStyle(.secondary)
            TextField("calendar.example.com", text: $serverURLInput)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Theme.fieldBackground, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    // MARK: - Method picker
    private var methodPicker: some View {
        Picker("登录方式", selection: $method) {
            ForEach(LoginMethod.allCases) { m in
                Text(m.rawValue).tag(m)
            }
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Password
    private var passwordForm: some View {
        VStack(spacing: 12) {
            TextField("邮箱", text: $email)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Theme.fieldBackground, in: RoundedRectangle(cornerRadius: 10))
            SecureField("密码", text: $password)
                .textContentType(.password)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Theme.fieldBackground, in: RoundedRectangle(cornerRadius: 10))
            Button {
                Task { await loginWithPassword() }
            } label: {
                primaryButtonLabel(text: isWorking ? "登录中…" : "登录")
            }
            .disabled(!canSubmitPassword)
            Text("如果你开启了二次验证（MFA），请改用「扫码」")
                .font(.caption2).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    // MARK: - Scan
    private var scanForm: some View {
        VStack(spacing: 14) {
            // Headline + step-by-step in one place — replaces the long
            // dense gray run-on sentence. Numbered list reads faster.
            VStack(alignment: .leading, spacing: 8) {
                Label("快速登录（推荐）", systemImage: "sparkles")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary)
                HStack(alignment: .top, spacing: 8) {
                    stepBadge(1)
                    Text("在电脑或手机浏览器登录你的 ByWave Calendar")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                HStack(alignment: .top, spacing: 8) {
                    stepBadge(2)
                    Text("进入「设置 → 我的设备 → 绑定新设备」")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                HStack(alignment: .top, spacing: 8) {
                    stepBadge(3)
                    Text("用本机相机对准二维码 — 服务器地址和配对码都在码里")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))

            Button {
                showingScanner = true
            } label: {
                HStack(spacing: 10) {
                    if isWorking {
                        ProgressView().controlSize(.small).tint(.white)
                        Text("处理中…").font(.body.weight(.semibold))
                    } else {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 22, weight: .semibold))
                        Text("打开相机扫码").font(.body.weight(.semibold))
                    }
                }
                .frame(maxWidth: .infinity).padding(.vertical, 16)
                .background(brandGradient)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .shadow(color: Theme.brandShadow, radius: 8, y: 4)
            }
            .disabled(isWorking)
        }
    }

    private func stepBadge(_ n: Int) -> some View {
        Text("\(n)")
            .font(.caption.weight(.bold).monospacedDigit())
            .foregroundStyle(.white)
            .frame(width: 18, height: 18)
            .background(Theme.brandStart, in: Circle())
    }

    // MARK: - Manual code
    private var codeForm: some View {
        VStack(spacing: 12) {
            TextField("ABC123", text: $manualCode)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.title3.monospaced())
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12).padding(.vertical, 14)
                .background(Theme.fieldBackground, in: RoundedRectangle(cornerRadius: 10))
            Button {
                Task { await pairWithCode() }
            } label: {
                primaryButtonLabel(text: isWorking ? "登录中…" : "登录")
            }
            .disabled(!canSubmitCode)
        }
    }

    // MARK: - Browser login (covers Passkey / MFA / SSO)
    private var browserLoginButton: some View {
        VStack(spacing: 8) {
            HStack {
                VStack { Divider() }
                Text("或").font(.caption2).foregroundStyle(.tertiary).padding(.horizontal, 8)
                VStack { Divider() }
            }
            .padding(.vertical, 4)
            Button {
                Task { await loginViaBrowser() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "safari").font(.body.weight(.medium))
                    Text("用浏览器登录").font(.body.weight(.medium))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(Theme.chip, in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(.primary)
            }
            .disabled(isWorking || serverURLInput.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    // MARK: - Computed
    private var canSubmitPassword: Bool {
        !isWorking && !serverURLInput.trimmingCharacters(in: .whitespaces).isEmpty
            && !email.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
    }

    private var canSubmitCode: Bool {
        !isWorking && !serverURLInput.trimmingCharacters(in: .whitespaces).isEmpty
            && manualCode.trimmingCharacters(in: .whitespaces).count >= 4
    }

    private var bgGradient: some View {
        // Adaptive — light haze on light mode, deep neutral on dark.
        // Driven by colorScheme so it flips with system appearance.
        Theme.surfaceGradient(for: colorScheme)
            .ignoresSafeArea()
    }

    private var brandGradient: LinearGradient {
        Theme.brandGradientHorizontal
    }

    private func primaryButtonLabel(text: String) -> some View {
        HStack {
            if isWorking { ProgressView().controlSize(.small).tint(.white) }
            Text(text).font(.body.weight(.semibold))
        }
        .frame(maxWidth: .infinity).padding(.vertical, 14)
        .background(brandGradient)
        .foregroundStyle(.white)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .opacity(canSubmitPassword || canSubmitCode ? 1.0 : 0.6)
    }

    // MARK: - Actions

    /// Resolve whatever the user typed into a working URL. Probes https
    /// first then http when no scheme is given, so "calendar.example.com" and
    /// "192.168.1.100:8080" both Just Work. Returns nil only when
    /// neither scheme reaches the server.
    private func normalizedServerURL() async -> URL? {
        let s = serverURLInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        guard let url = await PairingService.probeServerURL(s) else { return nil }
        // Save eagerly so a failed login attempt doesn't make the user
        // re-type the URL next time. completePairing also writes this
        // key on success — duplicate write is harmless.
        UserDefaults.standard.set(url.absoluteString, forKey: Self.lastServerURLKey)
        return url
    }

    private func loginWithPassword() async {
        guard let url = await normalizedServerURL() else {
            errorMessage = "服务器地址无效"; return
        }
        isWorking = true; errorMessage = nil
        defer { isWorking = false }
        do {
            var req = URLRequest(url: url.appendingPathComponent("/api/v1/auth/login-password"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(PasswordLoginInput(
                email: email.trimmingCharacters(in: .whitespaces).lowercased(),
                password: password,
                label: PairingService.suggestedLabel(),
                kind: "ios",
                appVersion: PairingService.appVersion,
                clientDeviceId: Keychain.clientDeviceId(),
            ))
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if http.statusCode != 200 {
                let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                let err = body["error"] as? String
                let msg = body["message"] as? String
                if err == "invalid_credentials" {
                    errorMessage = "邮箱或密码错误"
                } else if err == "account_disabled" {
                    errorMessage = "账号已停用，请联系管理员"
                } else if err == "account_locked" {
                    errorMessage = msg ?? "登录失败次数过多，请稍后再试。"
                } else if err == "apps_disabled" {
                    errorMessage = "管理员未启用 APP 同步功能"
                } else {
                    errorMessage = msg ?? "登录失败 (HTTP \(http.statusCode))"
                }
                return
            }
            // Two possible 200 shapes:
            //   1. mfaPending=true + mfaToken — account has TOTP, prompt
            //      user for the 6-digit code natively.
            //   2. Standard success with tokens.
            let outer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let payload = (outer["data"] as? [String: Any]) ?? outer
            if let pending = payload["mfaPending"] as? Bool, pending,
               let mfaToken = payload["mfaToken"] as? String
            {
                pendingMfa = PendingMfa(serverURL: url, mfaToken: mfaToken)
                return
            }
            let payloadData = try JSONSerialization.data(withJSONObject: payload)
            let r = try JSONDecoder().decode(PasswordLoginResponse.self, from: payloadData)
            let expDate = AppState.parseIsoLenient(r.accessTokenExpiresAt) ?? Date().addingTimeInterval(3600)
            state.completePairing(
                serverURL: url,
                refreshToken: r.refreshToken,
                accessToken: r.accessToken,
                accessTokenExpiresAt: expDate,
                userEmail: r.userEmail,
                userName: r.userName,
            )
            // Close the sheet when SetupView was presented from
            // ProfileSwitcher's "添加另一个账号". No-op at first launch
            // because root-presented views can't dismiss themselves.
            dismiss()
        } catch {
            errorMessage = "网络错误：\(error.localizedDescription)"
        }
    }

    private func loginViaBrowser() async {
        guard let url = await normalizedServerURL() else {
            errorMessage = "服务器地址无效"; return
        }
        isWorking = true; errorMessage = nil
        defer { isWorking = false }
        do {
            let code = try await WebAuthLogin.start(serverURL: url)
            await doClaim(serverURL: url, code: code)
        } catch let e as WebAuthError {
            if case .userCancelled = e { return }  // silent
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pairFromScan(_ raw: String) async {
        guard let payload = PairingService.parseScanned(raw) else {
            errorMessage = "二维码不是来自 ByWave Calendar 的"; return
        }
        guard let url = URL(string: payload.url) else {
            errorMessage = "服务器地址无效"; return
        }
        await doClaim(serverURL: url, code: payload.code)
    }

    private func pairWithCode() async {
        guard let url = await normalizedServerURL() else {
            errorMessage = "服务器地址无效"; return
        }
        await doClaim(serverURL: url, code: manualCode.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func doClaim(serverURL: URL, code: String) async {
        isWorking = true; errorMessage = nil
        defer { isWorking = false }
        do {
            let resp = try await PairingService.claim(
                serverURL: serverURL,
                code: code,
                label: PairingService.suggestedLabel(),
                appVersion: PairingService.appVersion,
            )
            // Lenient parse — server emits Date.toISOString() with
            // fractional seconds which the default ISO8601DateFormatter
            // rejects. See AppState.parseIsoLenient comment for the
            // session-cripping bug that caused.
            let expDate = AppState.parseIsoLenient(resp.accessTokenExpiresAt) ?? Date().addingTimeInterval(3600)
            state.completePairing(
                serverURL: serverURL,
                refreshToken: resp.refreshToken,
                accessToken: resp.accessToken,
                accessTokenExpiresAt: expDate,
                userEmail: resp.userEmail,
                userName: resp.userName,
            )
            // Close when shown as a sheet (ProfileSwitcher "添加账号"); no-op at root.
            dismiss()
        } catch let e as PairingError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - MFA code entry (second step of password login)

/// Identifiable wrapper around (serverURL, mfaToken) so SwiftUI's
/// sheet(item:) binding works. mfaToken is unique per attempt.
struct PendingMfa: Identifiable {
    var id: String { mfaToken }
    let serverURL: URL
    let mfaToken: String
}

/// Compact native sheet that prompts for the 6-digit TOTP code after
/// a successful password verification on an MFA-enabled account.
/// Posts to /api/v1/auth/login-mfa-verify and returns the standard
/// PasswordLoginResponse on success.
struct MfaCodeEntrySheet: View {
    let serverURL: URL
    let mfaToken: String
    let onComplete: (PasswordLoginResponse) -> Void
    let onCancel: () -> Void

    @State private var code: String = ""
    @State private var verifying = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                TextField("6 位验证码或备用码", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .font(.title3.monospacedDigit())
                    .multilineTextAlignment(.center)
            } header: {
                Text("二次验证")
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
            }
        }
        .navigationTitle("输入验证码")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { onCancel() }.disabled(verifying)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: { Task { await verify() } }) {
                    if verifying { ProgressView().controlSize(.small) }
                    else { Text("验证").bold() }
                }
                .disabled(verifying || code.count < 6)
            }
        }
    }

    private func verify() async {
        verifying = true
        errorMessage = nil
        defer { verifying = false }
        do {
            var req = URLRequest(url: serverURL.appendingPathComponent("/api/v1/auth/login-mfa-verify"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(MfaVerifyInput(
                mfaToken: mfaToken,
                code: code.trimmingCharacters(in: .whitespacesAndNewlines),
            ))
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if http.statusCode != 200 {
                let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                let err = body["error"] as? String
                let msg = body["message"] as? String
                if err == "invalid_code" {
                    errorMessage = "验证码错误"
                } else if err == "mfa_token_expired" {
                    errorMessage = msg ?? "验证码会话已过期，请重新登录"
                } else {
                    errorMessage = msg ?? "登录失败 (HTTP \(http.statusCode))"
                }
                return
            }
            let outer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let payload = (outer["data"] as? [String: Any]) ?? outer
            let payloadData = try JSONSerialization.data(withJSONObject: payload)
            let r = try JSONDecoder().decode(PasswordLoginResponse.self, from: payloadData)
            onComplete(r)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
