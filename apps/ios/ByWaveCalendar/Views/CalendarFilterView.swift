// CalendarFilterView.swift
// Sheet listing all the user's calendars with show/hide toggles. Hidden
// IDs are persisted in AppState.hiddenCalendarIds; CalendarView filters
// the event list through that set before rendering each sub-view.
//
// Doubles as the "+ 新建日历" entry point — toolbar button opens a small
// sheet that POSTs /api/v1/calendars. Caller (CalendarView) re-fetches
// its calendar list afterwards via onCalendarsChanged.

import SwiftUI

struct CalendarFilterView: View {
    let calendars: [CalendarMeta]
    let onCalendarsChanged: () -> Void
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var showingCreate = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(calendars) { cal in
                        Toggle(isOn: visibilityBinding(for: cal.id)) {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(Color(hex: cal.color) ?? .accentColor)
                                    .frame(width: 12, height: 12)
                                Text(cal.name)
                            }
                        }
                    }
                } header: {
                    Text("显示的日历")
                } footer: {
                    Text("关闭的日历事件不显示在日 / 周 / 月 / 年视图，但仍然存在 — 在网页或重新打开开关后即可看到。")
                        .font(.footnote)
                }

                if !state.hiddenCalendarIds.isEmpty {
                    Section {
                        Button("全部显示") {
                            state.hiddenCalendarIds.removeAll()
                        }
                    }
                }
            }
            .navigationTitle("筛选日历")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showingCreate = true
                    } label: {
                        Label("新建日历", systemImage: "plus")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .sheet(isPresented: $showingCreate) {
                NavigationStack {
                    CalendarCreateView(
                        onCreated: {
                            showingCreate = false
                            onCalendarsChanged()
                        },
                        onCancel: { showingCreate = false },
                    )
                    .environmentObject(state)
                }
            }
        }
    }

    // SwiftUI Toggle wants a binding. We translate "is this id visible"
    // to/from the hiddenCalendarIds set.
    private func visibilityBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { !state.hiddenCalendarIds.contains(id) },
            set: { isVisible in
                if isVisible {
                    state.hiddenCalendarIds.remove(id)
                } else {
                    state.hiddenCalendarIds.insert(id)
                }
            },
        )
    }
}

// MARK: - Create-calendar sheet

/// Tiny form: name + color swatch + timezone. POSTs /api/v1/calendars
/// and dismisses on success. Server enforces `color` is #rrggbb hex
/// and rejects empty `name` — same validations the web UI uses.
struct CalendarCreateView: View {
    let onCreated: () -> Void
    let onCancel: () -> Void
    @EnvironmentObject var state: AppState

    @State private var name: String = ""
    @State private var description: String = ""
    @State private var color: String = Self.swatches[0]
    @State private var timezone: String = TimeZone.current.identifier
    @State private var saving = false
    @State private var errorMessage: String?

    // Curated palette — same hex values the web client offers in its
    // "新建日历" modal so calendars created on either platform share
    // the same color vocabulary.
    static let swatches: [String] = [
        "#4F46E5", "#7C3AED", "#DB2777", "#DC2626", "#EA580C",
        "#D97706", "#65A30D", "#059669", "#0891B2", "#2563EB",
        "#475569",
    ]

    var body: some View {
        Form {
            Section("名称") {
                TextField("例如：工作 / 家庭 / 学习", text: $name)
            }
            Section("颜色") {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(36), spacing: 12), count: 6), spacing: 12) {
                    ForEach(Self.swatches, id: \.self) { hex in
                        Circle()
                            .fill(Color(hex: hex) ?? .accentColor)
                            .frame(width: 32, height: 32)
                            .overlay(
                                Circle()
                                    .strokeBorder(color == hex ? Color.primary : .clear, lineWidth: 3),
                            )
                            .onTapGesture { color = hex }
                    }
                }
                .padding(.vertical, 4)
            }
            Section("时区") {
                Picker("时区", selection: $timezone) {
                    ForEach(EventEditView.commonTimezones, id: \.self) { tz in
                        Text(tz).tag(tz)
                    }
                }
                .pickerStyle(.menu)
            }
            Section {
                TextField("可选", text: $description, axis: .vertical)
                    .lineLimit(2...4)
            } header: {
                Text("描述")
            } footer: {
                Text("描述会同步到 CalDAV 客户端的日历属性。")
                    .font(.footnote)
            }
            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                }
            }
        }
        .navigationTitle("新建日历")
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
                .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            let client = APIClient(state: state)
            // Server returns the inserted row inside the v1 envelope;
            // APIClient.request unwraps `data` for us so a bare
            // CalendarMeta decodes cleanly.
            let _: CalendarMeta = try await client.post("/calendars", body: CalendarCreateInput(
                name: name.trimmingCharacters(in: .whitespaces),
                description: description.isEmpty ? nil : description,
                color: color,
                timezone: timezone,
            ))
            onCreated()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
