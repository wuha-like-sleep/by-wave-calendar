// InvitationsView.swift
// Invitee side of event invitations — the invitations addressed to ME.
// Mirrors the web /event-invite/:token page: event summary in the
// event's own timezone, organizer + full invitee list with per-person
// status, Accept / Maybe / Decline, and propose-a-new-time with my
// proposal history.
//
// Data: GET /api/v1/invitations carries list + detail in one payload.
// Respond / propose POST through the invite token (the token is the
// credential, same as the web page); after every mutation the view
// re-fetches from the server — nothing is updated optimistically, so a
// failed call can never look successful.

import SwiftUI

struct InvitationsView: View {
    /// Deep-link token (bywave://invitations/<token> or a push payload):
    /// once the list lands, push straight to that invitation's detail.
    let openToken: String?
    /// 以 sheet 形式出现时右上角有「完成」；作为标签页根时没有
    /// 可关闭的对象，隐藏它（标签页里点一个点了没反应的按钮
    /// 比没有按钮更糟）。
    var showsDoneButton: Bool = true

    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var invitations: [Invitation] = []
    @State private var path: [Invitation] = []
    @State private var loading = true
    @State private var errorMessage: String?

    // MARK: - Models (mirror GET /api/v1/invitations)

    struct Organizer: Decodable, Hashable {
        let email: String
        let name: String
    }

    struct InvEvent: Decodable, Hashable {
        let id: String
        let summary: String
        let description: String?
        let location: String?
        let startsAt: String
        let endsAt: String
        let allDay: Bool
        let timeZone: String
        let cancelled: Bool
    }

    struct Invitee: Decodable, Hashable {
        let email: String
        let name: String?
        let status: String
        let isMe: Bool
    }

    struct MyProposal: Decodable, Identifiable, Hashable {
        let id: String
        let proposedStartsAt: String
        let proposedEndsAt: String
        let note: String?
        let status: String
        let createdAt: String
        let decidedAt: String?
    }

    struct Invitation: Decodable, Identifiable, Hashable {
        var id: String { token }
        let token: String
        let responseStatus: String
        let respondedAt: String?
        let expiresAt: String
        let organizer: Organizer?
        let event: InvEvent
        let invitees: [Invitee]
        let myProposals: [MyProposal]
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if loading && invitations.isEmpty {
                    ProgressView()
                } else if invitations.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "envelope")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("还没有收到邀请")
                            .foregroundStyle(.secondary)
                        if let errorMessage {
                            Text(errorMessage)
                                .font(.callout)
                                .foregroundStyle(.red)
                            Button("重试") { Task { await load() } }
                        }
                    }
                } else {
                    List(invitations) { inv in
                        NavigationLink(value: inv) {
                            InvitationRow(inv: inv)
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("我收到的邀请")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsDoneButton {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("完成") { dismiss() }
                    }
                }
            }
            .navigationDestination(for: Invitation.self) { inv in
                InvitationDetailView(token: inv.token, snapshot: inv) {
                    Task { await load() }
                }
                .environmentObject(state)
            }
            .task {
                await load()
                openDeepLinkIfNeeded()
            }
            .refreshable { await load() }
        }
    }

    private func openDeepLinkIfNeeded() {
        guard let openToken,
              let target = invitations.first(where: { $0.token == openToken }) else { return }
        path = [target]
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            struct Resp: Decodable { let invitations: [Invitation] }
            let resp: Resp = try await APIClient(state: state).get("/invitations")
            invitations = resp.invitations
            errorMessage = nil
        } catch {
            errorMessage = "加载邀请失败".loc
        }
    }
}

private struct InvitationRow: View {
    let inv: InvitationsView.Invitation

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(inv.event.summary)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Spacer()
                Text(Self.statusLabel(inv.responseStatus))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Self.statusColor(inv.responseStatus))
            }
            Text(InvitationTimeText.range(inv.event))
                .font(.callout)
                .foregroundStyle(.secondary)
            if let org = inv.organizer {
                Text("%@: %@".locFormat("组织者".loc, org.name))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if inv.event.cancelled {
                Text("这个事件已被取消")
                    .font(.callout)
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 2)
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "accepted": return "已接受参加".loc
        case "declined": return "已拒绝参加".loc
        case "tentative": return "可能参加".loc
        default: return "已邀请 · 等待回复".loc
        }
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "accepted": return .green
        case "declined": return .red
        case "tentative": return .orange
        default: return .secondary
        }
    }
}

/// Shared time-range formatting — always in the event's display
/// timezone (resolved server-side), never silently in the device zone.
enum InvitationTimeText {
    static func range(_ event: InvitationsView.InvEvent) -> String {
        let tz = TimeZone(identifier: event.timeZone) ?? .current
        guard let start = parse(event.startsAt), let end = parse(event.endsAt) else {
            return event.startsAt
        }
        let dateFmt = DateFormatter()
        dateFmt.locale = Locale.current
        dateFmt.timeZone = tz
        dateFmt.setLocalizedDateFormatFromTemplate("MMMd")
        let timeFmt = DateFormatter()
        timeFmt.locale = Locale.current
        timeFmt.timeZone = tz
        timeFmt.setLocalizedDateFormatFromTemplate("HHmm")
        if event.allDay {
            let s = dateFmt.string(from: start)
            let e = dateFmt.string(from: end)
            return s == e ? s : "\(s) – \(e)"
        }
        let sDate = dateFmt.string(from: start)
        let eDate = dateFmt.string(from: end)
        if sDate == eDate {
            return "\(sDate) \(timeFmt.string(from: start)) – \(timeFmt.string(from: end))"
        }
        return "\(sDate) \(timeFmt.string(from: start)) – \(eDate) \(timeFmt.string(from: end))"
    }

    static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

// MARK: - Detail

private struct InvitationDetailView: View {
    let token: String
    let snapshot: InvitationsView.Invitation
    let onChanged: () -> Void

    @EnvironmentObject var state: AppState

    @State private var inv: InvitationsView.Invitation
    @State private var acting = false
    @State private var errorMessage: String?
    @State private var showPropose = false
    @State private var proposeStart: Date
    @State private var proposeEnd: Date
    @State private var proposeNote: String = ""
    @State private var proposeError: String?

    init(token: String, snapshot: InvitationsView.Invitation, onChanged: @escaping () -> Void) {
        self.token = token
        self.snapshot = snapshot
        self.onChanged = onChanged
        _inv = State(initialValue: snapshot)
        _proposeStart = State(initialValue: InvitationTimeText.parse(snapshot.event.startsAt) ?? Date())
        _proposeEnd = State(initialValue: InvitationTimeText.parse(snapshot.event.endsAt) ?? Date().addingTimeInterval(3600))
    }

    private var eventTz: TimeZone {
        TimeZone(identifier: inv.event.timeZone) ?? .current
    }

    private var expired: Bool {
        guard let d = InvitationTimeText.parse(inv.expiresAt) else { return false }
        return d < Date()
    }

    private var canAct: Bool { !inv.event.cancelled && !expired && !acting }

    var body: some View {
        Form {
            // Event summary
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(inv.event.summary).font(.headline)
                    Text(InvitationTimeText.range(inv.event))
                        .font(.callout).foregroundStyle(.secondary)
                    Text("时刻按事件时区（%@）显示".locFormat(inv.event.timeZone))
                        .font(.caption).foregroundStyle(.secondary)
                    if let location = inv.event.location, !location.isEmpty {
                        Text(location).font(.callout)
                    }
                    if let description = inv.event.description, !description.isEmpty {
                        Text(description).font(.callout).foregroundStyle(.secondary)
                    }
                    if inv.event.cancelled {
                        Text("这个事件已被取消").font(.callout.weight(.semibold)).foregroundStyle(.red)
                    } else if expired {
                        Text("邀请已过期，无法再回应").font(.callout).foregroundStyle(.red)
                    }
                }
            }

            // Organizer + invitees — same information architecture as
            // the web invite page.
            Section {
                if let org = inv.organizer {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(org.name).font(.body)
                            Text(org.email).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("组织者")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(inv.invitees, id: \.email) { person in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(person.name ?? person.email).font(.body)
                                if person.isMe {
                                    Text("你")
                                        .font(.caption.weight(.medium))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            if person.name != nil {
                                Text(person.email).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Text(InvitationRow.statusLabel(person.status))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(InvitationRow.statusColor(person.status))
                    }
                }
            } header: {
                Text("邀请名单（%lld 人）".locFormat(inv.invitees.count))
            }

            if !inv.event.cancelled {
                // RSVP
                Section {
                    HStack(spacing: 8) {
                        RsvpButton(title: "接受".loc, selected: inv.responseStatus == "accepted", disabled: !canAct) {
                            Task { await respond("accepted") }
                        }
                        RsvpButton(title: "可能参加".loc, selected: inv.responseStatus == "tentative", disabled: !canAct) {
                            Task { await respond("tentative") }
                        }
                        RsvpButton(title: "拒绝".loc, selected: inv.responseStatus == "declined", disabled: !canAct) {
                            Task { await respond("declined") }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                    if acting {
                        HStack { Spacer(); ProgressView().controlSize(.small); Spacer() }
                    }
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(.red).font(.callout)
                    }
                } header: {
                    Text("你的回复")
                }

                // Propose a new time + my proposal history
                Section {
                    ForEach(inv.myProposals) { p in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(InvitationTimeText.range(
                                InvitationsView.InvEvent(
                                    id: inv.event.id, summary: inv.event.summary,
                                    description: nil, location: nil,
                                    startsAt: p.proposedStartsAt, endsAt: p.proposedEndsAt,
                                    allDay: inv.event.allDay, timeZone: inv.event.timeZone,
                                    cancelled: false,
                                )
                            ))
                            .font(.callout)
                            if let note = p.note, !note.isEmpty {
                                Text(note).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(Self.proposalStatusLabel(p.status))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                    if showPropose {
                        DatePicker(
                            "开始时间",
                            selection: $proposeStart,
                            displayedComponents: inv.event.allDay ? [.date] : [.date, .hourAndMinute],
                        )
                        .environment(\.timeZone, eventTz)
                        DatePicker(
                            "结束时间",
                            selection: $proposeEnd,
                            displayedComponents: inv.event.allDay ? [.date] : [.date, .hourAndMinute],
                        )
                        .environment(\.timeZone, eventTz)
                        TextField("备注（可选）", text: $proposeNote)
                        if let proposeError {
                            Text(proposeError).foregroundStyle(.red).font(.callout)
                        }
                        Button("提交提议") {
                            Task { await propose() }
                        }
                        .disabled(!canAct)
                    } else {
                        Button("提议新时间") { showPropose = true }
                            .disabled(!canAct)
                    }
                } header: {
                    Text("提议新时间")
                }
            }
        }
        .navigationTitle("我收到的邀请")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reloadSelf() }
    }

    private static func proposalStatusLabel(_ status: String) -> String {
        switch status {
        case "accepted": return "提议已接受".loc
        case "declined": return "提议已拒绝".loc
        case "superseded": return "已被取代".loc
        default: return "待处理".loc
        }
    }

    // MARK: - Networking

    private func reloadSelf() async {
        do {
            struct Resp: Decodable { let invitations: [InvitationsView.Invitation] }
            let resp: Resp = try await APIClient(state: state).get("/invitations")
            if let fresh = resp.invitations.first(where: { $0.token == token }) {
                inv = fresh
            }
        } catch {
            // Keep the snapshot on failure — the list behind us will
            // surface load errors; a detail refresh miss must not blank
            // the page the user is acting on.
        }
    }

    private func respond(_ status: String) async {
        acting = true
        errorMessage = nil
        defer { acting = false }
        do {
            struct Body: Encodable { let status: String }
            struct Resp: Decodable { let ok: Bool? }
            let _: Resp = try await APIClient(state: state).post(
                "/invitations/\(token)/respond",
                body: Body(status: status),
            )
            // 触觉定版口径：RSVP 提交成功算正向确认，与保存成功、
            // 清单勾选一样给一下 .success；失败走 catch，不给。
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await reloadSelf()
            onChanged()
        } catch {
            errorMessage = "回应失败，请稍后再试".loc
        }
    }

    private func propose() async {
        guard proposeEnd > proposeStart else {
            proposeError = "结束时间必须晚于开始时间".loc
            return
        }
        acting = true
        proposeError = nil
        errorMessage = nil
        defer { acting = false }
        do {
            struct Body: Encodable {
                let startsAt: String
                let endsAt: String
                let note: String?
            }
            struct Resp: Decodable { let ok: Bool? }
            let iso = ISO8601DateFormatter()
            let _: Resp = try await APIClient(state: state).post(
                "/invitations/\(token)/propose",
                body: Body(
                    startsAt: iso.string(from: proposeStart),
                    endsAt: iso.string(from: proposeEnd),
                    note: proposeNote.isEmpty ? nil : proposeNote,
                ),
            )
            showPropose = false
            proposeNote = ""
            await reloadSelf()
            onChanged()
        } catch {
            proposeError = "提议失败，请稍后再试".loc
        }
    }
}

private struct RsvpButton: View {
    let title: String
    let selected: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.callout.weight(.medium))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(selected ? .accentColor : .secondary)
        .opacity(selected ? 1 : 0.85)
        .disabled(disabled)
    }
}
