// MfaSettingsPage.swift
// Native MFA setup / disable. Server endpoints under
// /api/v1/account/mfa/{setup,verify,disable}.
//
// Setup flow:
//   1. View calls /setup → gets back an otpauthUri ("otpauth://totp/...")
//   2. We render it as a QR (CoreImage CIFilter "CIQRCodeGenerator")
//      AND show the raw URL underneath so the user can paste it into
//      a desktop authenticator
//   3. User enters the 6-digit code → /verify → gets 10 backup codes
//   4. Backup codes shown ONCE on screen; user must save them before
//      tapping "完成"

import SwiftUI
import CoreImage.CIFilterBuiltins

struct MfaSettingsPage: View {
    let onDone: () -> Void
    @EnvironmentObject var state: AppState

    @State private var phase: Phase = .loading
    @State private var otpauthUri: String?
    @State private var verificationCode: String = ""
    @State private var backupCodes: [String] = []
    @State private var disablePassword: String = ""
    @State private var disableCode: String = ""
    @State private var working = false
    @State private var errorMessage: String?

    /// Three big phases driven by user's current MFA state.
    enum Phase {
        case loading           // figuring out if MFA already on
        case setupShowingQR    // QR + code-entry field
        case showingBackupCodes
        case alreadyEnabled    // user can disable
    }

    var body: some View {
        Group {
            switch phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .setupShowingQR:
                setupForm
            case .showingBackupCodes:
                backupCodesForm
            case .alreadyEnabled:
                disableForm
            }
        }
        .navigationTitle("二次验证 (MFA)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("完成") { onDone() }.disabled(working)
            }
        }
        .task {
            // First-launch: detect existing MFA state. Server's
            // /api/v1/users/me isn't exposed yet, so we infer from
            // the in-AppState user — but currentUserEmail being set
            // doesn't tell us about MFA. Safest: call /mfa/setup
            // optimistically. If it returns 409 "already_enabled",
            // we switch to the disable form. Otherwise we have a
            // pending secret + QR to show.
            await startSetup()
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

    // MARK: - Setup phase

    private var setupForm: some View {
        Form {
            if let uri = otpauthUri, let qr = qrImage(from: uri) {
                Section {
                    qr.resizable()
                        .interpolation(.none)
                        .scaledToFit()
                        .frame(maxWidth: 240)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 8)
                } header: {
                    Text("二维码")
                }
                Section {
                    Text(uri)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                TextField("6 位验证码", text: $verificationCode)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .font(.title3.monospacedDigit())
                Button(action: { Task { await verify() } }) {
                    if working {
                        HStack { ProgressView().controlSize(.small); Text("验证中…") }
                    } else {
                        Text("启用二次验证").bold().frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(working || verificationCode.count < 6)
            }
        }
    }

    // MARK: - Backup codes phase

    private var backupCodesForm: some View {
        Form {
            Section {
                Label {
                    Text("二次验证已启用 ✓").font(.body.weight(.semibold))
                } icon: {
                    Image(systemName: "checkmark.shield.fill").foregroundStyle(.green)
                }
                Text("保存这些备用码 — 认证器失效时每个码可用一次。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section("备用码（仅此一次显示）") {
                ForEach(backupCodes, id: \.self) { code in
                    Text(code)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                }
            }
            Section {
                Button {
                    UIPasteboard.general.string = backupCodes.joined(separator: "\n")
                } label: {
                    Label("复制全部到剪贴板", systemImage: "doc.on.doc")
                }
                Button {
                    onDone()
                } label: {
                    Text("我已保存，完成").bold().frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: - Disable phase

    private var disableForm: some View {
        Form {
            Section {
                Label {
                    Text("二次验证当前已启用").font(.body.weight(.semibold))
                } icon: {
                    Image(systemName: "lock.shield.fill").foregroundStyle(.green)
                }
            }
            Section("关闭二次验证") {
                SecureField("当前密码", text: $disablePassword)
                    .textContentType(.password)
                TextField("认证器 6 位验证码", text: $disableCode)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .font(.body.monospacedDigit())
                Button(role: .destructive, action: { Task { await disable() } }) {
                    if working {
                        HStack { ProgressView().controlSize(.small); Text("处理中…") }
                    } else {
                        Text("关闭二次验证").bold().frame(maxWidth: .infinity)
                    }
                }
                .disabled(working || disablePassword.isEmpty || disableCode.count < 6)
            }
        }
    }

    // MARK: - Networking

    private func startSetup() async {
        working = true
        defer { working = false }
        do {
            struct Resp: Decodable { let otpauthUri: String; let secret: String }
            let resp: Resp = try await APIClient(state: state).post("/account/mfa/setup", body: EmptyBody())
            otpauthUri = resp.otpauthUri
            phase = .setupShowingQR
        } catch let e as APIError {
            if case .server(let status, let body) = e, status == 409 {
                // "already_enabled" — show disable form instead.
                phase = .alreadyEnabled
                return
            }
            errorMessage = e.localizedDescription
            phase = .alreadyEnabled  // safer fallback than stuck-on-loading
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func verify() async {
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            struct Body: Encodable { let code: String }
            struct Resp: Decodable { let ok: Bool; let backupCodes: [String] }
            let resp: Resp = try await APIClient(state: state).post(
                "/account/mfa/verify",
                body: Body(code: verificationCode.trimmingCharacters(in: .whitespaces)),
            )
            backupCodes = resp.backupCodes
            phase = .showingBackupCodes
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func disable() async {
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            struct Body: Encodable { let password: String; let code: String }
            struct Resp: Decodable { let ok: Bool }
            let _: Resp = try await APIClient(state: state).post(
                "/account/mfa/disable",
                body: Body(password: disablePassword, code: disableCode.trimmingCharacters(in: .whitespaces)),
            )
            onDone()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - QR generation

    /// Renders the otpauth URI as a black-on-white QR via CoreImage.
    /// 240pt target — bigger than necessary so it stays scannable when
    /// Form scales it down on small phones.
    private func qrImage(from string: String) -> Image? {
        guard let data = string.data(using: .utf8) else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = data
        filter.correctionLevel = "M"
        guard let outputImage = filter.outputImage else { return nil }
        let scaled = outputImage.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return Image(uiImage: UIImage(cgImage: cg))
    }
}

private struct EmptyBody: Encodable {}
