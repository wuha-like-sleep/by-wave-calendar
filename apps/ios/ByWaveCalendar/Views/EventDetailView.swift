// EventDetailView.swift
// Read-only detail of one event with edit + delete actions. Pushed onto
// the calendar list's NavigationStack when the user taps a row.
//
// Edit opens EventEditView as a sheet; delete confirms via .alert and
// pops back to the list on success. Both call back into CalendarView
// via the `onChanged` closure so the parent can refresh its data.

import SwiftUI

struct EventDetailView: View {
    let event: EventDTO
    let calendar: CalendarMeta?
    // List of all calendars the user can write to — passed in so the
    // edit sheet's calendar picker has the full set without re-fetching.
    let allCalendars: [CalendarMeta]
    let onChanged: () -> Void   // parent re-fetches its event list

    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var editing = false
    @State private var editScope: RecurringScope? = nil
    @State private var showScopePickerForEdit = false
    @State private var showScopePickerForDelete = false
    @State private var showDeleteAlert = false  // non-recurring path
    @State private var deleting = false
    @State private var errorMessage: String?

    // Local copy that can be replaced after a save — so the detail
    // view updates immediately without a list round-trip.
    @State private var current: EventDTO

    init(
        event: EventDTO,
        calendar: CalendarMeta?,
        allCalendars: [CalendarMeta],
        onChanged: @escaping () -> Void,
    ) {
        self.event = event
        self.calendar = calendar
        self.allCalendars = allCalendars
        self.onChanged = onChanged
        self._current = State(initialValue: event)
    }

    private var isRecurring: Bool { current.rrule != nil }

    var body: some View {
        List {
            // Title row — color-coded by calendar
            Section {
                HStack(alignment: .top, spacing: 12) {
                    Circle()
                        .fill(Color(hex: calendar?.color) ?? .accentColor)
                        .frame(width: 12, height: 12)
                        .padding(.top, 5)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(current.summary).font(.title3.weight(.semibold))
                        if let cal = calendar {
                            Text(cal.name).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if current.rrule != nil {
                        // Recurring badge — full scope picker (v0.3) not done yet,
                        // so edits to recurring events apply to the whole series.
                        // Surface this so users aren't surprised.
                        Image(systemName: "repeat")
                            .foregroundStyle(.indigo)
                            .accessibilityLabel("重复事件")
                    }
                }
            }

            // Time
            Section("时间") {
                if current.allDay {
                    LabeledContent("全天") {
                        Text(allDayLabel)
                    }
                } else {
                    LabeledContent("开始") {
                        Text(absoluteTime(current.startsAt))
                    }
                    LabeledContent("结束") {
                        Text(absoluteTime(current.endsAt))
                    }
                    LabeledContent("时长") {
                        Text(durationLabel)
                    }
                }
            }

            if let location = current.location, !location.isEmpty {
                Section("地点") {
                    Text(location)
                        .textSelection(.enabled)
                }
            }

            if let desc = current.description, !desc.isEmpty {
                Section("描述") {
                    Text(desc)
                        .textSelection(.enabled)
                }
            }

            if let rrule = current.rrule, !rrule.isEmpty {
                Section("重复规则") {
                    Text(rrule)
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                }
            }

            Section {
                Button(role: .destructive) {
                    if isRecurring {
                        showScopePickerForDelete = true
                    } else {
                        showDeleteAlert = true
                    }
                } label: {
                    if deleting {
                        HStack { ProgressView().controlSize(.small); Text("删除中…") }
                    } else {
                        Label("删除事件", systemImage: "trash")
                    }
                }
                .disabled(deleting)
            }
        }
        .navigationTitle("事件详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑") {
                    if isRecurring {
                        showScopePickerForEdit = true
                    } else {
                        editScope = nil
                        editing = true
                    }
                }
            }
        }
        // Recurring scope picker — Edit path. User chooses scope, we
        // remember it in editScope and open the actual edit sheet.
        .sheet(isPresented: $showScopePickerForEdit) {
            RecurringScopePicker(action: .edit, onPick: { picked in
                showScopePickerForEdit = false
                editScope = picked
                editing = true
            }, onCancel: {
                showScopePickerForEdit = false
            })
        }
        // Recurring scope picker — Delete path.
        .sheet(isPresented: $showScopePickerForDelete) {
            RecurringScopePicker(action: .delete, onPick: { picked in
                showScopePickerForDelete = false
                Task { await doDelete(scope: picked) }
            }, onCancel: {
                showScopePickerForDelete = false
            })
        }
        .sheet(isPresented: $editing) {
            NavigationStack {
                EventEditView(
                    mode: .edit(current),
                    calendars: allCalendars.isEmpty ? [calendar].compactMap { $0 } : allCalendars,
                    scope: editScope,
                    recurrenceId: isRecurring ? current.startsAt : nil,
                    onSaved: { saved in
                        // For instance / future scope, the server returns
                        // either a detached event or a new master — our
                        // current row may not be the right thing to swap in.
                        // Trigger a parent refresh + dismiss instead.
                        if editScope == .instance || editScope == .future {
                            editing = false
                            editScope = nil
                            onChanged()
                            dismiss()
                        } else {
                            self.current = saved
                            editing = false
                            editScope = nil
                            onChanged()
                        }
                    },
                    onCancel: {
                        editing = false
                        editScope = nil
                    },
                )
            }
        }
        .alert("删除事件？", isPresented: $showDeleteAlert) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                Task { await doDelete(scope: nil) }
            }
        } message: {
            Text("此操作不可恢复。")
        }
    }

    private var allDayLabel: String {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "yyyy年M月d日"
        let cal = Calendar.current
        if cal.isDate(current.startsAt, inSameDayAs: current.endsAt) {
            return f.string(from: current.startsAt)
        }
        return f.string(from: current.startsAt) + " — " + f.string(from: current.endsAt)
    }

    private func absoluteTime(_ d: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "yyyy年M月d日 HH:mm"
        return f.string(from: d)
    }

    private var durationLabel: String {
        let s = Int(current.endsAt.timeIntervalSince(current.startsAt))
        if s <= 0 { return "—" }
        let h = s / 3600
        let m = (s % 3600) / 60
        if h > 0 && m > 0 { return "\(h) 小时 \(m) 分钟" }
        if h > 0 { return "\(h) 小时" }
        return "\(m) 分钟"
    }

    private func doDelete(scope: RecurringScope?) async {
        deleting = true
        defer { deleting = false }
        do {
            let client = APIClient(state: state)
            // For recurring instance/future scope, the server expects
            // ?scope=&recurrenceId= as a query string (DELETE has no body).
            var path = "/events/\(current.id)"
            if let scope, scope != .series {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let recId = f.string(from: current.startsAt)
                let encoded = recId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? recId
                path += "?scope=\(scope.rawValue)&recurrenceId=\(encoded)"
            }
            try await client.delete(path)
            onChanged()
            dismiss()
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
