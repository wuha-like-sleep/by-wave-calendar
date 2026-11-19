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
    @State private var color: String = Self.defaultColor
    @State private var timezone: String = TimeZone.current.identifier
    @State private var saving = false
    @State private var errorMessage: String?

    // Shared palette — the same 17 colors, in the same order, as the
    // web client's COLOR_PALETTE (calendar-app.js), so a color offered
    // on one platform can be picked identically on every other. (This
    // used to be an 11-color set whose comment claimed parity with the
    // web list it didn't actually match; Android and desktop carried
    // two further, different sets.)
    static let swatches: [String] = [
        "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
        "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
        "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
        "#ec4899", "#64748b",
    ]

    // New-calendar default — the web create dialog's default (#6366f1
    // indigo), not the first palette entry (which is red).
    static let defaultColor = "#6366f1"

    var body: some View {
        Form {
            Section("名称") {
                TextField("例如：工作 / 家庭 / 学习", text: $name)
            }
            Section("颜色") {
                // Inline swatch grid hit a Swift 5.10 type-checker
                // timeout in the sibling ManageCalendarsView. Same
                // pattern here — refactor preemptively so a future
                // Swift update doesn't crank up inference cost and
                // break the build again.
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

    /// One color swatch. Extracted from the LazyVGrid body to keep
    /// Swift's type-checker happy — the inline chain
    ///   Circle().fill().frame().overlay(Circle().strokeBorder()).onTapGesture()
    /// caused a "unable to type-check this expression in reasonable
    /// time" error in the sibling ManageCalendarsView.
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
