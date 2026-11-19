// CalendarSharingView.swift
// Per-calendar sharing management, reached from EditCalendarView —
// the same spot the web calendar page and the desktop/Android
// calendar editors keep it:
//
//   ShareLinksView       — public subscribe links (share-tokens).
//                          Anyone holding a link can subscribe to
//                          this calendar read-only, so creating one
//                          is a deliberate act and revoking asks
//                          first. The URL comes from the server
//                          (it owns PUBLIC_BASE_URL); we only ever
//                          display / copy / share it.
//   SubscriptionsView    — outbound ICS subscriptions feeding this
//                          calendar. Creating one triggers a first
//                          fetch server-side; that fetch failing
//                          does NOT un-save the subscription, and
//                          the UI says so instead of crying failure.

import SwiftUI

// MARK: - 分享链接

struct ShareLinksView: View {
    let calendar: CalendarMeta
    @EnvironmentObject var state: AppState

    @State private var tokens: [ShareTokenDTO] = []
    @State private var loading = false
    @State private var creating = false
    @State private var newLabel: String = ""
    @State private var revokeCandidate: ShareTokenDTO?
    @State private var copiedToken: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                Text("任何拿到链接的人都能订阅这个日历（只读）。不要把链接发到公开场合。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section("新建分享链接") {
                TextField("链接名称（可选）", text: $newLabel)
                Button(action: { Task { await create() } }) {
                    if creating {
                        HStack { ProgressView().controlSize(.small); Text("处理中…") }
                    } else {
                        Text("新建链接").bold()
                    }
                }
                .disabled(creating)
            }
            Section("已有链接") {
                if loading && tokens.isEmpty {
                    HStack { ProgressView().controlSize(.small); Text("加载中…") }
                } else if tokens.isEmpty {
                    Text("还没有分享链接").foregroundStyle(.secondary)
                }
                ForEach(tokens) { tok in
                    tokenRow(tok)
                }
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
            }
        }
        .navigationTitle("分享链接")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .alert("撤销这个分享链接？", isPresented: Binding(
            get: { revokeCandidate != nil },
            set: { if !$0 { revokeCandidate = nil } },
        )) {
            Button("取消", role: .cancel) { revokeCandidate = nil }
            Button("撤销", role: .destructive) {
                if let tok = revokeCandidate { Task { await revoke(tok) } }
                revokeCandidate = nil
            }
        } message: {
            Text("撤销后，用这个链接订阅的人将无法再获取更新。")
        }
    }

    @ViewBuilder
    private func tokenRow(_ tok: ShareTokenDTO) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(tok.label?.isEmpty == false ? tok.label! : "未命名链接".loc)
                    .font(.body.weight(.medium))
                Spacer()
                Text(tok.createdAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(tok.url)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .textSelection(.enabled)
            HStack(spacing: 16) {
                Button {
                    UIPasteboard.general.string = tok.url
                    copiedToken = tok.token
                } label: {
                    Label(copiedToken == tok.token ? "已复制".loc : "复制".loc, systemImage: "doc.on.doc")
                        .font(.callout)
                }
                .buttonStyle(.borderless)
                ShareLink(item: tok.url) {
                    Label("分享", systemImage: "square.and.arrow.up")
                        .font(.callout)
                }
                Spacer()
                Button(role: .destructive) {
                    revokeCandidate = tok
                } label: {
                    Text("撤销").font(.callout)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            tokens = try await APIClient(state: state).listShareTokens(calendarId: calendar.id)
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func create() async {
        creating = true
        errorMessage = nil
        defer { creating = false }
        do {
            let label = newLabel.trimmingCharacters(in: .whitespaces)
            let created = try await APIClient(state: state)
                .createShareToken(calendarId: calendar.id, label: label.isEmpty ? nil : label)
            newLabel = ""
            tokens.insert(created, at: 0)
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func revoke(_ tok: ShareTokenDTO) async {
        errorMessage = nil
        do {
            try await APIClient(state: state).revokeShareToken(calendarId: calendar.id, token: tok.token)
            tokens.removeAll { $0.token == tok.token }
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 日历订阅

struct SubscriptionsView: View {
    let calendar: CalendarMeta
    @EnvironmentObject var state: AppState

    @State private var subscriptions: [CalendarSubscriptionDTO] = []
    @State private var loading = false
    @State private var adding = false
    @State private var newURL: String = ""
    @State private var newLabel: String = ""
    @State private var refreshingId: String?
    @State private var deleteCandidate: CalendarSubscriptionDTO?
    /// Outcome of the last add / refresh, shown inline (NOT an error
    /// alert): a subscription whose first fetch failed is saved and
    /// will retry on its own schedule — that is news, not failure.
    @State private var notice: String?
    @State private var noticeIsError = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                Text("订阅一个外部日历地址（.ics），它的事件会自动同步进这个日历。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section("添加订阅") {
                TextField("订阅地址（https://… .ics）", text: $newURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                TextField("订阅名称（可选）", text: $newLabel)
                Button(action: { Task { await add() } }) {
                    if adding {
                        HStack { ProgressView().controlSize(.small); Text("处理中…") }
                    } else {
                        Text("添加订阅").bold()
                    }
                }
                .disabled(adding || newURL.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let notice {
                Section {
                    Text(notice)
                        .font(.callout)
                        .foregroundStyle(noticeIsError ? .orange : .green)
                }
            }
            Section("已有订阅") {
                if loading && subscriptions.isEmpty {
                    HStack { ProgressView().controlSize(.small); Text("加载中…") }
                } else if subscriptions.isEmpty {
                    Text("还没有订阅").foregroundStyle(.secondary)
                }
                ForEach(subscriptions) { sub in
                    subscriptionRow(sub)
                }
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
            }
        }
        .navigationTitle("日历订阅")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .alert("删除这个订阅？", isPresented: Binding(
            get: { deleteCandidate != nil },
            set: { if !$0 { deleteCandidate = nil } },
        )) {
            Button("取消", role: .cancel) { deleteCandidate = nil }
            Button("删除", role: .destructive) {
                if let sub = deleteCandidate { Task { await delete(sub) } }
                deleteCandidate = nil
            }
        } message: {
            Text("订阅会停止同步；已经同步进来的事件不会被删除。")
        }
    }

    @ViewBuilder
    private func subscriptionRow(_ sub: CalendarSubscriptionDTO) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(sub.label?.isEmpty == false ? sub.label! : sub.url)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Spacer()
                if refreshingId == sub.id {
                    ProgressView().controlSize(.small)
                } else {
                    Button {
                        Task { await refresh(sub) }
                    } label: {
                        Label("刷新", systemImage: "arrow.clockwise")
                            .font(.callout)
                    }
                    .buttonStyle(.borderless)
                }
                Button(role: .destructive) {
                    deleteCandidate = sub
                } label: {
                    Text("删除").font(.callout)
                }
                .buttonStyle(.borderless)
            }
            if sub.label?.isEmpty == false {
                Text(sub.url)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Text(statusText(for: sub))
                .font(.caption)
                .foregroundStyle(sub.lastStatus == "error" ? .orange : .secondary)
            if sub.lastStatus == "error", let err = sub.lastError, !err.isEmpty {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 2)
    }

    private func statusText(for sub: CalendarSubscriptionDTO) -> String {
        switch sub.lastStatus {
        case "ok":
            var s = "同步正常".loc
            if let n = sub.lastEventCount {
                s += " · " + "%lld 个事件".locFormat(n)
            }
            if let at = sub.lastFetchedAt {
                s += " · " + at.formatted(date: .abbreviated, time: .shortened)
            }
            return s
        case "error":
            if let at = sub.lastFetchedAt {
                return "上次同步失败".loc + " · " + at.formatted(date: .abbreviated, time: .shortened)
            }
            return "上次同步失败".loc
        default:
            return "尚未同步".loc
        }
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            subscriptions = try await APIClient(state: state).listSubscriptions(calendarId: calendar.id)
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func add() async {
        adding = true
        errorMessage = nil
        notice = nil
        defer { adding = false }
        do {
            let url = newURL.trimmingCharacters(in: .whitespaces)
            let label = newLabel.trimmingCharacters(in: .whitespaces)
            let resp = try await APIClient(state: state)
                .createSubscription(calendarId: calendar.id, url: url, label: label.isEmpty ? nil : label)
            newURL = ""
            newLabel = ""
            if resp.refresh.ok {
                notice = "订阅已添加，首次同步完成".loc
                noticeIsError = false
            } else {
                // Saved but the first fetch failed — the server keeps
                // retrying on schedule, so this is a warning, and the
                // row below (after reload) shows the same state.
                notice = "已保存、首次同步失败：%@".locFormat(resp.refresh.error ?? "")
                noticeIsError = true
            }
            await reload()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func refresh(_ sub: CalendarSubscriptionDTO) async {
        refreshingId = sub.id
        errorMessage = nil
        notice = nil
        defer { refreshingId = nil }
        do {
            let resp = try await APIClient(state: state)
                .refreshSubscription(calendarId: calendar.id, subscriptionId: sub.id)
            if let idx = subscriptions.firstIndex(where: { $0.id == sub.id }) {
                subscriptions[idx] = resp.subscription
            }
            notice = "同步完成：新增 %lld · 更新 %lld · 跳过 %lld".locFormat(resp.inserted, resp.updated, resp.skipped)
            noticeIsError = false
        } catch let e as APIError {
            // 502 = the fetch itself failed; the row's lastError now
            // holds the reason, so reload to surface it inline.
            errorMessage = e.localizedDescription
            await reload()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ sub: CalendarSubscriptionDTO) async {
        errorMessage = nil
        do {
            try await APIClient(state: state).deleteSubscription(calendarId: calendar.id, subscriptionId: sub.id)
            subscriptions.removeAll { $0.id == sub.id }
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
