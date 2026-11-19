//
//  ManageCalendarsView.swift
//  ByWaveCalendar
//
//  Added v1.3.7 to mirror the web + Android calendar property editor.
//  The platform's PATCH /calendars/:id has supported name / color /
//  timezone / description updates since day one — only the iOS UI was
//  missing, which left users stuck with "导入的日历" as the name of any
//  ICS-imported calendar.
//
//  We fetch the calendar list directly from GET /calendars on appear
//  instead of plumbing through CalendarView's @State (which is local to
//  that view). CalendarView re-fetches /events on focus + tab switch,
//  so any name/color change here surfaces in the main UI within a
//  second of returning from settings.

import SwiftUI

struct ManageCalendarsView: View {
    @EnvironmentObject var state: AppState
    @State private var calendars: [CalendarMeta] = []
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var showingCreate = false

    var body: some View {
        Group {
            if loading && calendars.isEmpty {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if calendars.isEmpty {
                ContentUnavailableView(
                    "还没有日历",
                    systemImage: "calendar",
                    description: Text("先在 web 或 APP 上新建一个日历"),
                )
            } else {
                List(calendars) { c in
                    NavigationLink {
                        EditCalendarView(calendar: c, onSaved: { Task { await reload() } })
                    } label: {
                        HStack(spacing: 12) {
                            Circle()
                                .fill(Color(hex: c.color) ?? .accentColor)
                                .frame(width: 14, height: 14)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.name)
                                    .font(.body)
                                if let tz = c.timezone, !tz.isEmpty {
                                    Text(tz)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { await reload() }
            }
        }
        .navigationTitle("管理日历")
        .navigationBarTitleDisplayMode(.inline)
        // Create entry on the manage page itself. Creating a calendar
        // used to live ONLY inside the "筛选日历" sheet, while this
        // page — the one named "manage" — had no create button at all;
        // with zero calendars its empty state told users to create one
        // "在 APP 上" with no way to do it here, and the new-event +
        // and ICS import were both disabled at the same time: a dead
        // end for first-run users. Reuses CalendarCreateView as-is.
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingCreate = true
                } label: {
                    Label("新建日历", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $showingCreate) {
            NavigationStack {
                CalendarCreateView(
                    onCreated: {
                        showingCreate = false
                        Task { await reload() }
                    },
                    onCancel: { showingCreate = false },
                )
                .environmentObject(state)
            }
        }
        .task { await reload() }
        .alert("出错了", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } },
        )) {
            Button("好") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            let client = APIClient(state: state)
            // The server's GET /calendars returns a bare array inside
            // the v1 envelope; APIClient.request unwraps `data` for us
            // so we can decode straight to [CalendarMeta].
            let list: [CalendarMeta] = try await client.get("/calendars")
            self.calendars = list
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Edit form for a single calendar. Pre-fills from the current
/// CalendarMeta and PATCHes only the fields that actually changed so
/// the server's log lines stay readable. Same dirty-tracking pattern
/// as Android's EditCalendarSheet.
struct EditCalendarView: View {
    let calendar: CalendarMeta
    let onSaved: () -> Void
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var color: String = ""
    @State private var timezone: String = ""
    @State private var description: String = ""
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var showDeleteConfirm = false
    @State private var deleting = false

    // Curated palette — same hex values as CalendarCreateView so the
    // two flows share a color vocabulary.
    static let swatches: [String] = CalendarCreateView.swatches

    var body: some View {
        Form {
            Section("名称") {
                TextField("例如：工作 / 家庭", text: $name)
            }
            Section("颜色") {
                // Swift's type-checker times out on the previous inline
                // version: LazyVGrid → ForEach → Circle().fill().frame().
                //   overlay(Circle().strokeBorder()).onTapGesture()
                // is too many overloaded modifiers to resolve in one
                // expression. Factored into swatchCircle() — the
                // compiler can solve each layer independently now.
                LazyVGrid(
                    columns: Array(repeating: GridItem(.fixed(36), spacing: 12), count: 6),
                    spacing: 12,
                ) {
                    ForEach(Self.swatches, id: \.self) { hex in
                        swatchCircle(hex: hex)
                    }
                }
                .padding(.vertical, 4)
            }
            // SwiftUI doesn't have a Section(_:content:footer:) overload —
            // mixing a String header with a footer closure crashes the
            // overload resolver ("Generic parameter 'Content' could not
            // be inferred"). Use the full header-closure form instead.
            Section {
                Picker("时区", selection: $timezone) {
                    ForEach(pickerTimezones, id: \.self) { tz in
                        Text(tz).tag(tz)
                    }
                }
                .pickerStyle(.menu)
            } header: {
                Text("默认时区")
            } footer: {
                Text("新建事件时的默认时区；已有事件保留各自的时区。")
                    .font(.footnote)
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
            // Calendar deletion existed on the web and the other clients
            // but was missing here — the server route was there all
            // along. Destructive section sits at the bottom, behind a
            // confirmation dialog, mirroring DeleteAccountPage's stance.
            Section {
                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    HStack {
                        Text("删除日历")
                        if deleting {
                            Spacer()
                            ProgressView().controlSize(.small)
                        }
                    }
                }
                .disabled(deleting || saving)
            }
        }
        .confirmationDialog("删除日历", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                Task { await deleteCalendar() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("确定要删除这个日历吗？其中的所有事件将一并删除，此操作无法撤销。")
        }
        .navigationTitle(calendar.name)
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
                .disabled(saving || !canSave)
            }
        }
        .onAppear {
            // Pre-fill from the calendar metadata. Done in onAppear (not
            // @State default) because the metadata isn't accessible
            // until the view initializes.
            name = calendar.name
            color = calendar.color
            timezone = originalTimezone
            description = calendar.description ?? ""
        }
    }

    /// The timezone this form treats as "unchanged": the calendar's own
    /// zone, or the system zone for rows without one. BOTH the dirty
    /// check and the save payload compare against this single value.
    /// They used to compare against different fallbacks (current zone
    /// in canSave, "" in save) while onAppear substituted the system
    /// zone for any zone missing from the common shortlist — so opening
    /// a calendar whose zone was set on the web to something outside
    /// the shortlist (e.g. America/Denver) enabled Save with no edits,
    /// and a rename-only save silently rewrote its timezone to the
    /// system zone.
    private var originalTimezone: String {
        calendar.timezone ?? TimeZone.current.identifier
    }

    /// Picker options: the common shortlist plus this calendar's own
    /// zone when it isn't in the shortlist, so the Picker can always
    /// represent the current value faithfully instead of substituting
    /// the system zone for it.
    private var pickerTimezones: [String] {
        var list = EventEditView.commonTimezones
        if let own = calendar.timezone, !own.isEmpty, !list.contains(own) {
            list.append(own)
        }
        return list
    }

    /// One color swatch. Extracted from the LazyVGrid body so the
    /// Swift compiler doesn't time out type-checking the parent's
    /// view-modifier chain. (Inline version hit a Swift 5.10 type
    /// inference cliff around .overlay(Circle().strokeBorder(...)).)
    @ViewBuilder
    private func swatchCircle(hex: String) -> some View {
        let fillColor: Color = Color(hex: hex) ?? .accentColor
        let strokeColor: Color = color == hex ? .primary : .clear
        Circle()
            .fill(fillColor)
            .frame(width: 32, height: 32)
            .overlay(Circle().strokeBorder(strokeColor, lineWidth: 3))
            .onTapGesture { color = hex }
    }

    /// Save is enabled when the name is non-empty AND at least one
    /// field actually changed. Empty-name save would 400 server-side.
    private var canSave: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }
        return trimmed != calendar.name ||
            color != calendar.color ||
            timezone != originalTimezone ||
            description != (calendar.description ?? "")
    }

    private func deleteCalendar() async {
        deleting = true
        errorMessage = nil
        defer { deleting = false }
        do {
            let client = APIClient(state: state)
            try await client.delete("/calendars/\(calendar.id)")
            onSaved()
            dismiss()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
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
            let trimmedName = name.trimmingCharacters(in: .whitespaces)
            let body = CalendarUpdateInput(
                name: trimmedName != calendar.name ? trimmedName : nil,
                description: description != (calendar.description ?? "") ? description : nil,
                color: color != calendar.color ? color : nil,
                timezone: timezone != originalTimezone ? timezone : nil,
            )
            let _: CalendarMeta = try await client.patch("/calendars/\(calendar.id)", body: body)
            onSaved()
            dismiss()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
