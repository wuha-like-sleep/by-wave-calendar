// DevicesView.swift
// Signed-in device management. The endpoints under /api/v1/devices
// have existed for a long time — SettingsView's「解绑并退出登录」
// already revokes the current device by scanning this same list —
// but until now iOS had no page that LISTS the devices, so a lost
// phone or a forgotten desktop session could only be revoked from
// the web. This page closes that: every device on the account, the
// current one marked, each revocable after a confirmation.
//
// Revoking the CURRENT device goes through the exact same path as
// the SettingsView revoke button: DELETE the row, then
// state.signOut() — the server has already killed this session's
// refresh token, so staying "signed in" locally would just strand
// the user on a dead session.

import SwiftUI

struct DevicesView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var devices: [DeviceDTO] = []
    @State private var currentDeviceId: String?
    @State private var loading = false
    @State private var revokingId: String?
    @State private var revokeCandidate: DeviceDTO?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                Text("这些设备都登录着你的账号。解绑不认识的设备，它会立即失去访问权限。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section("已登录设备") {
                if loading && devices.isEmpty {
                    HStack { ProgressView().controlSize(.small); Text("加载中…") }
                } else if devices.isEmpty {
                    Text("没有已登录的设备").foregroundStyle(.secondary)
                }
                ForEach(devices) { device in
                    deviceRow(device)
                }
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
            }
        }
        .navigationTitle("我的设备")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .alert(
            revokeCandidateIsCurrent ? "解绑本机？".loc : "解绑这台设备？".loc,
            isPresented: Binding(
                get: { revokeCandidate != nil },
                set: { if !$0 { revokeCandidate = nil } },
            ),
        ) {
            Button("取消", role: .cancel) { revokeCandidate = nil }
            Button("解绑", role: .destructive) {
                if let device = revokeCandidate { Task { await revoke(device) } }
                revokeCandidate = nil
            }
        } message: {
            Text(revokeCandidateIsCurrent
                ? "解绑本机后，APP 会立即退出登录。".loc
                : "解绑后，这台设备将立即失去访问权限。".loc)
        }
    }

    private var revokeCandidateIsCurrent: Bool {
        guard let candidate = revokeCandidate, let current = currentDeviceId else { return false }
        return candidate.id == current
    }

    @ViewBuilder
    private func deviceRow(_ device: DeviceDTO) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: iconName(for: device.kind))
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(device.label.isEmpty ? "未命名设备".loc : device.label)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    if device.id == currentDeviceId {
                        Text("本机")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.15), in: Capsule())
                            .foregroundStyle(Color.accentColor)
                    }
                }
                Text(subtitle(for: device))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(lastSeenText(for: device))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if revokingId == device.id {
                ProgressView().controlSize(.small)
            } else {
                Button(role: .destructive) {
                    revokeCandidate = device
                } label: {
                    Text("解绑").font(.callout)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
    }

    private func iconName(for kind: String) -> String {
        switch kind.lowercased() {
        case "ios", "iphone": return "iphone"
        case "ipad": return "ipad"
        case "android": return "smartphone"
        case "desktop", "macos", "windows", "linux": return "desktopcomputer"
        case "web", "browser": return "globe"
        default: return "iphone"
        }
    }

    private func subtitle(for device: DeviceDTO) -> String {
        var parts = [device.kind]
        if let v = device.appVersion, !v.isEmpty { parts.append("v\(v)") }
        return parts.joined(separator: " · ")
    }

    private func lastSeenText(for device: DeviceDTO) -> String {
        guard let at = device.lastSeenAt else { return "暂无活动记录".loc }
        return "最后活跃：%@".locFormat(at.formatted(date: .abbreviated, time: .shortened))
    }

    // MARK: - Networking

    private func reload() async {
        loading = true
        defer { loading = false }
        let client = APIClient(state: state)
        do {
            devices = try await client.listDevices()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
        // Marking「本机」is best-effort: /devices/me 400s for sessions
        // that aren't device-bound, and the page is still useful
        // without the badge, so a failure here stays silent.
        currentDeviceId = try? await client.currentDevice().id
    }

    private func revoke(_ device: DeviceDTO) async {
        revokingId = device.id
        errorMessage = nil
        defer { revokingId = nil }
        let isCurrent = device.id == currentDeviceId
        do {
            try await APIClient(state: state).revokeDevice(id: device.id)
        } catch let e as APIError {
            errorMessage = e.localizedDescription
            return
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        if isCurrent {
            // Same tail as SettingsView.revokeThisDevice: the server
            // row is gone and this session's refresh token is dead
            // with it — clear the local session and leave Settings.
            state.signOut()
            dismiss()
        } else {
            devices.removeAll { $0.id == device.id }
        }
    }
}
