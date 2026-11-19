// AttendeesPage.swift
// Native attendees management — mirrors the web's
// /app/events/:id/attendees flow. List current invitees, add new ones
// (each sends a .ics email), revoke with confirmation.
//
// Server-side this hits the JSON endpoints added in v0.10.4:
//   GET    /api/v1/events/:id/attendees   → { attendees, tokens }
//   POST   /api/v1/events/:id/attendees   → { email }
//   DELETE /api/v1/events/:id/attendees   → { email } (in body, not path,
//          to keep @-encoding off the URL)

import SwiftUI

struct AttendeesPage: View {
    let eventId: String
    let eventTitle: String

    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var attendees: [String] = []
    @State private var tokens: [AttendeeToken] = []
    @State private var proposals: [TimeProposal] = []
    @State private var newEmail: String = ""
    @State private var loading = true
    @State private var inviting = false
    @State private var pendingRevoke: String?
    @State private var errorMessage: String?
    @State private var infoMessage: String?

    /// Per-recipient invite history. Lets the user see who's been mailed,
    /// when they accepted (if at all), and when each token expires.
    struct AttendeeToken: Decodable, Identifiable {
        var id: String { token }
        let token: String
        let recipientEmail: String
        let createdAt: String
        let expiresAt: String
        let acceptedAt: String?
        // RSVP 回复状态。老版本服务端不返回这两个字段，所以是 Optional，
        // 缺失时回落到「已邀请 · 等待回复」的旧显示。
        let responseStatus: String?
        let respondedAt: String?
    }

    /// 受邀者的「提议新时间」。status: pending / accepted / declined / superseded。
    struct TimeProposal: Decodable, Identifiable {
        let id: String
        let proposerEmail: String
        let proposedStartsAt: String
        let proposedEndsAt: String
        let note: String?
        let status: String
    }

    var body: some View {
        Form {
            // Header — show which event we're editing.
            Section {
                Label {
                    Text(eventTitle).font(.body.weight(.medium))
                } icon: {
                    Image(systemName: "calendar.circle.fill").foregroundStyle(state.themeAccent)
                }
            }

            // Add new attendee — single email input + submit. Matches the
            // web form: "邀请新参与者".
            Section {
                HStack {
                    TextField("邮箱地址", text: $newEmail)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(inviting)
                    if inviting {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("邀请") {
                            Task { await invite() }
                        }
                        .disabled(!canInvite)
                    }
                }
            } header: {
                Text("邀请新参与者")
            }

            // Current attendees list — swipe to revoke.
            Section {
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowBackground(Color.clear)
                } else if attendees.isEmpty {
                    Text("还没有人")
                        .foregroundStyle(.secondary)
                        .font(.callout)
                } else {
                    ForEach(attendees, id: \.self) { email in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(email).font(.body)
                                if let tok = latestToken(for: email) {
                                    Text(statusLabel(for: tok))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                pendingRevoke = email
                            } label: {
                                Label("撤销", systemImage: "person.crop.circle.badge.xmark")
                            }
                        }
                    }
                }
            } header: {
                Text("当前参与者 (%lld)".locFormat(attendees.count))
            }

            // Time proposals — pending ones need the organizer's decision.
            if !proposals.isEmpty {
                Section("时间提议") {
                    ForEach(proposals) { proposal in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(proposal.proposerEmail).font(.callout)
                            Text("%@ → %@".locFormat(shortDate(proposal.proposedStartsAt), shortDate(proposal.proposedEndsAt)))
                                .font(.caption).foregroundStyle(.secondary)
                            if let note = proposal.note, !note.isEmpty {
                                Text(note).font(.caption).foregroundStyle(.secondary)
                            }
                            if proposal.status == "pending" {
                                HStack {
                                    Button("接受并改时间") {
                                        Task { await decide(proposal: proposal, accept: true) }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .controlSize(.small)
                                    Button("拒绝提议", role: .destructive) {
                                        Task { await decide(proposal: proposal, accept: false) }
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                }
                            } else {
                                Text(proposal.status == "accepted" ? "已接受参加".loc
                                     : proposal.status == "declined" ? "已拒绝参加".loc
                                     : "已被取代".loc)
                                    .font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }

            // History — all tokens ever issued for this event.
            if !tokens.isEmpty {
                Section("所有邀请记录") {
                    ForEach(tokens) { tok in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tok.recipientEmail).font(.callout)
                            Text("邀请 %@ · 到期 %@".locFormat(shortDate(tok.createdAt), shortDate(tok.expiresAt)))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
            }
            if let infoMessage {
                Section { Text(infoMessage).foregroundStyle(.green).font(.callout) }
            }
        }
        .navigationTitle("管理参与者")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await load()
        }
        .alert("撤销 %@？".locFormat(pendingRevoke ?? ""), isPresented: Binding(
            get: { pendingRevoke != nil },
            set: { if !$0 { pendingRevoke = nil } },
        )) {
            Button("取消", role: .cancel) {}
            Button("撤销", role: .destructive) {
                if let email = pendingRevoke {
                    Task { await revoke(email: email) }
                }
            }
        } message: {
            Text("该参与者会从事件移除，待接受的邀请也会作废。")
        }
    }

    // MARK: - Networking

    private var canInvite: Bool {
        !inviting && newEmail.contains("@") && newEmail.count >= 5
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            struct Resp: Decodable {
                let attendees: [String]
                let tokens: [AttendeeToken]
                let proposals: [TimeProposal]?
            }
            let resp: Resp = try await APIClient(state: state).get("/events/\(eventId)/attendees")
            attendees = resp.attendees
            tokens = resp.tokens
            proposals = resp.proposals ?? []
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func invite() async {
        let email = newEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard email.contains("@") else { return }
        inviting = true
        errorMessage = nil
        infoMessage = nil
        defer { inviting = false }
        do {
            struct Body: Encodable { let email: String }
            struct Resp: Decodable { let ok: Bool?; let email: String?; let warning: String?; let message: String? }
            let resp: Resp = try await APIClient(state: state).post(
                "/events/\(eventId)/attendees",
                body: Body(email: email),
            )
            // Server may return ok + warning when mail failed but row was
            // still added. Show that as info rather than error.
            if let warning = resp.warning, let message = resp.message {
                infoMessage = message + " (" + warning + ")"
            } else {
                infoMessage = "已邀请 %@".locFormat(email)
            }
            newEmail = ""
            await load()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func revoke(email: String) async {
        pendingRevoke = nil
        errorMessage = nil
        do {
            // Custom DELETE with body — APIClient's delete() doesn't
            // accept a body, so we use a small URLRequest here.
            guard let serverURL = state.serverURL else { throw APIError.notSignedIn }
            let token = try await state.currentAccessToken()
            guard let url = APIClient.makeURL(server: serverURL, path: "/events/\(eventId)/attendees") else {
                throw APIError.network(NSError(domain: "bad-url", code: 0))
            }
            var req = URLRequest(url: url)
            req.httpMethod = "DELETE"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(["email": email])
            let (_, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode < 400 else {
                let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
                throw APIError.server(status: status, body: nil)
            }
            infoMessage = "已撤销 %@".locFormat(email)
            await load()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Display helpers

    private func latestToken(for email: String) -> AttendeeToken? {
        tokens.filter { $0.recipientEmail == email }.last
    }

    private func statusLabel(for tok: AttendeeToken) -> String {
        // RSVP 状态优先（参加/拒绝/可能），acceptedAt（已加进自己日历）
        // 是另一回事，只在没有回复状态的老数据上才用它兜底。
        switch tok.responseStatus {
        case "accepted": return "已接受参加".loc
        case "declined": return "已拒绝参加".loc
        case "tentative": return "可能参加".loc
        case "pending": return "已邀请 · 等待回复".loc
        default: break
        }
        if let acceptedAt = tok.acceptedAt {
            return "已接受 · %@".locFormat(shortDate(acceptedAt))
        }
        return "已邀请 · 等待回复".loc
    }

    private func decide(proposal: TimeProposal, accept: Bool) async {
        errorMessage = nil
        do {
            struct Empty: Encodable {}
            struct Resp: Decodable { let ok: Bool? }
            let _: Resp = try await APIClient(state: state).post(
                "/events/\(eventId)/proposals/\(proposal.id)/\(accept ? "accept" : "decline")",
                body: Empty(),
            )
            await load()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func shortDate(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        let display = DateFormatter()
        display.locale = Locale.current
        display.setLocalizedDateFormatFromTemplate("MMMdHHmm")
        return display.string(from: d)
    }
}
