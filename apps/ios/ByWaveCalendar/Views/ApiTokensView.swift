// ApiTokensView.swift
// Personal API token management — the native twin of the Web settings
// page (设置 → 设备 → API Token). The endpoints under
// /api/v1/account/api-tokens enforce the same contract server-side:
// creating a token requires a password step-up, a WRITE token on an
// MFA account additionally requires a fresh TOTP code, tokens are
// read-only by default, at most 5 active per user, expiry defaults to
// 365 days (0 = never), rotation keeps the old secret working for
// 7 days, and revocation is immediate.
//
// The full secret comes back exactly once, in the create / rotate
// response. This page shows it once with a copy button and keeps it
// in view state only — it is never written to disk.

import SwiftUI

struct ApiTokensView: View {
    @EnvironmentObject var state: AppState

    @State private var data: ApiTokensResponse?
    @State private var loading = false
    @State private var errorMessage: String?

    /// The one-time secret notice: (label, plain). Memory only.
    @State private var freshSecret: (label: String, plain: String)?
    @State private var copied = false

    @State private var revokeCandidate: ApiTokenDTO?
    @State private var rotateCandidate: ApiTokenDTO?

    // Create form
    @State private var newLabel = ""
    @State private var writeScope = false
    @State private var expiryDays = "365"
    @State private var password = ""
    @State private var mfaCode = ""
    @State private var creating = false
    @State private var createError: String?

    var body: some View {
        Form {
            Section {
                Text("给 n8n、Zapier 或你自己的脚本用。Token 能以你的身份调用接口，要像密码一样保管。")
                    .font(.callout).foregroundStyle(.secondary)
            }

            if let freshSecret {
                Section {
                    Text("新 Token「%@」——现在就复制".locFormat(freshSecret.label))
                        .font(.body.weight(.semibold))
                    Text(freshSecret.plain)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                    Text("完整 Token 只显示这一次，直接填到要用的工具里。")
                        .font(.callout).foregroundStyle(.secondary)
                    HStack {
                        Button {
                            UIPasteboard.general.string = freshSecret.plain
                            copied = true
                        } label: {
                            Text(copied ? "已复制到剪贴板".loc : "复制".loc)
                        }
                        Spacer()
                        Button("完成") {
                            self.freshSecret = nil
                            copied = false
                        }
                    }
                }
            }

            if loading && data == nil {
                Section {
                    HStack { ProgressView().controlSize(.small); Text("正在加载 Token…") }
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                    Button("重试") { Task { await reload() } }
                }
            }

            if let data {
                if !data.apiEnabled {
                    Section {
                        Text("本站还没开启 API，暂时建不了 Token。请找本站运营者开启。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                } else {
                    tokenListSection(data)
                    usageSection(data)
                    createSection(data)
                }
            }
        }
        .navigationTitle("API Token")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .alert(
            "撤销".loc,
            isPresented: Binding(
                get: { revokeCandidate != nil },
                set: { if !$0 { revokeCandidate = nil } },
            ),
        ) {
            Button("取消", role: .cancel) { revokeCandidate = nil }
            Button("撤销", role: .destructive) {
                if let token = revokeCandidate { Task { await revoke(token) } }
                revokeCandidate = nil
            }
        } message: {
            Text("撤销后用这个 Token 的工具立刻失效，之后可以再建新的。")
        }
        .sheet(item: $rotateCandidate) { token in
            RotateTokenSheet(
                token: token,
                passwordSet: data?.passwordSet,
                mfaEnabled: data?.mfaEnabled ?? false,
                onRotated: { label, plain in
                    rotateCandidate = nil
                    freshSecret = (label, plain)
                    copied = false
                    Task { await reload() }
                },
                onCancel: { rotateCandidate = nil },
            )
            .environmentObject(state)
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private func tokenListSection(_ data: ApiTokensResponse) -> some View {
        Section("API Token") {
            if data.tokens.isEmpty {
                Text("还没有 API Token。").foregroundStyle(.secondary)
            }
            ForEach(data.tokens) { token in
                tokenRow(token)
            }
        }
    }

    @ViewBuilder
    private func tokenRow(_ token: ApiTokenDTO) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(token.label)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(token.scope == "write" ? "读写".loc : "只读".loc)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        (token.scope == "write" ? Color.red : Color.accentColor).opacity(0.15),
                        in: Capsule(),
                    )
                    .foregroundStyle(token.scope == "write" ? Color.red : Color.accentColor)
                if token.expired {
                    Text("已过期")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.red.opacity(0.15), in: Capsule())
                        .foregroundStyle(Color.red)
                }
                if token.inGrace {
                    Text("宽限中")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.15), in: Capsule())
                        .foregroundStyle(Color.accentColor)
                }
            }
            Text(token.prefix + "…")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Text(metaText(for: token))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(expiryText(for: token))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                if !token.expired && !token.inGrace {
                    Button {
                        rotateCandidate = token
                    } label: {
                        Text("轮换").font(.callout)
                    }
                    .buttonStyle(.borderless)
                }
                Button(role: .destructive) {
                    revokeCandidate = token
                } label: {
                    Text("撤销").font(.callout)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
    }

    private func metaText(for token: ApiTokenDTO) -> String {
        var parts: [String] = []
        parts.append("创建于 %@".locFormat(token.createdAt.formatted(date: .abbreviated, time: .shortened)))
        if let last = token.lastUsedAt {
            var used = "最近使用 %@".locFormat(last.formatted(date: .abbreviated, time: .shortened))
            if let ip = token.lastUsedIp, !ip.isEmpty { used += " · \(ip)" }
            parts.append(used)
        } else {
            parts.append("从未使用".loc)
        }
        parts.append("累计调用 %lld 次".locFormat(token.useCount))
        return parts.joined(separator: " · ")
    }

    private func expiryText(for token: ApiTokenDTO) -> String {
        if token.inGrace, let until = token.expiresAt {
            return "旧密钥将于 %@ 失效".locFormat(until.formatted(date: .abbreviated, time: .shortened))
        }
        if let until = token.expiresAt {
            return "%@ 到期".locFormat(until.formatted(date: .abbreviated, time: .shortened))
        }
        return "不过期".loc
    }

    /// The 30-day usage view from the same GET response the Web page
    /// uses: a total line, a simple per-day bar strip, per-token counts.
    @ViewBuilder
    private func usageSection(_ data: ApiTokensResponse) -> some View {
        Section("近 30 天用量") {
            if data.usage.total == 0 {
                Text("近 30 天还没有调用记录。")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                Text("近 30 天调用 %lld 次".locFormat(data.usage.total))
                    .font(.callout).foregroundStyle(.secondary)
                let maxCount = data.usage.perDay.map(\.count).max() ?? 0
                HStack(alignment: .bottom, spacing: 2) {
                    ForEach(data.usage.perDay, id: \.day) { day in
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(day.count > 0 ? Color.accentColor : Color.secondary.opacity(0.25))
                            .frame(height: barHeight(count: day.count, max: maxCount))
                    }
                }
                .frame(height: 44, alignment: .bottom)
                ForEach(data.usage.perToken.filter { $0.count > 0 }, id: \.tokenId) { row in
                    HStack {
                        Text(row.label).font(.callout).lineLimit(1)
                        Spacer()
                        Text("累计调用 %lld 次".locFormat(row.count))
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func barHeight(count: Int, max: Int) -> CGFloat {
        guard max > 0 else { return 1 }
        if count == 0 { return 1 }
        return max(3, 44 * CGFloat(count) / CGFloat(max))
    }

    @ViewBuilder
    private func createSection(_ data: ApiTokensResponse) -> some View {
        if data.passwordSet == false && !data.mfaEnabled {
            Section {
                Text("这个账号没有自己的密码、也没开 MFA，没法在这里建 Token。请找本站运营者帮你签发。")
                    .font(.callout).foregroundStyle(.secondary)
            }
        } else if data.limitReached {
            Section {
                Text("你已经有 %lld 个未撤销的 Token，先撤销一个再建新的。".locFormat(data.limit))
                    .font(.callout).foregroundStyle(.secondary)
            }
        } else {
            Section("创建 Token") {
                TextField("备注（比如 n8n 同步）", text: $newLabel)
                Picker("权限", selection: $writeScope) {
                    Text("只读").tag(false)
                    Text("读写").tag(true)
                }
                .pickerStyle(.segmented)
                if writeScope {
                    Text("读写 Token 能以你的身份新建、修改和删除日程。工具确实需要写入时再选它。")
                        .font(.callout).foregroundStyle(.secondary)
                }
                HStack {
                    Text("有效天数（0 = 不过期）")
                    Spacer()
                    TextField("365", text: $expiryDays)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 80)
                }
                Text("默认 365 天，需要更久可以改大；填 0 表示不过期。")
                    .font(.callout).foregroundStyle(.secondary)
                if data.passwordSet != false {
                    SecureField("当前密码", text: $password)
                }
                if data.mfaEnabled {
                    TextField("MFA 验证码", text: $mfaCode)
                        .keyboardType(.numberPad)
                }
                Text("建 Token 前要再验一次身份，免得借来的登录会话偷偷签发。")
                    .font(.callout).foregroundStyle(.secondary)
                if let createError {
                    Text(createError).foregroundStyle(.red).font(.callout)
                }
                Button {
                    Task { await create(data) }
                } label: {
                    HStack {
                        if creating { ProgressView().controlSize(.small) }
                        Text("创建 Token")
                    }
                }
                .disabled(!createReady(data))
            }
        }
    }

    /// Local gating mirrors the server's step-up rules so a blank
    /// required field doesn't cost a round-trip; the server stays the
    /// authority and its verdicts surface via createError.
    private func createReady(_ data: ApiTokensResponse) -> Bool {
        if creating { return false }
        if newLabel.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        guard let days = Int(expiryDays), (0...3650).contains(days) else { return false }
        switch data.passwordSet {
        case .some(true):
            if password.isEmpty { return false }
            if writeScope && data.mfaEnabled && mfaCode.isEmpty { return false }
            return true
        case .some(false):
            return !mfaCode.isEmpty
        default:
            return !password.isEmpty || !mfaCode.isEmpty
        }
    }

    // MARK: - Networking

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            data = try await APIClient(state: state).listApiTokens()
            errorMessage = nil
        } catch {
            errorMessage = tokenErrorText(error, fallback: "Token 加载失败。".loc)
        }
    }

    private func create(_ data: ApiTokensResponse) async {
        creating = true
        createError = nil
        defer { creating = false }
        let input = CreateApiTokenInput(
            label: newLabel.trimmingCharacters(in: .whitespaces),
            scope: writeScope ? "write" : "read",
            expiresInDays: Int(expiryDays) ?? 365,
            currentPassword: password.isEmpty ? nil : password,
            mfaCode: mfaCode.trimmingCharacters(in: .whitespaces).isEmpty
                ? nil : mfaCode.trimmingCharacters(in: .whitespaces),
        )
        do {
            let created = try await APIClient(state: state).createApiToken(input)
            freshSecret = (created.token.label, created.plain)
            copied = false
            newLabel = ""
            password = ""
            mfaCode = ""
            await reload()
        } catch {
            createError = tokenErrorText(error, fallback: "Token 创建失败。".loc, limit: data.limit)
        }
    }

    private func revoke(_ token: ApiTokenDTO) async {
        do {
            try await APIClient(state: state).revokeApiToken(id: token.id)
            await reload()
        } catch {
            errorMessage = tokenErrorText(error, fallback: "Token 撤销失败。".loc)
        }
    }
}

/// Rotate step-up sheet: same confirmation rules as create, evaluated
/// server-side against the token's own scope (a write token on an MFA
/// account needs password + TOTP). On success the parent page shows
/// the new secret once; the old secret keeps working for 7 days.
private struct RotateTokenSheet: View {
    @EnvironmentObject var state: AppState

    let token: ApiTokenDTO
    let passwordSet: Bool?
    let mfaEnabled: Bool
    let onRotated: (String, String) -> Void
    let onCancel: () -> Void

    @State private var password = ""
    @State private var mfaCode = ""
    @State private var working = false
    @State private var errorMessage: String?

    private var stepUpReady: Bool {
        switch passwordSet {
        case .some(true):
            if password.isEmpty { return false }
            if token.scope == "write" && mfaEnabled && mfaCode.isEmpty { return false }
            return true
        case .some(false):
            return !mfaCode.isEmpty
        default:
            return !password.isEmpty || !mfaCode.isEmpty
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("为这个 Token 生成新的密钥。旧密钥在 7 天内仍可使用，你可以从容地把工具切换过去，不会中断。")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Section {
                    if passwordSet != false {
                        SecureField("当前密码", text: $password)
                    }
                    if mfaEnabled {
                        TextField("MFA 验证码", text: $mfaCode)
                            .keyboardType(.numberPad)
                    }
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red).font(.callout)
                    }
                }
            }
            .navigationTitle(token.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { onCancel() }
                        .disabled(working)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await rotate() }
                    } label: {
                        HStack {
                            if working { ProgressView().controlSize(.small) }
                            Text("轮换")
                        }
                    }
                    .disabled(working || !stepUpReady)
                }
            }
        }
    }

    private func rotate() async {
        working = true
        errorMessage = nil
        defer { working = false }
        let input = ApiTokenStepUpInput(
            currentPassword: password.isEmpty ? nil : password,
            mfaCode: mfaCode.trimmingCharacters(in: .whitespaces).isEmpty
                ? nil : mfaCode.trimmingCharacters(in: .whitespaces),
        )
        do {
            let rotated = try await APIClient(state: state).rotateApiToken(id: token.id, input)
            onRotated(rotated.token.label, rotated.plain)
        } catch {
            errorMessage = tokenErrorText(error, fallback: "这个 Token 无法轮换。".loc)
        }
    }
}

/// Localized copy for the token-endpoint failures the user can act on.
/// The API client surfaces the server's machine code (see
/// APIError.serverErrorCode); codes map to the same strings the Web
/// page shows, anything else falls back to the error's own description.
private func tokenErrorText(_ error: Error, fallback: String, limit: Int = 5) -> String {
    if let e = error as? APIError, case .server(_, let body) = e {
        switch APIError.serverErrorCode(body) {
        case "step_up_failed":
            return "密码或验证码没对上，Token 没有创建。".loc
        case "limit_reached":
            return "你已经有 %lld 个未撤销的 Token，先撤销一个再建新的。".locFormat(limit)
        case "api_disabled":
            return "本站还没开启 API，暂时建不了 Token。请找本站运营者开启。".loc
        case "step_up_unavailable":
            return "这个账号没有自己的密码、也没开 MFA，没法在这里建 Token。请找本站运营者帮你签发。".loc
        case "rotate_expired":
            return "这个 Token 已经过期了，请直接新建一个。".loc
        case "not_found", "rotate_failed":
            return "这个 Token 无法轮换。".loc
        default:
            break
        }
    }
    if let e = error as? APIError { return e.localizedDescription }
    return fallback
}
