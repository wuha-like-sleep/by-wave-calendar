//
//  BookingLinksView.swift
//  ByWaveCalendar
//
//  Native owner management for 预约链接 / Booking links. Mirrors the web +
//  the iOS ManageCalendarsView pattern: a List fetched from
//  GET /booking-links on appear, a "+" toolbar button that pushes a
//  create form, per-row enabled/paused toggle (PATCH), copy / open of the
//  public booking URL, and swipe-to-delete.
//
//  We fetch the calendar list from GET /calendars on appear too, so the
//  create + edit forms can offer a calendar picker without plumbing
//  through CalendarView's local @State. weeklyAvailability is NOT edited
//  here for v1 — the server keeps whatever default it assigned.

import SwiftUI
import UIKit

struct BookingLinksView: View {
    @EnvironmentObject var state: AppState
    @State private var links: [BookingLink] = []
    @State private var calendars: [CalendarMeta] = []
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var showingCreate = false
    @State private var copiedId: String?

    var body: some View {
        Group {
            if loading && links.isEmpty {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if links.isEmpty {
                ContentUnavailableView(
                    "还没有预约链接",
                    systemImage: "link",
                    description: Text("创建一个预约链接，别人就能预约你的时间"),
                )
            } else {
                List {
                    // One Section per link. The NavigationLink row (title +
                    // url) handles the push to the editor; the action row
                    // below it keeps the copy / open buttons + enabled
                    // toggle OUT of the NavigationLink label so their taps
                    // don't also trigger navigation.
                    ForEach(links) { link in
                        Section {
                            NavigationLink {
                                EditBookingLinkView(
                                    link: link,
                                    calendars: calendars,
                                    onSaved: { Task { await reload() } },
                                )
                            } label: {
                                headerRow(for: link)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await delete(link) }
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                            actionRow(for: link)
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { await reload() }
            }
        }
        .navigationTitle("预约链接")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingCreate = true
                } label: {
                    Label("新建预约链接", systemImage: "plus")
                }
                .disabled(calendars.isEmpty)
            }
        }
        .task { await reload() }
        .sheet(isPresented: $showingCreate) {
            NavigationStack {
                CreateBookingLinkView(
                    calendars: calendars,
                    onCreated: {
                        showingCreate = false
                        Task { await reload() }
                    },
                    onCancel: { showingCreate = false },
                )
                .environmentObject(state)
            }
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

    /// Top row of a link's Section — title + paused badge + duration +
    /// the public URL. This is the NavigationLink label, so it stays
    /// non-interactive (pure text) to avoid gesture conflicts.
    @ViewBuilder
    private func headerRow(for link: BookingLink) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(link.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                if !link.enabled {
                    Text("已暂停")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.15), in: Capsule())
                }
                Spacer()
                Text("%lld 分钟".locFormat(link.durationMinutes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(link.publicUrl)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.vertical, 2)
    }

    /// Action row — copy / open buttons + the enabled toggle. Lives
    /// OUTSIDE the NavigationLink so its controls own their taps.
    @ViewBuilder
    private func actionRow(for link: BookingLink) -> some View {
        HStack(spacing: 16) {
            Button {
                UIPasteboard.general.string = link.publicUrl
                copiedId = link.id
                // Reset the "已复制" affordance after a beat.
                Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    if copiedId == link.id { copiedId = nil }
                }
            } label: {
                Label((copiedId == link.id ? "已复制" : "复制").loc,
                      systemImage: copiedId == link.id ? "checkmark" : "doc.on.doc")
                    .font(.caption)
            }
            .buttonStyle(.borderless)

            Button {
                if let url = URL(string: link.publicUrl) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Label("打开", systemImage: "safari")
                    .font(.caption)
            }
            .buttonStyle(.borderless)

            Spacer()

            Toggle("启用", isOn: enabledBinding(for: link))
                .labelsHidden()
        }
    }

    /// Binding that PATCHes `enabled` when flipped, with optimistic local
    /// update so the toggle feels instant; reverts on error.
    private func enabledBinding(for link: BookingLink) -> Binding<Bool> {
        Binding(
            get: { links.first(where: { $0.id == link.id })?.enabled ?? link.enabled },
            set: { newValue in
                Task { await setEnabled(link, enabled: newValue) }
            },
        )
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            let client = APIClient(state: state)
            // Load calendars first so the create/edit picker has options
            // even on the very first appear; then the links themselves.
            // Sequential (not async-let) to match ManageCalendarsView and
            // keep APIClient's @MainActor isolation simple.
            self.calendars = try await client.get("/calendars")
            self.links = try await client.listBookingLinks()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func setEnabled(_ link: BookingLink, enabled: Bool) async {
        do {
            let client = APIClient(state: state)
            let updated = try await client.setBookingLinkEnabled(id: link.id, enabled: enabled)
            if let idx = links.firstIndex(where: { $0.id == link.id }) {
                links[idx] = updated
            }
        } catch let e as APIError {
            errorMessage = e.localizedDescription
            await reload()
        } catch {
            errorMessage = error.localizedDescription
            await reload()
        }
    }

    private func delete(_ link: BookingLink) async {
        do {
            let client = APIClient(state: state)
            try await client.deleteBookingLink(id: link.id)
            links.removeAll { $0.id == link.id }
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Create booking link

/// Create form: slug, title, optional description, calendar picker,
/// duration, lead time / window, buffers, notify-email toggle. POSTs
/// /api/v1/booking-links and dismisses on success. The server enforces
/// the slug regex `^[a-z0-9][a-z0-9-]{0,30}$`; we lowercase + trim
/// client-side so a stray space / capital doesn't bounce off the server.
struct CreateBookingLinkView: View {
    let calendars: [CalendarMeta]
    let onCreated: () -> Void
    let onCancel: () -> Void
    @EnvironmentObject var state: AppState

    @State private var slug: String = ""
    @State private var title: String = ""
    @State private var description: String = ""
    @State private var calendarId: String = ""
    @State private var durationMinutes: Int = 30
    @State private var minNoticeHours: Int = 12
    @State private var maxDaysAhead: Int = 30
    @State private var bufferBeforeMin: Int = 0
    @State private var bufferAfterMin: Int = 0
    @State private var notifyEmail: Bool = true
    @State private var saving = false
    @State private var errorMessage: String?

    private var normalizedSlug: String {
        slug.trimmingCharacters(in: .whitespaces).lowercased()
    }

    private var canSave: Bool {
        !saving
            && !title.trimmingCharacters(in: .whitespaces).isEmpty
            && BookingLinkForm.isValidSlug(normalizedSlug)
            && !calendarId.isEmpty
    }

    var body: some View {
        Form {
            Section {
                TextField("例如：30min-chat", text: $slug)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !slug.isEmpty && !BookingLinkForm.isValidSlug(normalizedSlug) {
                    Label("只能用小写字母、数字和连字符，1–31 位", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
            } header: {
                Text("链接地址")
            } footer: {
                Text("出现在公开预约链接的末尾，创建后建议不要再改。")
                    .font(.footnote)
            }

            Section("标题") {
                TextField("例如：30 分钟咨询", text: $title)
            }

            Section {
                Picker("日历", selection: $calendarId) {
                    ForEach(calendars) { c in
                        Text(c.name).tag(c.id)
                    }
                }
                .pickerStyle(.menu)
            } header: {
                Text("日历")
            } footer: {
                Text("预约成功后会在这个日历里创建事件。")
                    .font(.footnote)
            }

            BookingLinkForm.timingSections(
                durationMinutes: $durationMinutes,
                minNoticeHours: $minNoticeHours,
                maxDaysAhead: $maxDaysAhead,
                bufferBeforeMin: $bufferBeforeMin,
                bufferAfterMin: $bufferAfterMin,
            )

            Section {
                Toggle("有新预约时邮件通知我", isOn: $notifyEmail)
            } header: {
                Text("通知")
            }

            Section {
                TextField("可选", text: $description, axis: .vertical)
                    .lineLimit(2...4)
            } header: {
                Text("描述")
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                }
            }
        }
        .navigationTitle("新建预约链接")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { onCancel() }.disabled(saving)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: { Task { await save() } }) {
                    if saving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("创建").bold()
                    }
                }
                .disabled(!canSave)
            }
        }
        .onAppear {
            // Default the calendar picker to the first calendar so the
            // selection isn't empty (which would disable "创建").
            if calendarId.isEmpty {
                calendarId = calendars.first?.id ?? ""
            }
        }
    }

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            let client = APIClient(state: state)
            let trimmedDesc = description.trimmingCharacters(in: .whitespacesAndNewlines)
            let _: BookingLink = try await client.createBookingLink(BookingLinkCreateInput(
                slug: normalizedSlug,
                title: title.trimmingCharacters(in: .whitespaces),
                description: trimmedDesc.isEmpty ? nil : trimmedDesc,
                calendarId: calendarId,
                durationMinutes: durationMinutes,
                minNoticeHours: minNoticeHours,
                maxDaysAhead: maxDaysAhead,
                bufferBeforeMin: bufferBeforeMin,
                bufferAfterMin: bufferAfterMin,
                notifyEmail: notifyEmail,
            ))
            onCreated()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Edit booking link

/// Edit form for an existing link. Pre-fills from the BookingLink and
/// PATCHes only the fields that actually changed, mirroring
/// EditCalendarView's dirty-tracking so the server's log lines stay
/// readable. slug is editable but warned against.
struct EditBookingLinkView: View {
    let link: BookingLink
    let calendars: [CalendarMeta]
    let onSaved: () -> Void
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var slug: String = ""
    @State private var title: String = ""
    @State private var description: String = ""
    @State private var calendarId: String = ""
    @State private var durationMinutes: Int = 30
    @State private var minNoticeHours: Int = 12
    @State private var maxDaysAhead: Int = 30
    @State private var bufferBeforeMin: Int = 0
    @State private var bufferAfterMin: Int = 0
    @State private var enabled: Bool = true
    @State private var notifyEmail: Bool = true
    @State private var saving = false
    @State private var errorMessage: String?

    private var normalizedSlug: String {
        slug.trimmingCharacters(in: .whitespaces).lowercased()
    }

    private var canSave: Bool {
        guard !saving,
              !title.trimmingCharacters(in: .whitespaces).isEmpty,
              BookingLinkForm.isValidSlug(normalizedSlug),
              !calendarId.isEmpty
        else { return false }
        return isDirty
    }

    private var isDirty: Bool {
        normalizedSlug != link.slug
            || title.trimmingCharacters(in: .whitespaces) != link.title
            || description != (link.description ?? "")
            || calendarId != link.calendarId
            || durationMinutes != link.durationMinutes
            || minNoticeHours != link.minNoticeHours
            || maxDaysAhead != link.maxDaysAhead
            || bufferBeforeMin != link.bufferBeforeMin
            || bufferAfterMin != link.bufferAfterMin
            || enabled != link.enabled
            || notifyEmail != link.notifyEmail
    }

    var body: some View {
        Form {
            Section {
                TextField("链接地址", text: $slug)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !slug.isEmpty && !BookingLinkForm.isValidSlug(normalizedSlug) {
                    Label("只能用小写字母、数字和连字符，1–31 位", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
            } header: {
                Text("链接地址")
            } footer: {
                Text("改动链接地址会让旧链接失效。")
                    .font(.footnote)
            }

            Section("标题") {
                TextField("标题", text: $title)
            }

            Section {
                Picker("日历", selection: $calendarId) {
                    ForEach(calendars) { c in
                        Text(c.name).tag(c.id)
                    }
                    // If the link points at a calendar no longer in the
                    // list (deleted / not loaded), keep its id selectable
                    // so the Picker isn't stuck on an invalid selection.
                    if !calendars.contains(where: { $0.id == link.calendarId }) {
                        Text(link.calendarId).tag(link.calendarId)
                    }
                }
                .pickerStyle(.menu)
            } header: {
                Text("日历")
            }

            BookingLinkForm.timingSections(
                durationMinutes: $durationMinutes,
                minNoticeHours: $minNoticeHours,
                maxDaysAhead: $maxDaysAhead,
                bufferBeforeMin: $bufferBeforeMin,
                bufferAfterMin: $bufferAfterMin,
            )

            Section {
                Toggle("启用", isOn: $enabled)
                Toggle("有新预约时邮件通知我", isOn: $notifyEmail)
            } header: {
                Text("状态与通知")
            }

            Section {
                TextField("可选", text: $description, axis: .vertical)
                    .lineLimit(2...4)
            } header: {
                Text("描述")
            }

            Section {
                LabeledContent("预约链接") {
                    Text(link.publicUrl)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                Button {
                    UIPasteboard.general.string = link.publicUrl
                } label: {
                    Label("复制链接", systemImage: "doc.on.doc")
                }
                Button {
                    if let url = URL(string: link.publicUrl) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("在浏览器中打开", systemImage: "safari")
                }
            } header: {
                Text("公开链接")
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                }
            }
        }
        .navigationTitle(link.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: { Task { await save() } }) {
                    if saving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("保存").bold()
                    }
                }
                .disabled(!canSave)
            }
        }
        .onAppear {
            // Pre-fill from the link metadata. Done in onAppear (not
            // @State default) because the link isn't accessible until the
            // view initializes.
            slug = link.slug
            title = link.title
            description = link.description ?? ""
            calendarId = link.calendarId
            durationMinutes = link.durationMinutes
            minNoticeHours = link.minNoticeHours
            maxDaysAhead = link.maxDaysAhead
            bufferBeforeMin = link.bufferBeforeMin
            bufferAfterMin = link.bufferAfterMin
            enabled = link.enabled
            notifyEmail = link.notifyEmail
        }
    }

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            let client = APIClient(state: state)
            // Send only the fields that actually changed — server's
            // partial schema accepts the smaller payload happily.
            let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
            let body = BookingLinkUpdateInput(
                slug: normalizedSlug != link.slug ? normalizedSlug : nil,
                title: trimmedTitle != link.title ? trimmedTitle : nil,
                description: description != (link.description ?? "") ? description : nil,
                calendarId: calendarId != link.calendarId ? calendarId : nil,
                durationMinutes: durationMinutes != link.durationMinutes ? durationMinutes : nil,
                minNoticeHours: minNoticeHours != link.minNoticeHours ? minNoticeHours : nil,
                maxDaysAhead: maxDaysAhead != link.maxDaysAhead ? maxDaysAhead : nil,
                bufferBeforeMin: bufferBeforeMin != link.bufferBeforeMin ? bufferBeforeMin : nil,
                bufferAfterMin: bufferAfterMin != link.bufferAfterMin ? bufferAfterMin : nil,
                enabled: enabled != link.enabled ? enabled : nil,
                notifyEmail: notifyEmail != link.notifyEmail ? notifyEmail : nil,
            )
            let _: BookingLink = try await client.updateBookingLink(id: link.id, body)
            onSaved()
            dismiss()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Shared form pieces

/// Timing / buffer pickers shared by the create + edit forms, plus the
/// slug validator. Factored out so the two forms can't drift and so the
/// Swift type-checker solves each Picker independently.
enum BookingLinkForm {
    static let durationOptions = [15, 30, 45, 60, 90, 120]
    static let noticeOptions = [0, 1, 2, 4, 8, 12, 24, 48]
    static let windowOptions = [7, 14, 30, 60, 90]
    static let bufferOptions = [0, 5, 10, 15, 30]

    /// Mirrors the server slug rule `^[a-z0-9][a-z0-9-]{0,31}$` (1–31
    /// chars, lowercase alnum + hyphen, can't start with a hyphen).
    static func isValidSlug(_ s: String) -> Bool {
        guard (1...31).contains(s.count) else { return false }
        return s.range(of: "^[a-z0-9][a-z0-9-]{0,30}$", options: .regularExpression) != nil
    }

    @ViewBuilder
    static func timingSections(
        durationMinutes: Binding<Int>,
        minNoticeHours: Binding<Int>,
        maxDaysAhead: Binding<Int>,
        bufferBeforeMin: Binding<Int>,
        bufferAfterMin: Binding<Int>,
    ) -> some View {
        Section {
            Picker("时长", selection: durationMinutes) {
                ForEach(durationOptions, id: \.self) { m in
                    Text("%lld 分钟".locFormat(m)).tag(m)
                }
            }
        } header: {
            Text("单次时长")
        }

        Section {
            Picker("最短提前", selection: minNoticeHours) {
                ForEach(noticeOptions, id: \.self) { h in
                    Text("%lld 小时".locFormat(h)).tag(h)
                }
            }
            Picker("最远可约", selection: maxDaysAhead) {
                ForEach(windowOptions, id: \.self) { d in
                    Text("%lld 天".locFormat(d)).tag(d)
                }
            }
        } header: {
            Text("可预约范围")
        } footer: {
            Text("别人最早要提前多久、最远能约到几天后。")
                .font(.footnote)
        }

        Section {
            Picker("前缓冲", selection: bufferBeforeMin) {
                ForEach(bufferOptions, id: \.self) { m in
                    Text("%lld 分钟".locFormat(m)).tag(m)
                }
            }
            Picker("后缓冲", selection: bufferAfterMin) {
                ForEach(bufferOptions, id: \.self) { m in
                    Text("%lld 分钟".locFormat(m)).tag(m)
                }
            }
        } header: {
            Text("前后缓冲")
        } footer: {
            Text("在每个预约前后预留的空档，避免连轴转。")
                .font(.footnote)
        }
    }
}
