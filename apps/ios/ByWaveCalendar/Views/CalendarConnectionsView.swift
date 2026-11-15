import SwiftUI

private struct SyncCalendar: Decodable, Identifiable { let id: String; let name: String }
private struct SyncAccount: Decodable { let label: String }
private struct SyncLogin: Decodable { let userCode: String; let verificationUri: String; let expiresAt: Date; let interval: Int }
private struct SyncContent: Decodable { let summary: String; let startsAt: Date; let endsAt: Date; let location: String; let description: String }
private struct SyncItem: Decodable { let content: SyncContent; let revision: String }
private struct SyncConflict: Decodable { let key: String; let left: SyncItem?; let right: SyncItem? }
private struct SyncPair: Decodable, Identifiable { let id: String; let calendarId: String; let remoteId: String; let remoteName: String; let enabled: Bool; let conflicts: [SyncConflict]; let error: String?; let lastSyncedAt: Date? }
private struct CalendarConnection: Decodable {
    let configured: Bool; let account: SyncAccount?; let calendars: [SyncCalendar]; let pairs: [SyncPair]; let login: SyncLogin?
    var remote: [SyncCalendar]?; var remoteError: Bool
}
private struct CalendarCommand: Encodable {
    let action: String
    var id: String? = nil; var calendarId: String? = nil; var remoteId: String? = nil
    var key: String? = nil; var side: String? = nil; var confirm: String? = nil
    var leftRevision: String? = nil; var rightRevision: String? = nil
}
private struct CalendarCommandResult: Decodable { let saved: Bool }

struct CalendarConnectionsView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var data: CalendarConnection?
    @State private var busy = false
    @State private var generation = 0
    @State private var error: String?
    @State private var notice: String?
    @State private var left = ""
    @State private var right = ""
    @State private var pending: CalendarCommand?
    @State private var operation: Task<Void, Never>?

    private func t(_ key: String) -> String { ("calendarSync." + key).loc }
    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    Image(systemName: "calendar.badge.clock").font(.title).foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("ByWave Connect").font(.title3.weight(.semibold))
                        Text(t("title")).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if busy { ProgressView() }
                }.padding(.vertical, 8)
                if let error { Text(error).foregroundStyle(.red).font(.callout) }
                if let notice { Text(notice).foregroundStyle(.tint).font(.callout) }
                Button(t("refresh")) { run { try await load(remote: true) } }.disabled(busy)
            }
            if let data {
                Section {
                    if let account = data.account { Label(account.label, systemImage: "checkmark.circle.fill").foregroundStyle(.tint) }
                    Text(t("outlookIntro")).font(.footnote).foregroundStyle(.secondary)
                    if data.configured {
                        Button(t(data.account == nil ? "connect" : "reconnect")) { command(CalendarCommand(action: "connect")) }.disabled(busy || data.login != nil)
                    } else { Text(t("notConfigured")).font(.callout) }
                    if let login = data.login {
                        Text(t("loginHelp")).font(.callout)
                        Text(login.userCode).font(.title.monospaced().weight(.semibold)).textSelection(.enabled)
                        Button(t("loginOpen")) {
                            guard let url = URL(string: login.verificationUri), url.scheme == "https", url.user == nil,
                                  ["microsoft.com", "www.microsoft.com", "login.microsoftonline.com"].contains(url.host ?? "") else { error = t("error.unavailable"); return }
                            openURL(url)
                        }.disabled(busy)
                        Button(t("finish")) { command(CalendarCommand(action: "finish")) }.disabled(busy)
                        Button(t("cancel"), role: .cancel) { command(CalendarCommand(action: "cancel")) }.disabled(busy)
                        Text(t("expires")).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: { Text("Outlook") }
                if data.account != nil {
                    Section {
                        Text(t("pairHelp")).font(.footnote).foregroundStyle(.secondary)
                        if data.remoteError { Text(t("remoteUnavailable")).foregroundStyle(.orange).font(.callout) }
                        Picker("ByWave", selection: $left) {
                            Text(t("choose")).tag("")
                            ForEach(data.calendars.filter { c in !data.pairs.contains { $0.calendarId == c.id } }) { Text($0.name).tag($0.id) }
                        }
                        Picker("Outlook", selection: $right) {
                            Text(t("choose")).tag("")
                            ForEach((data.remote ?? []).filter { c in !data.pairs.contains { $0.remoteId == c.id } }) { Text($0.name).tag($0.id) }
                        }
                        Button(t("start")) { command(CalendarCommand(action: "pair", calendarId: left, remoteId: right)) }
                            .disabled(left.isEmpty || right.isEmpty || data.remoteError || busy)
                        Button(t("createCalendar")) { command(CalendarCommand(action: "create-calendar")) }.disabled(busy)
                    } header: { Text(t("pairTitle")) }
                    .disabled(busy)
                }
                ForEach(data.pairs) { pair in
                    Section {
                        Text((data.calendars.first { $0.id == pair.calendarId }?.name ?? "ByWave") + " ↔ " + pair.remoteName).font(.headline)
                        if !pair.enabled { Text(t("paused")).foregroundStyle(.secondary) }
                        else if let date = pair.lastSyncedAt { LabeledContent(t("lastSync"), value: date.formatted(date: .abbreviated, time: .shortened)).font(.caption) }
                        else { Text(t("pending")).foregroundStyle(.secondary) }
                        if let code = pair.error { Text(t("error." + (["invalid_grant", "microsoft_reconnect", "calendar_changed_retry"].contains(code) ? code : "unavailable"))).foregroundStyle(.orange).font(.callout) }
                        HStack {
                            Button(t(pair.enabled ? "pause" : "resume")) { command(CalendarCommand(action: pair.enabled ? "pause" : "resume", id: pair.id)) }
                            Spacer()
                            if pair.enabled { Button(t("syncNow")) { command(CalendarCommand(action: "sync", id: pair.id)) } }
                        }.buttonStyle(.borderless).disabled(busy)
                        ForEach(pair.conflicts, id: \.key) { conflict in
                            Text(t("conflictTitle")).font(.headline).foregroundStyle(.orange)
                            conflictSide("ByWave", conflict.left)
                            conflictSide("Outlook", conflict.right)
                            Button(t("keepLeft")) { pending = CalendarCommand(action: "resolve", id: pair.id, key: conflict.key, side: "left", leftRevision: conflict.left?.revision ?? "", rightRevision: conflict.right?.revision ?? "") }.disabled(busy)
                            Button(t("keepRight")) { pending = CalendarCommand(action: "resolve", id: pair.id, key: conflict.key, side: "right", leftRevision: conflict.left?.revision ?? "", rightRevision: conflict.right?.revision ?? "") }.disabled(busy)
                        }
                    }
                }
                Section {
                    DisclosureGroup(t("details")) { Text(t("scope")).font(.footnote).foregroundStyle(.secondary) }
                    if data.account != nil {
                        Button(t("disconnectTitle"), role: .destructive) { pending = CalendarCommand(action: "disconnect", confirm: "disconnect") }.disabled(busy)
                    }
                }
            }
        }
        .navigationTitle(t("title")).navigationBarTitleDisplayMode(.inline)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: data?.account != nil)
        .confirmationDialog(t(pending?.action == "disconnect" ? "disconnectTitle" : "conflictTitle"), isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible) {
            if let pending {
                Button(t(pending.action == "disconnect" ? "disconnect" : (pending.side == "left" ? "keepLeft" : "keepRight")), role: pending.action == "disconnect" ? .destructive : nil) { command(pending); self.pending = nil }
            }
            Button(t("cancel"), role: .cancel) { pending = nil }
        } message: { Text(t(pending?.action == "disconnect" ? "disconnectHelp" : "conflictTitle")) }
        .task(id: state.activeProfileId) {
            busy = true
            do { try await load(remote: true) } catch { show(error) }
            busy = false
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(data?.pairs.isEmpty == false ? 5 : 30)); if !busy && scenePhase == .active { try await load(remote: false) } }
                catch { if Task.isCancelled { break } }
            }
        }
        .onDisappear { operation?.cancel(); operation = nil }
    }
    @ViewBuilder private func conflictSide(_ label: String, _ item: SyncItem?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.tint)
            Text(item?.content.summary ?? t("deleted")).font(.callout.weight(.medium))
            if let content = item?.content {
                Text(content.startsAt.formatted() + " — " + content.endsAt.formatted()).font(.caption).foregroundStyle(.secondary)
                if !content.location.isEmpty { Text(content.location).font(.caption) }
                if !content.description.isEmpty { Text(content.description).font(.caption) }
            }
        }
    }
    @MainActor private func load(remote: Bool) async throws {
        let requestedGeneration = generation
        let id = state.activeProfileId
        var next: CalendarConnection = try await APIClient(state: state).get("/calendar-sync?remote=\(remote ? 1 : 0)")
        guard id == state.activeProfileId, !Task.isCancelled else { throw CancellationError() }
        if !remote && next.account != nil { next.remote = data?.remote; next.remoteError = data?.remoteError ?? false }
        guard requestedGeneration == generation else { return }
        data = next
        if next.pairs.contains(where: { $0.calendarId == left }) || !next.calendars.contains(where: { $0.id == left }) { left = "" }
        if next.pairs.contains(where: { $0.remoteId == right }) || (next.remote != nil && !next.remote!.contains(where: { $0.id == right })) { right = "" }
    }
    @MainActor private func run(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; generation += 1; busy = true; error = nil; notice = nil
        operation = Task { defer { busy = false }; do { try await work() } catch { show(error) } }
    }
    @MainActor private func command(_ command: CalendarCommand) {
        run {
            let _: CalendarCommandResult = try await APIClient(state: state).post("/calendar-sync/action", body: command)
            notice = t(["pair", "sync"].contains(command.action) ? "queued" : "saved")
            try await load(remote: true)
        }
    }
    @MainActor private func show(_ failure: Error) {
        guard !Task.isCancelled, !(failure is CancellationError) else { return }
        if case APIError.server(let status, let body) = failure {
            if status == 404 { error = t("serverUpdate"); return }
            let code = APIError.serverErrorCode(body) ?? "unavailable"
            let translated = t("error." + code)
            error = translated == "calendarSync.error." + code ? t("error.unavailable") : translated
        } else { error = t("error.unavailable") }
    }
}
