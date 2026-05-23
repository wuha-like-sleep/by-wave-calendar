// DayView.swift
// Events on a single day, sorted by time. Shown as the "日" tab.
// Parent provides the day to display + the events list (already filtered
// to the right window by the parent's load).

import SwiftUI

struct DayView: View {
    let anchor: Date  // start-of-day for the day we're showing
    let events: [EventDTO]   // pre-filtered to this day, sorted by start
    let calendars: [CalendarMeta]
    let onEventChanged: () -> Void

    @EnvironmentObject var state: AppState
    @State private var pendingDeleteId: String?
    @State private var showDeleteAlert = false
    @State private var pendingDuplicate: EventDTO?

    private var calLookup: [String: CalendarMeta] {
        Dictionary(uniqueKeysWithValues: calendars.map { ($0.id, $0) })
    }

    var body: some View {
        Group {
            if events.isEmpty {
                EmptyDayPlaceholder(date: anchor)
            } else {
                List {
                    ForEach(events) { ev in
                        NavigationLink {
                            EventDetailView(
                                event: ev,
                                calendar: calLookup[ev.calendarId],
                                allCalendars: calendars,
                                onChanged: onEventChanged,
                            )
                        } label: {
                            EventRowView(
                                event: ev,
                                calendar: calLookup[ev.calendarId],
                                onDelete: ev.rrule == nil ? {
                                    pendingDeleteId = ev.id
                                    showDeleteAlert = true
                                } : nil,
                                onDuplicate: { pendingDuplicate = ev },
                                onCopySummary: {},
                            )
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .alert("删除事件？", isPresented: $showDeleteAlert) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                if let id = pendingDeleteId { Task { await delete(id: id) } }
            }
        } message: {
            Text("此操作不可恢复。重复事件请进详情删除。")
        }
        .sheet(item: $pendingDuplicate) { ev in
            NavigationStack {
                EventEditView(
                    mode: .duplicateOf(ev),
                    calendars: calendars,
                    onSaved: { _ in
                        pendingDuplicate = nil
                        onEventChanged()
                    },
                    onCancel: { pendingDuplicate = nil },
                )
            }
        }
    }

    private func delete(id: String) async {
        do {
            try await APIClient(state: state).delete("/events/\(id)")
            onEventChanged()
        } catch {
            // Silent — parent reload will surface any inconsistency.
        }
    }
}

private struct EmptyDayPlaceholder: View {
    let date: Date
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "calendar")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)
            Text(label).font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var label: String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "今天没有事件" }
        if cal.isDateInTomorrow(date) { return "明天没有事件" }
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "M月d日"
        return "\(f.string(from: date)) 没有事件"
    }
}
