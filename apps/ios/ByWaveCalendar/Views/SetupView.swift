// SetupView.swift
// First-launch / signed-out screen. User enters server URL (or scans a QR
// from the web's /app/settings#devices page) and we trigger pair-claim.

import SwiftUI

struct SetupView: View {
    @EnvironmentObject var state: AppState
    @State private var serverURLInput: String = ""
    @State private var manualCode: String = ""
    @State private var showingScanner = false
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Hero
                    VStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 18)
                            .fill(LinearGradient(colors: [
                                Color(red: 0.31, green: 0.27, blue: 0.9),
                                Color(red: 0.49, green: 0.23, blue: 0.93),
                            ], startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 76, height: 76)
                            .overlay {
                                Image(systemName: "calendar")
                                    .font(.system(size: 34, weight: .semibold))
                                    .foregroundStyle(.white)
                            }
                            .shadow(color: Color(red: 0.31, green: 0.27, blue: 0.9).opacity(0.25), radius: 12, y: 6)
                        Text("ByWave Calendar")
                            .font(.title2.bold())
                        Text("登录你的服务器，开始同步")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 32)

                    // Primary CTA: scan QR
                    Button {
                        showingScanner = true
                    } label: {
                        HStack {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.system(size: 18, weight: .semibold))
                            Text("扫码登录").font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(LinearGradient(colors: [
                            Color(red: 0.31, green: 0.27, blue: 0.9),
                            Color(red: 0.49, green: 0.23, blue: 0.93),
                        ], startPoint: .leading, endPoint: .trailing))
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .disabled(isWorking)

                    Text("在网页 /app/settings#devices 里点「绑定新设备」拿到二维码")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    Divider().padding(.vertical, 4)

                    // Manual entry (fallback if camera is unavailable)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("没法扫码？手动输入：")
                            .font(.subheadline.weight(.medium))
                        TextField("https://your-server.com", text: $serverURLInput)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .background(Color.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                        TextField("6 位配对码（例如 ABC123）", text: $manualCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .background(Color.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                        Button {
                            Task { await pairManually() }
                        } label: {
                            HStack {
                                if isWorking { ProgressView().controlSize(.small) }
                                Text(isWorking ? "登录中…" : "登录").font(.body.weight(.medium))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.gray.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .disabled(isWorking || serverURLInput.isEmpty || manualCode.isEmpty)
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                            .padding(.top, 8)
                    }

                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 24)
            }
            .background(LinearGradient(colors: [
                Color(red: 0.98, green: 0.99, blue: 1.0),
                Color(red: 0.96, green: 0.97, blue: 1.0),
            ], startPoint: .top, endPoint: .bottom))
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

    private func pairFromScan(_ raw: String) async {
        guard let payload = PairingService.parseScanned(raw) else {
            errorMessage = "二维码不是来自 ByWave Calendar 的"
            return
        }
        guard let url = URL(string: payload.url) else {
            errorMessage = "服务器地址无效"
            return
        }
        await doClaim(serverURL: url, code: payload.code)
    }

    private func pairManually() async {
        var s = serverURLInput.trimmingCharacters(in: .whitespacesAndNewlines)
        // Tolerate user pasting "rl.lz-ss.com" — add https:// when missing.
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") {
            s = "https://" + s
        }
        guard let url = URL(string: s) else {
            errorMessage = "服务器地址无效"
            return
        }
        await doClaim(serverURL: url, code: manualCode.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func doClaim(serverURL: URL, code: String) async {
        isWorking = true
        errorMessage = nil
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
                userEmail: nil,  // server doesn't return email here; we'll pull /me later
                userName: nil,
            )
        } catch let e as PairingError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
