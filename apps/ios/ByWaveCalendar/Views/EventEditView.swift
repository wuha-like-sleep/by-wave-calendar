// EventEditView.swift
// One form that handles both "create" and "edit". The .mode enum decides
// which API call to fire on Save. Designed as a sheet — caller wraps in
// a NavigationStack so Save / Cancel can live in the toolbar.

import SwiftUI

enum EventEditMode {
    case create
    // "Duplicate" — same UI as create, but the form is seeded from an
    // existing event. We never PATCH the source; on save we POST a new
    // event so the original stays put.
    case duplicateOf(EventDTO)
    case edit(EventDTO)

    var isCreate: Bool {
        switch self {
        case .create, .duplicateOf: return true
        case .edit: return false
        }
    }
    var existing: EventDTO? {
        if case .edit(let e) = self { return e }
        return nil
    }
    // The event to seed form fields from (for both edit + duplicate).
    var seed: EventDTO? {
        switch self {
        case .create: return nil
        case .duplicateOf(let e): return e
        case .edit(let e): return e
        }
    }
}

struct EventEditView: View {
    let mode: EventEditMode
    let calendars: [CalendarMeta]
    // The chosen recurring scope (and recurrence-id) — applies only to
    // edits of recurring events. nil means "entire series" (also the
    // default for non-recurring). Caller decides via a separate scope
    // sheet before opening this view.
    let scope: RecurringScope?
    let recurrenceId: Date?
    // Optional "create here" seed — used by WeekView when the user taps
    // an empty grid cell, so the start time is the tapped hour instead
    // of the default "next half hour". Ignored for edit/duplicate.
    let prefilledStart: Date?
    let onSaved: (EventDTO) -> Void
    let onCancel: () -> Void

    @EnvironmentObject var state: AppState

    @State private var summary: String
    @State private var location: String
    @State private var description: String
    @State private var startsAt: Date
    @State private var endsAt: Date
    @State private var allDay: Bool
    @State private var calendarId: String
    @State private var saving = false
    @State private var errorMessage: String?

    // Lock end-time auto-shift to start-time changes UNTIL the user
    // manually touches the end picker. Same UX as the web client —
    // change "start" by 30 min, "end" follows; touch "end" once, the
    // linkage breaks for the rest of this edit session.
    @State private var endLinkedToStart = true

    init(
        mode: EventEditMode,
        calendars: [CalendarMeta],
        scope: RecurringScope? = nil,
        recurrenceId: Date? = nil,
        prefilledStart: Date? = nil,
        onSaved: @escaping (EventDTO) -> Void,
        onCancel: @escaping () -> Void,
    ) {
        self.mode = mode
        self.calendars = calendars
        self.scope = scope
        self.recurrenceId = recurrenceId
        self.prefilledStart = prefilledStart
        self.onSaved = onSaved
        self.onCancel = onCancel
        if let e = mode.seed {
            // For "duplicate" we want today's slot, not the source's
            // possibly-historical start. Edit keeps the original time.
            let useOriginalTime = mode.existing != nil
            _summary = State(initialValue: e.summary)
            _location = State(initialValue: e.location ?? "")
            _description = State(initialValue: e.description ?? "")
            if useOriginalTime {
                _startsAt = State(initialValue: e.startsAt)
                _endsAt = State(initialValue: e.endsAt)
            } else {
                // Duplicate: snap to next half-hour, preserve duration.
                let duration = e.endsAt.timeIntervalSince(e.startsAt)
                let start = Self.roundUpToHalfHour(Date())
                _startsAt = State(initialValue: start)
                _endsAt = State(initialValue: start.addingTimeInterval(max(duration, 1800)))
            }
            _allDay = State(initialValue: e.allDay)
            _calendarId = State(initialValue: e.calendarId)
        } else {
            // Sensible default for "new event": next half-hour, 60min
            // duration. Caller can override via prefilledStart (e.g.
            // WeekView passes the tapped grid cell's hour).
            let start = prefilledStart ?? Self.roundUpToHalfHour(Date())
            _summary = State(initialValue: "")
            _location = State(initialValue: "")
            _description = State(initialValue: "")
            _startsAt = State(initialValue: start)
            _endsAt = State(initialValue: start.addingTimeInterval(3600))
            _allDay = State(initialValue: false)
            _calendarId = State(initialValue: calendars.first?.id ?? "")
        }
    }

    var body: some View {
        Form {
            Section {
                TextField("事件标题", text: $summary, axis: .vertical)
                    .lineLimit(1...3)
            }

            // Calendar picker — shown for both create and edit. Editing
            // an event lets the user move it to a different calendar
            // (server accepts calendarId on PATCH as of v0.6+).
            if !calendars.isEmpty {
                Section("日历") {
                    Picker("日历", selection: $calendarId) {
                        ForEach(calendars) { c in
                            HStack {
                                Circle().fill(Color(hex: c.color) ?? .accentColor).frame(width: 10, height: 10)
                                Text(c.name)
                            }
                            .tag(c.id)
                        }
                    }
                    .pickerStyle(.menu)
                }
            }

            Section("时间") {
                Toggle("全天", isOn: $allDay)
                if allDay {
                    DatePicker("开始", selection: $startsAt, displayedComponents: .date)
                    DatePicker("结束", selection: $endsAt, in: startsAt..., displayedComponents: .date)
                } else {
                    DatePicker("开始", selection: $startsAt, displayedComponents: [.date, .hourAndMinute])
                        .onChange(of: startsAt) { _, new in
                            // Web-style linkage: shift end by the same delta as start
                            // until the user manually touches end.
                            if endLinkedToStart, let oldStart = oldStartValue {
                                let delta = new.timeIntervalSince(oldStart)
                                if abs(delta) > 1 { endsAt = endsAt.addingTimeInterval(delta) }
                            }
                            oldStartValue = new
                        }
                    DatePicker("结束", selection: $endsAt, in: startsAt..., displayedComponents: [.date, .hourAndMinute])
                        .onChange(of: endsAt) { _, _ in
                            endLinkedToStart = false
                        }
                }
            }

            Section("地点") {
                TextField("可选 — 例如 上海 / Zoom 会议室", text: $location)
            }

            Section("备注") {
                TextField("可选", text: $description, axis: .vertical)
                    .lineLimit(3...8)
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                }
            }
        }
        .navigationTitle({
            switch mode {
            case .create:        return "新建事件"
            case .duplicateOf:   return "复制为新事件"
            case .edit:          return "编辑事件"
            }
        }())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { onCancel() }
                    .disabled(saving)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: { Task { await save() } }) {
                    if saving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(mode.isCreate ? "创建" : "保存").bold()
                    }
                }
                .disabled(saving || summary.trimmingCharacters(in: .whitespaces).isEmpty || calendarId.isEmpty)
            }
        }
        .onAppear {
            oldStartValue = startsAt
        }
    }

    // Used by the .onChange handler to compute the start-time delta and
    // shift end accordingly. Tracks the value seen at the previous frame.
    @State private var oldStartValue: Date?

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }

        let isoStart = iso(startsAt, allDay: allDay, isStart: true)
        let isoEnd = iso(endsAt, allDay: allDay, isStart: false)

        do {
            let client = APIClient(state: state)
            let saved: EventSaved
            switch mode {
            case .create, .duplicateOf:
                // Both paths POST a new event. Duplicate doesn't inherit
                // the source's rrule — we intentionally clear it so the
                // user doesn't accidentally spawn a parallel recurring
                // series. They can add recurrence back in a later edit.
                saved = try await client.post("/events", body: EventCreateInput(
                    calendarId: calendarId,
                    summary: summary.trimmingCharacters(in: .whitespaces),
                    description: description.isEmpty ? nil : description,
                    location: location.isEmpty ? nil : location,
                    startsAt: isoStart,
                    endsAt: isoEnd,
                    allDay: allDay,
                    rrule: nil,
                ))
            case .edit(let existing):
                // Only send calendarId when it actually changed — otherwise
                // server may treat the "no-op move" as a real move and reject
                // (it won't, but cleaner this way).
                let cidIfChanged = calendarId != existing.calendarId ? calendarId : nil
                let recIdIso: String? = recurrenceId.map {
                    let f = ISO8601DateFormatter()
                    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                    return f.string(from: $0)
                }
                saved = try await client.patch("/events/\(existing.id)", body: EventUpdateInput(
                    calendarId: cidIfChanged,
                    summary: summary.trimmingCharacters(in: .whitespaces),
                    description: description.isEmpty ? nil : description,
                    location: location.isEmpty ? nil : location,
                    startsAt: isoStart,
                    endsAt: isoEnd,
                    allDay: allDay,
                    rrule: nil,
                    scope: scope?.rawValue,
                    recurrenceId: recIdIso,
                ))
            }
            onSaved(saved)
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func iso(_ d: Date, allDay: Bool, isStart: Bool) -> String {
        if allDay {
            // Match the web's all-day convention: UTC midnight for the
            // calendar date the user picked. Server interprets the date
            // portion only.
            let cal = Calendar.current
            var comps = cal.dateComponents([.year, .month, .day], from: d)
            comps.hour = isStart ? 0 : 23
            comps.minute = isStart ? 0 : 59
            comps.second = isStart ? 0 : 59
            comps.timeZone = TimeZone(identifier: "UTC")
            let utc = cal.date(from: comps) ?? d
            return ISO8601DateFormatter().string(from: utc)
        }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: d)
    }

    static func roundUpToHalfHour(_ d: Date) -> Date {
        let cal = Calendar.current
        var comps = cal.dateComponents([.year, .month, .day, .hour, .minute], from: d)
        let m = comps.minute ?? 0
        comps.minute = m < 30 ? 30 : 0
        if m >= 30 { comps.hour = (comps.hour ?? 0) + 1 }
        comps.second = 0
        return cal.date(from: comps) ?? d
    }
}
