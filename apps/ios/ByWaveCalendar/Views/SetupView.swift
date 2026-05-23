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
    case password = "密码"
    case scan = "扫码"
    case code = "配对码"
    var id: String { rawValue }
}

struct SetupView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.colorScheme) private var colorScheme
    @State private var serverURLInput: String = ""
    @State private var method: LoginMethod = .password

    // Password method
    @State private var email: String = ""
    @State private var password: String = ""

    // Code method
    @State private var manualCode: String = ""

    @State private var showingScanner = false
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    hero
                    serverURLField
                    methodPicker
                    // Body per method
                    Group {
                        switch method {
                        case .password: passwordForm
                        case .scan:     scanForm
                        case .code:     codeForm
                        }
                    }
                    // Browser-based login. Covers Passkey + MFA + SSO
                    // without needing native equivalents — we just hand
                    // off to the server's web login flow via
                    // ASWebAuthenticationSession.
                    browserLoginButton
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote).foregroundStyle(.red)
                            .multilineTextAlignment(.center)
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
        }
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
            TextField("https://your-server.com", text: $serverURLInput)
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
        VStack(spacing: 10) {
            Text("在浏览器登录后，进入设置 → 我的设备 → 「绑定新设备」，对准二维码")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                showingScanner = true
            } label: {
                HStack {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 18, weight: .semibold))
                    Text("打开相机扫码").font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(brandGradient)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(isWorking)
        }
    }

    // MARK: - Manual code
    private var codeForm: some View {
        VStack(spacing: 12) {
            Text("没法扫码？输入 6 位配对码（从网页的「绑定新设备」对话框里复制）")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
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
            Text("Passkey / 二次验证 / 第三方 SSO 都在浏览器登录里")
                .font(.caption2).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
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

    private func normalizedServerURL() -> URL? {
        var s = serverURLInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        // Tolerate user pasting "rl.lz-ss.com" — add https:// when missing.
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") {
            s = "https://" + s
        }
        // Strip trailing slash so /api/v1 paths assemble cleanly.
        if s.hasSuffix("/") { s.removeLast() }
        return URL(string: s)
    }

    private func loginWithPassword() async {
        guard let url = normalizedServerURL() else {
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
            ))
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if http.statusCode != 200 {
                let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                let err = body["error"] as? String
                let msg = body["message"] as? String
                if err == "mfa_required" {
                    errorMessage = msg ?? "账号开启了 MFA，请改用扫码登录"
                } else if err == "invalid_credentials" {
                    errorMessage = "邮箱或密码错误"
                } else if err == "account_disabled" {
                    errorMessage = "账号已停用，请联系管理员"
                } else if err == "account_locked" {
                    errorMessage = msg ?? "登录失败次数过多，稍后再试"
                } else if err == "apps_disabled" {
                    errorMessage = "管理员已停用 APP 同步功能"
                } else {
                    errorMessage = "登录失败 (HTTP \(http.statusCode))"
                }
                return
            }
            // Server returns the same envelope shape as pair-claim.
            let outer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let payload = (outer["data"] as? [String: Any]) ?? outer
            let payloadData = try JSONSerialization.data(withJSONObject: payload)
            let r = try JSONDecoder().decode(PasswordLoginResponse.self, from: payloadData)
            let expDate = ISO8601DateFormatter().date(from: r.accessTokenExpiresAt) ?? Date().addingTimeInterval(3600)
            state.completePairing(
                serverURL: url,
                refreshToken: r.refreshToken,
                accessToken: r.accessToken,
                accessTokenExpiresAt: expDate,
                userEmail: r.userEmail,
                userName: r.userName,
            )
        } catch {
            errorMessage = "网络错误：\(error.localizedDescription)"
        }
    }

    private func loginViaBrowser() async {
        guard let url = normalizedServerURL() else {
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
        guard let url = normalizedServerURL() else {
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
            let expDate = ISO8601DateFormatter().date(from: resp.accessTokenExpiresAt) ?? Date().addingTimeInterval(3600)
            state.completePairing(
                serverURL: serverURL,
                refreshToken: resp.refreshToken,
                accessToken: resp.accessToken,
                accessTokenExpiresAt: expDate,
                userEmail: nil,
                userName: nil,
            )
        } catch let e as PairingError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
