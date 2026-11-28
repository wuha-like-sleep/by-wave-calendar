// EventEditView.swift
// One form that handles both "create" and "edit". The .mode enum decides
// which API call to fire on Save. Designed as a sheet — caller wraps in
// a NavigationStack so Save / Cancel can live in the toolbar.

import SwiftUI
#if canImport(FoundationModels)
import FoundationModels
#endif

#if canImport(FoundationModels)
// 快速新建的 Apple 智能通道 (iOS 26+)。Guided generation 强制模型输出
// 这个结构,免去手写 JSON 解析。@Guide 文案是给模型看的,不本地化。
@available(iOS 26.0, *)
@Generable
struct AIQuickEvent {
    @Guide(description: "事件标题,去掉时间词只留事件本体,保留输入的语言")
    var summary: String
    @Guide(description: "开始时间,本地时间,格式 yyyy-MM-dd'T'HH:mm:ss,不带时区")
    var startsAt: String
    @Guide(description: "结束时间,同格式;输入未提及时长时取开始时间加一小时")
    var endsAt: String
    @Guide(description: "地点,只在用户明确说出地点时才填(如「在星巴克开会」「meeting at the office」),没提地点留空字符串,不要编造")
    var location: String
    @Guide(description: "是否全天:用户明确说全天/整天/all day 时为 true,否则 false")
    var allDay: Bool
    @Guide(description: "重复规则,仅当用户明确说重复时才填,只用这个格式:FREQ=DAILY 或 FREQ=WEEKLY 或 FREQ=MONTHLY 或 FREQ=YEARLY,可再跟 ;INTERVAL=数字 或 ;BYDAY=星期代码(如每周五是 FREQ=WEEKLY;BYDAY=FR,每两周是 FREQ=WEEKLY;INTERVAL=2,每个工作日是 FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR);没提重复留空字符串")
    var rrule: String
}
#endif

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
    @State private var civilTimeZone: TimeZone

    @EnvironmentObject var state: AppState
    @Environment(\.timeZone) private var displayTimeZone

    @State private var summary: String
    @State private var location: String
    // 地点联想：本地地址簿命中（输入时同步算）与在线兜底结果（防抖
    // 查回）分开存，界面上要分组区分。
    @State private var localSuggestions: [String] = []
    @State private var onlineSuggestions: [GeoSuggestion] = []
    @FocusState private var locationFocused: Bool
    @State private var suggestTask: Task<Void, Never>?
    // 最近一次选中的建议：保存时与最终地点做编辑学习。
    @State private var pickedLocation: String? = nil
    @State private var description: String
    @State private var startsAt: Date
    @State private var endsAt: Date
    @State private var allDay: Bool
    @State private var calendarId: String
    // Each picker presents the same absolute Date in its endpoint's zone.
    // The start zone also remains the existing recurrence anchor metadata.
    @State private var timezone: String = TimeZone.current.identifier
    @State private var endTimezone: String = TimeZone.current.identifier
    @State private var endpointZonesEdited = false
    @State private var endZoneLinkedToStart = true
    private struct TimedSelection {
        let start: Date
        let end: Date
        let civilStart: Date
        let civilEnd: Date
        let endLinked: Bool
    }
    @State private var timedSelectionBeforeAllDay: TimedSelection?
    // v1.3.3 — Meeting/document URL, stored at extra.url server-side.
    @State private var url: String = ""
    // Optional meeting passcode, stored at extra.meetingPassword server-side.
    @State private var meetingPassword: String = ""
    // Event-level reminder (extra.alarms). Holds ONE trigger value
    // from ReminderOptions for the current allDay group; "" = none.
    // Imported alarms whose trigger isn't in the group aren't the
    // picker's business — buildExtra() re-attaches them untouched.
    @State private var reminder: String = ""
    // The reminder value the editor was seeded with. When the event's
    // extra never loaded (search results omit it), an UNCHANGED
    // picker must leave alarms alone entirely — see alarmsField().
    @State private var initialReminder: String = ""
    // Overlap prompt state for the pre-save conflict check. When the
    // user confirms「仍要保存」, conflictCheckPassed lets the retried
    // save() skip straight to the write.
    @State private var conflictPrompt: ConflictPrompt?
    @State private var conflictCheckPassed = false
    // Category (extra.category) — one of EventCategory's values or ""
    // for「无」. A stored value outside that set (older imports) is
    // kept selectable through categoryOptions so it survives the edit.
    @State private var category: String = ""
    // Recurrence editor state (parse/build in Models.swift). Seeded
    // from the master's rrule for edit, empty for create; duplicate
    // starts empty on purpose (see init).
    @State private var rruleState = RruleState()
    // Deleted single occurrences still excluded from the series.
    // The user can restore them here (series scope only).
    @State private var exdates: [String] = []
    // Unsaved-changes guard: Cancel asks before discarding when the
    // form differs from the seed snapshot, and swipe-to-dismiss is
    // disabled while dirty so a stray drag can't lose an edit.
    @State private var showDiscardConfirm = false
    @State private var snapshot: FormSnapshot

    /// The form's seed values, captured for this presentation. `isDirty` compares
    /// the live fields against this — including the quick-add parser's
    /// writes, which go through the same @State fields.
    private struct FormSnapshot: Equatable {
        var summary: String
        var location: String
        var description: String
        var startsAt: Date
        var endsAt: Date
        var allDay: Bool
        var calendarId: String
        var timezone: String
        var endTimezone: String
        var url: String
        var meetingPassword: String
        var category: String
        var reminder: String
        var rruleBuilt: String?
        var exdates: [String]
    }

    private var currentSnapshot: FormSnapshot {
        FormSnapshot(
            summary: summary, location: location, description: description,
            startsAt: startsAt, endsAt: endsAt, allDay: allDay,
            calendarId: calendarId, timezone: timezone, endTimezone: endTimezone,
            url: url, meetingPassword: meetingPassword,
            category: category, reminder: reminder,
            rruleBuilt: rruleState.build(), exdates: exdates,
        )
    }

    private var isDirty: Bool {
        currentSnapshot != snapshot || (!allDay && endpointZonesEdited && endZoneLinkedToStart && mode.existing?.extra?.endTimezone != nil)
    }

    /// The recurrence editor only runs where the whole series is the
    /// subject: creating, or editing with no scope / series scope.
    /// For「仅此事件」/「此次及之后」the rule belongs to the master the
    /// user isn't editing, so the section is hidden rather than
    /// letting a rule edit ride along on a scoped PATCH.
    private var rruleEditable: Bool {
        mode.isCreate || scope == nil || scope == .series
    }

    /// Restoring a deleted occurrence rewrites the master's list —
    /// same series-only boundary as the recurrence editor.
    private var exdatesEditable: Bool {
        mode.existing != nil && (scope == nil || scope == .series)
    }

    /// Category options: the web set, plus the stored value itself
    /// when it isn't in the set (so an imported custom category is
    /// shown selected instead of being silently cleared on save).
    private var categoryOptions: [CategoryOption] {
        if category.isEmpty || EventCategory.values.contains(where: { $0.value == category }) {
            return EventCategory.values
        }
        return EventCategory.values + [CategoryOption(value: category, labelKey: category)]
    }
    // attendees are no longer collected here — see AttendeesPage which
    // appears as a NavigationLink ONLY for already-saved events. Matches
    // the web flow ("保存事件后会出现「管理参与者」入口").
    @State private var saving = false
    @State private var errorMessage: String?

    // 购买清单 section state. `eventShoppingLists` = the lists linked
    // to THIS event (fetched with ?eventId=); `allShoppingLists` feeds
    // the link picker. Both stay empty for a not-yet-saved event,
    // whose section only shows the save-first hint.
    @State private var eventShoppingLists: [ShoppingListDTO] = []
    @State private var allShoppingLists: [ShoppingListDTO] = []
    @State private var shoppingError: String?
    @State private var newEventListTitle = ""
    @State private var showShoppingLinkPicker = false
    @State private var shoppingBusy = false

    // Stable idempotency key for create/duplicate. Generated ONCE here, at
    // editor-construction time (see init), and reused on every save attempt
    // so a retry after a timeout collapses onto the first server row instead
    // of duplicating. nil for edit mode — updates are already idempotent by
    // event id, and the server uses clientUid only on insert.
    @State private var clientUid: String?

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
        let deviceZone = TimeZone.current
        _civilTimeZone = State(initialValue: deviceZone)
        var pickerCalendar = Calendar(identifier: .gregorian)
        pickerCalendar.timeZone = deviceZone
        if let e = mode.seed {
            // For "duplicate" we want today's slot, not the source's
            // possibly-historical start. Edit keeps the original time.
            let useOriginalTime = mode.existing != nil
            let seedStart: Date
            let seedEnd: Date
            if useOriginalTime {
                if e.allDay {
                    let dates = EventEditorDates.allDayEditorRange(start: e.startsAt, end: e.endsAt, calendar: pickerCalendar)
                    seedStart = dates.start
                    seedEnd = dates.end
                } else {
                    seedStart = e.startsAt
                    seedEnd = e.endsAt
                }
            } else {
                (seedStart, seedEnd) = EventEditorDates.duplicate(
                    start: e.startsAt, end: e.endsAt, allDay: e.allDay,
                    from: Self.roundUpToHalfHour(Date()), calendar: pickerCalendar)
            }
            _summary = State(initialValue: e.summary)
            _location = State(initialValue: e.location ?? "")
            _description = State(initialValue: e.description ?? "")
            _startsAt = State(initialValue: seedStart)
            _endsAt = State(initialValue: seedEnd)
            _allDay = State(initialValue: e.allDay)
            _calendarId = State(initialValue: e.calendarId)
            let zones = EventEditorDates.endpointTimeZones(
                start: e.extra?.timezone, end: e.extra?.endTimezone,
                calendar: calendars.first(where: { $0.id == e.calendarId })?.timezone,
                device: .current
            )
            let seedTimezone = zones.start.identifier
            let seedEndTimezone = zones.end.identifier
            _timezone = State(initialValue: seedTimezone)
            _endTimezone = State(initialValue: seedEndTimezone)
            _endZoneLinkedToStart = State(initialValue: zones.end.identifier == zones.start.identifier)
            // Preload URL from extra. Existing events created on the web
            // (where the link field has been live for a while) will have
            // this populated; new iOS-created events start empty.
            let seedURL = e.extra?.url ?? ""
            if !seedURL.isEmpty {
                _url = State(initialValue: seedURL)
            }
            // Preload meeting passcode from extra, same as URL above.
            let seedPassword = e.extra?.meetingPassword ?? ""
            if !seedPassword.isEmpty {
                _meetingPassword = State(initialValue: seedPassword)
            }
            // Preload the picker with the event's primary reminder:
            // the first stored alarm whose trigger is one of this
            // event's group values (timed vs all-day). Alarms outside
            // the group (custom imports) stay invisible here and are
            // preserved verbatim by alarmsField() on save.
            let group = ReminderOptions.values(allDay: e.allDay)
            let primary = (e.extra?.alarms ?? [])
                .map { $0.trigger.trimmingCharacters(in: .whitespaces) }
                .first { group.contains($0) } ?? ""
            _reminder = State(initialValue: primary)
            _initialReminder = State(initialValue: primary)
            // Category preload (extra.category). A value outside the
            // web's set (older imports) stays selected via the extra
            // option categoryOptions adds for it, so it isn't lost.
            let seedCategory = e.extra?.category ?? ""
            _category = State(initialValue: seedCategory)
            // Recurrence + deleted occurrences. Edit seeds both from
            // the master row. Duplicate deliberately starts clean —
            // the long-standing behavior (a copy is a fresh event,
            // not a parallel series) — with the editor now visible,
            // the user can re-add a rule explicitly if they want one.
            let seedRrule: RruleState
            let seedExdates: [String]
            if useOriginalTime {
                seedRrule = RruleState.parse(e.rrule, seedStart: e.startsAt)
                seedExdates = e.exdates ?? []
            } else {
                seedRrule = RruleState.parse(nil, seedStart: seedStart)
                seedExdates = []
            }
            _rruleState = State(initialValue: seedRrule)
            _exdates = State(initialValue: seedExdates)
            snapshot = FormSnapshot(
                summary: e.summary, location: e.location ?? "",
                description: e.description ?? "",
                startsAt: seedStart, endsAt: seedEnd, allDay: e.allDay,
                calendarId: e.calendarId, timezone: seedTimezone, endTimezone: seedEndTimezone,
                url: seedURL, meetingPassword: seedPassword,
                category: seedCategory, reminder: primary,
                rruleBuilt: seedRrule.build(), exdates: seedExdates,
            )
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
            // Default to the calendar the user last saved an event
            // into (the web editor remembers the same way); before
            // this, every create silently reset to the server's first
            // calendar. Falls back to the first calendar when the
            // remembered one is gone (deleted / other account).
            let lastUsed = UserDefaults.standard.string(forKey: "lastUsedCalendarId")
            let initialCalendarId =
                calendars.first(where: { $0.id == lastUsed })?.id
                    ?? calendars.first?.id ?? ""
            _calendarId = State(initialValue: initialCalendarId)
            let zones = EventEditorDates.endpointTimeZones(
                start: nil, end: nil,
                calendar: calendars.first(where: { $0.id == initialCalendarId })?.timezone,
                device: .current
            )
            _timezone = State(initialValue: zones.start.identifier)
            _endTimezone = State(initialValue: zones.end.identifier)
            let freshRrule = RruleState.parse(nil, seedStart: start)
            _rruleState = State(initialValue: freshRrule)
            snapshot = FormSnapshot(
                summary: "", location: "", description: "",
                startsAt: start, endsAt: start.addingTimeInterval(3600),
                allDay: false, calendarId: initialCalendarId,
                timezone: zones.start.identifier, endTimezone: zones.end.identifier,
                url: "", meetingPassword: "", category: "", reminder: "",
                rruleBuilt: freshRrule.build(), exdates: [],
            )
        }
        // Generate the idempotency key exactly once, here at construction
        // time — NOT inside save() — so that if the first POST times out and
        // the user taps 创建 again, the retry carries the SAME clientUid and
        // the server dedups it. Only create + duplicate POST a new event;
        // edit PATCHes by id and must not send a clientUid.
        if mode.isCreate {
            _clientUid = State(initialValue: UUID().uuidString + "@bywave")
        } else {
            _clientUid = State(initialValue: nil)
        }
    }

    // 自然语言快速填写 (v1.6.2, 对齐 web/Android/桌面 — 同一个服务器端点,
    // 三端解析行为一致)。仅新建/复制模式;编辑已有事件时隐藏。
    @State private var quickText = ""
    @State private var quickParsing = false
    @State private var quickError: String?
    /// 解析成功回填过一次、且解析出了标题：快速新建区多一个「直接保存」。
    /// 改动一句话原文即清掉（与桌面端同一口径）。
    @State private var quickFilled = false
    /// 这次 save() 是不是由「直接保存」发起的：成功后给 AppState 记一笔，
    /// 日历页弹「已创建 · 打开 / 撤销」条。冲突框里选「仍要保存」会再走
    /// 一次 save()，标记保留；保存失败则清掉，别串到下一次普通保存。
    @State private var saveViaQuick = false
    var body: some View {
        Form {
            if mode.isCreate {
                Section {
                    HStack(spacing: 8) {
                        TextField("试试：明天下午3点和老王开会", text: $quickText)
                            .autocorrectionDisabled(true)
                            .onChange(of: quickText) { _, _ in quickFilled = false }
                            .onSubmit { Task { await parseQuick() } }
                        Button {
                            Task { await parseQuick() }
                        } label: {
                            if quickParsing {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("填入").font(.callout.weight(.medium))
                            }
                        }
                        .buttonStyle(.borderless)
                        .disabled(quickParsing || quickText.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    if let quickError {
                        Text(quickError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    // 直接保存：解析完整后出现，走的就是 save() 本身
                    // （冲突软检查在内），成功后日历页弹「已创建」条。
                    if quickFilled && !summary.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button {
                            saveViaQuick = true
                            Task { await save() }
                        } label: {
                            HStack {
                                Spacer()
                                Text("直接保存").font(.callout.weight(.medium))
                            }
                        }
                        .buttonStyle(.borderless)
                        .disabled(saving)
                    }
                } header: {
                    Text("快速新建")
                }
            }

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
                    .onChange(of: calendarId) { _, value in
                        guard mode.seed == nil, !endpointZonesEdited else { return }
                        let zones = EventEditorDates.endpointTimeZones(
                            start: nil, end: nil,
                            calendar: calendars.first(where: { $0.id == value })?.timezone,
                            device: displayTimeZone
                        )
                        timezone = zones.start.identifier
                        endTimezone = zones.end.identifier
                    }
                }
            }

            Section("时间") {
                Toggle("全天", isOn: allDayBinding)
                if allDay {
                    DatePicker("开始", selection: $startsAt, displayedComponents: .date)
                        .environment(\.timeZone, civilTimeZone)
                    DatePicker("结束", selection: $endsAt, displayedComponents: .date)
                        .environment(\.timeZone, civilTimeZone)
                } else {
                    DatePicker("开始", selection: startTimeBinding, displayedComponents: [.date, .hourAndMinute])
                        .environment(\.timeZone, startZone)
                        .accessibilityIdentifier("event.startsAt")
                    endpointZoneLink("event.timezone.start", selection: startZoneBinding, date: startsAt)
                    repeatedTimePicker(for: startsAt, zone: startZone, selection: startTimeBinding)
                    DatePicker("结束", selection: endTimeBinding, displayedComponents: [.date, .hourAndMinute])
                        .environment(\.timeZone, endZone)
                        .accessibilityIdentifier("event.endsAt")
                    endpointZoneLink("event.timezone.end", selection: endZoneBinding, date: endsAt)
                    repeatedTimePicker(for: endsAt, zone: endZone, selection: endTimeBinding)
                    Text("event.timezone.keepsInstant".loc)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if chronological {
                        LabeledContent("event.timezone.elapsed".loc, value: elapsedTime)
                    }
                    // 时长快捷片：点一下把结束设成开始 + 片上时长。
                    // 设完即解除「结束跟随开始」的联动（用户已显式定过
                    // 结束时间，再拖开始不该把它冲掉）。
                    HStack(spacing: 8) {
                        Text("时长")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        ForEach([30, 60, 120], id: \.self) { minutes in
                            Button(durationChipLabel(minutes)) {
                                endsAt = startsAt.addingTimeInterval(TimeInterval(minutes * 60))
                                endLinkedToStart = false
                                conflictCheckPassed = false
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }

                }
                if !dateOrderIsValid {
                    Text(dateOrderError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }

            // 复制带重复规则的事件时把话说在前面：复制按设计不带重复
            // 规则（避免误开一条平行系列），但以前是静默丢掉，用户存
            // 完才发现新事件只出现一次。
            if case .duplicateOf(let source) = mode, let rule = source.rrule, !rule.isEmpty {
                Section {
                    Label("重复规则未复制，已按单次事件复制；如需重复请在下方重新设置。", systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            // Recurrence editor — same shape as the desktop
            // RruleEditor (freq / interval / end) plus the BYDAY
            // shapes the server expander supports. Hidden for
            // instance/future scoped edits (see rruleEditable).
            if rruleEditable {
                recurrenceSection
            }

            // Deleted occurrences of this series, restorable one by
            // one. Only meaningful on the master (series scope).
            if exdatesEditable && !exdates.isEmpty {
                Section {
                    ForEach(exdates, id: \.self) { iso in
                        HStack {
                            Text(exdateLabel(iso))
                                .font(.callout)
                            Spacer()
                            Button("恢复") {
                                exdates.removeAll { $0 == iso }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                } header: {
                    Text("已删除的单次")
                } footer: {
                    Text("恢复后，这一次会重新出现在日历里。")
                }
            }

            // Reminder picker — values are the server's trigger
            // strings verbatim (see ReminderOptions); the option set
            // follows the 全天 toggle, and a selection that doesn't
            // exist in the new group falls back to「不提醒」.
            Section {
                Picker("提醒", selection: $reminder) {
                    ForEach(ReminderOptions.options(allDay: allDay)) { opt in
                        Text(opt.labelKey.loc).tag(opt.value)
                    }
                }
                .pickerStyle(.menu)
                .onChange(of: allDay) { _, newValue in
                    if !ReminderOptions.values(allDay: newValue).contains(reminder) {
                        reminder = ""
                    }
                }
            } header: {
                Text("提醒")
            }

            // Category — the web editor's set, stored at
            // extra.category. Picking「无」clears the key on save
            // (buildExtra's field() sends an explicit null).
            Section {
                Picker("app.event.category".loc, selection: $category) {
                    ForEach(categoryOptions) { opt in
                        Text(opt.labelKey.loc).tag(opt.value)
                    }
                }
                .pickerStyle(.menu)
            } header: {
                Text("app.event.category".loc)
            }

            Section("地点") {
                TextField("可选 — 例如 上海 / Zoom 会议室", text: $location)
                    .focused($locationFocused)
                    .onChange(of: location) { _, _ in refreshSuggestions() }
                    .onChange(of: locationFocused) { _, focused in
                        if focused {
                            refreshSuggestions()
                        } else {
                            localSuggestions = []
                            onlineSuggestions = []
                        }
                    }
                // 联想下拉（表单流内展开）：本地在上，在线兜底带标题
                // 分组在下；点行回填，在线结果同时写回本地地址簿。
                ForEach(localSuggestions, id: \.self) { suggestion in
                    Button {
                        location = suggestion
                        pickedLocation = suggestion
                    } label: {
                        Text(suggestion).lineLimit(1).foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                }
                if !onlineSuggestions.isEmpty {
                    Text("在线建议")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(onlineSuggestions, id: \.label) { suggestion in
                        Button {
                            location = suggestion.label
                            AddressBookStore.learnOnline(suggestion)
                            pickedLocation = suggestion.label
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(suggestion.label).lineLimit(1).foregroundStyle(.primary)
                                // 折叠行：label 是不带单元前缀的基础地址，
                                // 全部单元号挂在副行里；想选具体单元，把
                                // 单元号打进查询即可命中带 unit 的那一行。
                                // unit 已点名时 label 自带前缀，不重复展示。
                                if suggestion.unit == nil, let units = suggestion.units, !units.isEmpty {
                                    Text("单元：%@".locFormat(units.joined(separator: ", ")))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    // ODbL 署名：在线结果是 OpenStreetMap 数据，展示
                    // 处须带版权声明。版权行是固定文案，不做本地化。
                    Text("© OpenStreetMap contributors")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            // 购买清单 — same "after the event is saved" split as the
            // attendees section below: a new event shows the save-first
            // hint; a saved event lists its linked shopping lists with
            // progress + unlink, can link an existing list, or create
            // one pre-linked to this event.
            Section {
                if let existing = mode.existing {
                    if eventShoppingLists.isEmpty {
                        Text("还没有关联的购买清单。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(eventShoppingLists) { list in
                        NavigationLink {
                            ShoppingListDetailView(listId: list.id)
                                .environmentObject(state)
                        } label: {
                            HStack {
                                Text(list.title).lineLimit(1)
                                Spacer()
                                if list.totalCount > 0 {
                                    Text("已买 %1$lld/%2$lld".locFormat(list.doneCount, list.totalCount))
                                        .font(.callout).foregroundStyle(.secondary)
                                }
                            }
                        }
                        Button("解除关联") {
                            Task { await unlinkShoppingList(list) }
                        }
                        .buttonStyle(.borderless)
                        .disabled(shoppingBusy)
                    }
                    Button("关联") {
                        showShoppingLinkPicker = true
                    }
                    .disabled(shoppingBusy)
                    TextField("例如：周末烧烤采购", text: $newEventListTitle)
                    Button {
                        Task { await createShoppingListForEvent(existing) }
                    } label: {
                        HStack {
                            if shoppingBusy { ProgressView().controlSize(.small) }
                            Text("为这个事件新建清单")
                        }
                    }
                    .disabled(shoppingBusy)
                    if let shoppingError {
                        Text(shoppingError).foregroundStyle(.red).font(.callout)
                    }
                } else {
                    Text("先保存事件，之后就能给它关联购买清单。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } header: {
                Text("购买清单")
            }

            // 邀请人 — matches the web flow: invites are managed on a
            // dedicated page AFTER the event is saved. New events show
            // a hint; editing events show a NavigationLink → AttendeesPage
            // which calls the JSON endpoints (POST/DELETE one at a time
            // with .ics email per invite).
            Section {
                if let existing = mode.existing {
                    NavigationLink {
                        AttendeesPage(eventId: existing.id, eventTitle: existing.summary)
                            .environmentObject(state)
                    } label: {
                        HStack {
                            Label("管理参与者", systemImage: "person.2.fill")
                                .foregroundStyle(.primary)
                            Spacer()
                            let count = existing.extra?.attendees?.count ?? 0
                            if count > 0 {
                                Text("%lld 人".locFormat(count))
                                    .font(.callout).foregroundStyle(.secondary)
                            } else {
                                Text("尚未邀请").font(.callout).foregroundStyle(.tertiary)
                            }
                        }
                    }
                } else {
                    Text("保存后可邀请")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } header: {
                Text("邀请人")
            }

            Section("备注") {
                TextField("可选", text: $description, axis: .vertical)
                    .lineLimit(3...8)
            }

            // v1.3.3 — separate URL field, matches the web event-editor's
            // 「链接」row. Stored at extra.url JSON-side. Surfaced in
            // EventDetailView as a tappable link.
            Section {
                TextField("https://… (会议链接 / 文档地址等)", text: $url)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
            } header: {
                Text("链接")
            }

            // Optional meeting passcode, stored at extra.meetingPassword.
            // Mirrors the 「链接」row above; surfaced in EventDetailView.
            Section {
                TextField("可选 — 例如 Zoom 入会密码", text: $meetingPassword)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
            } header: {
                Text("入会密码")
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                }
            }
        }
        // 紧凑密度：表单行最小高度从系统默认收到 36——内容高的行
        // （日期选择器等）不受影响，只是单行字段不再那么松散。
        .environment(\.defaultMinListRowHeight, 36)
        // 地址簿首次播种：拉一次宽窗口的事件，只取 location。
        // 失败静默——没播上种照样能靠保存慢慢攒。
        .task {
            if !AddressBookStore.isSeeded() {
                await seedAddressBook()
            }
        }
        // 购买清单 section 数据：已保存事件才拉（关联清单 + 全部清单
        // 供关联选择器）。失败只落在 section 内的错误行，不挡编辑。
        .task {
            await loadShoppingLists()
        }
        .sheet(isPresented: $showShoppingLinkPicker) {
            NavigationStack {
                List {
                    if allShoppingLists.isEmpty {
                        Text("还没有购买清单——在下方建一张吧。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(allShoppingLists.filter { $0.eventId != mode.existing?.id }) { list in
                        Button {
                            showShoppingLinkPicker = false
                            Task { await linkShoppingList(list) }
                        } label: {
                            HStack {
                                Text(list.title)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Spacer()
                                if list.totalCount > 0 {
                                    Text("已买 %1$lld/%2$lld".locFormat(list.doneCount, list.totalCount))
                                        .font(.callout).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .navigationTitle("购买清单")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { showShoppingLinkPicker = false }
                    }
                }
            }
            .environmentObject(state)
        }
        .navigationTitle({
            switch mode {
            case .create:        return "新建事件".loc
            case .duplicateOf:   return "复制为新事件".loc
            case .edit:          return "编辑事件".loc
            }
        }())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { attemptCancel() }
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
                .disabled(saving || summary.trimmingCharacters(in: .whitespaces).isEmpty || calendarId.isEmpty || !dateOrderIsValid)
            }
        }
        .alert("app.js.conflict.title".loc, isPresented: Binding(
            get: { conflictPrompt != nil },
            set: { if !$0 { conflictPrompt = nil } },
        )) {
            Button("取消", role: .cancel) {
                conflictPrompt = nil
                // Stayed on the editor; the next save re-checks (the
                // user may have changed the time because of this).
                conflictCheckPassed = false
            }
            Button("app.js.conflict.saveAnyway".loc) {
                conflictPrompt = nil
                conflictCheckPassed = true
                Task { await save() }
            }
        } message: {
            Text(conflictPrompt?.message ?? "")
        }
        // Unsaved-changes guard (2/2): swipe-to-dismiss is disabled
        // while dirty — the sheet can then only leave through Cancel
        // (which asks, above) or a successful save.
        .interactiveDismissDisabled(isDirty)
        .alert("放弃修改？", isPresented: $showDiscardConfirm) {
            Button("继续编辑", role: .cancel) {}
            Button("放弃修改", role: .destructive) { onCancel() }
        } message: {
            Text("未保存的修改将丢失。")
        }
    }

    /// Unsaved-changes guard (1/2): Cancel with a dirty form asks
    /// first; a clean form (or right after seeding) closes at once.
    private func attemptCancel() {
        if isDirty {
            showDiscardConfirm = true
        } else {
            onCancel()
        }
    }

    // MARK: - Recurrence editor

    /// Freq / interval / end + BYDAY controls. An unmodelable rule
    /// (passthrough) renders as its raw string plus a note and an
    /// explicit clear button — it is never rebuilt behind the
    /// user's back.
    @ViewBuilder
    private var recurrenceSection: some View {
        Section {
            if let raw = rruleState.passthrough {
                Text(raw)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Text("这个重复规则较复杂，APP 里暂不支持编辑，将原样保留。")
                    .font(.callout).foregroundStyle(.secondary)
                Button("清除重复规则", role: .destructive) {
                    rruleState.passthrough = nil
                    rruleState.freq = .none
                }
            } else {
                Picker("重复", selection: Binding(
                    get: { rruleState.freq },
                    set: { rruleState.freq = $0 },
                )) {
                    ForEach(RruleFreq.allCases, id: \.self) { f in
                        Text(f.labelKey.loc).tag(f)
                    }
                }
                .pickerStyle(.menu)
                if rruleState.freq != .none {
                    Stepper(value: $rruleState.interval, in: 1...99) {
                        Text("间隔：%lld".locFormat(rruleState.interval))
                    }
                    if rruleState.freq == .weekly {
                        weekdayChips
                    }
                    if rruleState.freq == .monthly {
                        Picker("每月方式", selection: $rruleState.monthlyMode) {
                            ForEach(RruleMonthlyMode.allCases, id: \.self) { m in
                                Text(m.labelKey.loc).tag(m)
                            }
                        }
                        .pickerStyle(.menu)
                        if rruleState.monthlyMode == .byWeekday {
                            Picker("第几个", selection: $rruleState.monthlyOrdinal) {
                                Text("第一个").tag(1)
                                Text("第二个").tag(2)
                                Text("第三个").tag(3)
                                Text("第四个").tag(4)
                                Text("最后一个").tag(-1)
                            }
                            .pickerStyle(.menu)
                            Picker("星期", selection: $rruleState.monthlyWeekday) {
                                ForEach(1...7, id: \.self) { wd in
                                    Text(Self.weekdayName(wd)).tag(wd)
                                }
                            }
                            .pickerStyle(.menu)
                        }
                    }
                    Picker("结束", selection: $rruleState.end) {
                        ForEach(RruleEndKind.allCases, id: \.self) { e in
                            Text(e.labelKey.loc).tag(e)
                        }
                    }
                    .pickerStyle(.menu)
                    switch rruleState.end {
                    case .forever:
                        EmptyView()
                    case .until:
                        DatePicker("结束日期", selection: $rruleState.until, displayedComponents: .date)
                    case .count:
                        Stepper(value: $rruleState.count, in: 1...999) {
                            Text("共 %lld 次".locFormat(rruleState.count))
                        }
                    }
                }
            }
        } header: {
            Text("重复")
        }
    }

    /// WEEKLY weekday multi-select: one chip per weekday, Monday
    /// first (matching BYDAY emission order). Symbols come from the
    /// system calendar so they follow the UI language for free.
    private var weekdayChips: some View {
        HStack(spacing: 6) {
            ForEach([2, 3, 4, 5, 6, 7, 1], id: \.self) { wd in
                let selected = rruleState.byday.contains(wd)
                Button {
                    if selected { rruleState.byday.remove(wd) } else { rruleState.byday.insert(wd) }
                } label: {
                    Text(Self.weekdayName(wd, short: true))
                        .font(.callout.weight(selected ? .semibold : .regular))
                        .frame(width: 34, height: 34)
                        .background(
                            selected ? Color.accentColor : Color.secondary.opacity(0.12),
                            in: Circle(),
                        )
                        .foregroundStyle(selected ? Color.white : Color.primary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
    }

    /// Weekday display name from the system calendar (1 = Sunday …
    /// 7 = Saturday, matching Calendar's weekday numbers).
    private static func weekdayName(_ wd: Int, short: Bool = false) -> String {
        let cal = Calendar.current
        let symbols = short ? cal.veryShortWeekdaySymbols : cal.weekdaySymbols
        guard (1...7).contains(wd), symbols.count == 7 else { return "" }
        return symbols[wd - 1]
    }

    /// One exdate row's label: the stored ISO string as a readable
    /// date (time shown for timed events, hidden for all-day ones).
    /// 时长快捷片的文案。用无空格的键：带空格的「30 分钟」等键与提醒
    /// 档位共用，日/韩译文带「前/전」后缀（提醒语境），拿来当时长是错的。
    private func durationChipLabel(_ minutes: Int) -> String {
        switch minutes {
        case 30: return "30分钟".loc
        case 60: return "1小时".loc
        default: return "2小时".loc
        }
    }

    private func exdateLabel(_ iso: String) -> String {
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let d = withFrac.date(from: iso) ?? plain.date(from: iso) else { return iso }
        return d.formatted(date: .abbreviated, time: allDay ? .omitted : .shortened)
    }

    /// What the conflict alert lists: at most 3 titles, the rest
    /// folded into a「还有 N 条」line — same shape as the web prompt.
    private struct ConflictPrompt {
        let conflicts: [ConflictDTO]

        var message: String {
            var lines = ["app.js.conflict.message".loc]
            lines += conflicts.prefix(3).map { "• \($0.summary)" }
            if conflicts.count > 3 {
                lines.append("app.js.conflict.more".locFormat(conflicts.count - 3))
            }
            return lines.joined(separator: "\n")
        }
    }

    private var startZone: TimeZone { TimeZone(identifier: timezone) ?? displayTimeZone }
    private var endZone: TimeZone { TimeZone(identifier: endTimezone) ?? startZone }
    private var chronological: Bool { EventEditorDates.isChronological(start: startsAt, end: endsAt) }

    private var civilCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = civilTimeZone
        return calendar
    }

    private var dateOrderIsValid: Bool {
        allDay ? EventEditorDates.isChronological(start: civilCalendar.startOfDay(for: startsAt), end: civilCalendar.startOfDay(for: endsAt)) : chronological
    }

    private var dateOrderError: String {
        (allDay ? "event.timezone.invalidDates" : "event.timezone.invalidOrder").loc
    }

    private var allDayBinding: Binding<Bool> {
        Binding(get: { allDay }, set: { value in
            guard value != allDay else { return }
            if value {
                guard let dates = EventEditorDates.allDayFromTimed(start: startsAt, end: endsAt,
                    startZone: startZone, endZone: endZone, pickerCalendar: civilCalendar) else {
                    errorMessage = "event.timezone.invalidLocalDate".loc
                    return
                }
                timedSelectionBeforeAllDay = TimedSelection(start: startsAt, end: endsAt,
                    civilStart: dates.start, civilEnd: dates.end, endLinked: endLinkedToStart)
                startsAt = dates.start
                endsAt = dates.end
            } else {
                if let saved = timedSelectionBeforeAllDay,
                   civilCalendar.isDate(startsAt, inSameDayAs: saved.civilStart),
                   civilCalendar.isDate(endsAt, inSameDayAs: saved.civilEnd) {
                    startsAt = saved.start
                    endsAt = saved.end
                    endLinkedToStart = saved.endLinked
                } else {
                    guard let dates = EventEditorDates.timedFromAllDay(start: startsAt, end: endsAt,
                        pickerCalendar: civilCalendar, startZone: startZone, endZone: endZone) else {
                        errorMessage = "event.timezone.invalidLocalDate".loc
                        return
                    }
                    startsAt = dates.start
                    endsAt = dates.end
                    endLinkedToStart = false
                }
                timedSelectionBeforeAllDay = nil
            }
            allDay = value
            conflictCheckPassed = false
        })
    }

    private var startZoneBinding: Binding<String> {
        Binding(get: { timezone }, set: { value in
            timezone = value
            if endZoneLinkedToStart || endTimezone == value {
                endTimezone = value
                endZoneLinkedToStart = true
            }
            endpointZonesEdited = true
        })
    }

    private var endZoneBinding: Binding<String> {
        Binding(get: { endTimezone }, set: { value in
            endTimezone = value
            endZoneLinkedToStart = value == timezone
            endpointZonesEdited = true
        })
    }

    // Binding setters distinguish a direct end edit from the automatic shift
    // after changing start. An onChange on endsAt cannot make that distinction.
    private var startTimeBinding: Binding<Date> {
        Binding(get: { startsAt }, set: { value in
            let delta = value.timeIntervalSince(startsAt)
            startsAt = value
            if endLinkedToStart { endsAt = endsAt.addingTimeInterval(delta) }
            conflictCheckPassed = false
        })
    }

    private var endTimeBinding: Binding<Date> {
        Binding(get: { endsAt }, set: { value in
            endsAt = value
            endLinkedToStart = false
            conflictCheckPassed = false
        })
    }

    private var elapsedTime: String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute]
        formatter.unitsStyle = .abbreviated
        formatter.zeroFormattingBehavior = .dropAll
        return formatter.string(from: max(0, endsAt.timeIntervalSince(startsAt))) ?? "0"
    }

    private func endpointZoneLink(_ label: String, selection: Binding<String>, date: Date) -> some View {
        NavigationLink {
            EventEndpointZonePicker(title: label, selection: selection, date: date)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(label.loc)
                Text("\(DateFormatters.localFormatter("VVV", template: false, zone: TimeZone(identifier: selection.wrappedValue) ?? displayTimeZone).string(from: date)) · \(EventEndpointZonePicker.offsetLabel(TimeZone(identifier: selection.wrappedValue) ?? displayTimeZone, at: date))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityIdentifier(label)
    }

    @ViewBuilder private func repeatedTimePicker(for date: Date, zone: TimeZone, selection: Binding<Date>) -> some View {
        let alternatives = EventEditorDates.repeatedTimeAlternatives(for: date, in: zone)
        if alternatives.count > 1 {
            Picker("event.timezone.repeatedTime".loc, selection: selection) {
                ForEach(alternatives, id: \.self) { candidate in
                    Text(EventEndpointZonePicker.offsetLabel(zone, at: candidate)).tag(candidate)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    /// One parsed quick-add phrase, normalized across both parse paths
    /// (on-device model / server parser) so the fill logic is shared.
    /// Mirrors the web parser's ParsedEvent: location and rrule are
    /// only non-nil when the phrase actually carries them.
    private struct QuickFill {
        var summary: String
        var start: Date
        var end: Date
        var location: String?
        var rrule: String?
        var allDay: Bool
    }

    /// Quick-add parse. Tries the on-device Apple Intelligence model first
    /// (iOS 26+, eligible device — handles any language, nothing leaves the
    /// phone), then falls back to the server-shared /parse-event endpoint
    /// so老设备/模型未就绪时行为与 web/Android/桌面一致。
    private func parseQuick() async {
        let text = quickText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !quickParsing else { return }
        quickParsing = true
        quickError = nil
        defer { quickParsing = false }

        if let fill = await parseQuickWithAppleAI(text: text) {
            applyParsed(fill)
            return
        }

        // Local wall-clock "now" — the server anchors 明天/下周三 to this,
        // NOT to its own clock (server may be in another timezone).
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = allDay ? civilTimeZone : startZone
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        do {
            let parsed = try await APIClient(state: state)
                .parseQuickEvent(text: text, now: f.string(from: Date()))
            let parsedZone = (parsed.allDay ?? false) ? civilTimeZone : startZone
            guard let s = QuickParsedEvent.localDate(parsed.startsAt, in: parsedZone),
                  let e = QuickParsedEvent.localDate(parsed.endsAt, in: parsedZone)
            else {
                quickError = "没看懂，换个说法试试".loc
                return
            }
            applyParsed(QuickFill(
                summary: parsed.summary,
                start: s,
                end: e,
                location: parsed.location,
                rrule: parsed.rrule,
                allDay: parsed.allDay ?? false,
            ))
        } catch let err as APIError {
            if case .server(let status, _) = err, status == 422 {
                quickError = "没看懂，换个说法试试".loc
            } else {
                quickError = err.localizedDescription
            }
        } catch {
            quickError = error.localizedDescription
        }
    }

    private func applyParsed(_ fill: QuickFill) {
        withAnimation {
            let trimmed = fill.summary.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { summary = trimmed }
            // Location: only a phrase that actually named a place
            // overwrites the field — a place-less re-parse must not
            // wipe a location the user typed by hand.
            if let loc = fill.location?.trimmingCharacters(in: .whitespaces), !loc.isEmpty {
                location = loc
            }
            timedSelectionBeforeAllDay = nil
            allDay = fill.allDay
            startsAt = fill.start
            endsAt = max(fill.end, fill.start.addingTimeInterval(60))
            // A fresh parse replaces the recurrence wholesale: a new
            // phrase without 每周 clears a previously parsed rule.
            // The parsed rule lands in the recurrence editor's state
            // (unmodelable rules as passthrough), so the user sees it
            // in the recurrence section and can adjust or remove it
            // before saving — no separate read-only carrier.
            rruleState = RruleState.parse(fill.rrule, seedStart: fill.start)
            // The user got an explicit end from the parser — break the
            // start→end linkage so tweaking start won't shift it again.
            endLinkedToStart = false
        }
        // 标题解析出来了才算完整：只有时间没标题不给直接保存。
        quickFilled = !fill.summary.trimmingCharacters(in: .whitespaces).isEmpty
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// On-device parse via the iOS 26 Foundation Models framework (Apple
    /// Intelligence). Returns nil whenever anything is off — old OS, model
    /// unavailable/not downloaded, hallucinated dates, past-dated result —
    /// so the caller silently falls back to the server parser.
    private func parseQuickWithAppleAI(text: String) async -> QuickFill? {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *) else { return nil }
        guard SystemLanguageModel.default.availability == .available else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = allDay ? civilTimeZone : startZone
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        let weekdayFmt = DateFormatter()
        weekdayFmt.locale = Locale(identifier: "zh_CN")
        weekdayFmt.timeZone = allDay ? civilTimeZone : startZone
        weekdayFmt.dateFormat = "EEEE"
        let now = Date()
        let instructions = """
        你是日历助手,把用户的一句自然语言变成一个日程事件。
        现在的本地时间是 \(f.string(from: now))(\(weekdayFmt.string(from: now)))。
        「明天」「下周三」等相对时间都以此为准,结果时间必须不早于现在。
        只提取用户说的内容,不要编造地点或参与者。
        """
        do {
            let session = LanguageModelSession(instructions: instructions)
            let r = try await session.respond(to: text, generating: AIQuickEvent.self)
            let parsedZone = r.content.allDay ? civilTimeZone : startZone
            guard let s = QuickParsedEvent.localDate(r.content.startsAt, in: parsedZone),
                  let e = QuickParsedEvent.localDate(r.content.endsAt, in: parsedZone),
                  !r.content.summary.trimmingCharacters(in: .whitespaces).isEmpty,
                  // Sanity: reject hallucinated past dates (>1 day behind now).
                  s > now.addingTimeInterval(-86_400)
            else { return nil }
            let aiLocation = r.content.location.trimmingCharacters(in: .whitespaces)
            return QuickFill(
                summary: r.content.summary,
                start: s,
                end: max(e, s.addingTimeInterval(60)),
                // The model's location/rrule are only trusted through
                // the same conservative gates as the shared parser:
                // location must be non-empty (the guide forbids
                // inventing one), and the RRULE must survive strict
                // validation — an invalid rule is dropped, not stored.
                location: aiLocation.isEmpty ? nil : aiLocation,
                rrule: QuickParsedEvent.validatedRrule(r.content.rrule),
                allDay: r.content.allDay,
            )
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }

    /// 地点联想刷新：本地同步算；本地不足 3 条、查询够长、开关开着
    /// 才防抖查在线兜底。输入变了就丢弃在途结果。
    // MARK: - 购买清单 section

    /// Fetch this event's linked lists plus the full set for the
    /// link picker. Only for saved events; failures land in the
    /// section's own error row and never block editing the event.
    private func loadShoppingLists() async {
        guard let existing = mode.existing else { return }
        do {
            let client = APIClient(state: state)
            eventShoppingLists = try await client.listShoppingLists(eventId: existing.id)
            allShoppingLists = try await client.listShoppingLists()
            shoppingError = nil
        } catch {
            if !Task.isCancelled { shoppingError = shoppingErrorText(error) }
        }
    }

    /// Link an existing list to this event (PATCH its eventId).
    private func linkShoppingList(_ list: ShoppingListDTO) async {
        guard let existing = mode.existing else { return }
        shoppingBusy = true
        shoppingError = nil
        defer { shoppingBusy = false }
        do {
            _ = try await APIClient(state: state).updateShoppingList(
                id: list.id, title: nil, eventId: .some(existing.id),
            )
            await loadShoppingLists()
        } catch {
            shoppingError = shoppingErrorText(error)
        }
    }

    /// Unlink a list from this event — explicit null, not omission.
    private func unlinkShoppingList(_ list: ShoppingListDTO) async {
        shoppingBusy = true
        shoppingError = nil
        defer { shoppingBusy = false }
        do {
            _ = try await APIClient(state: state).updateShoppingList(
                id: list.id, title: nil, eventId: .some(nil),
            )
            await loadShoppingLists()
        } catch {
            shoppingError = shoppingErrorText(error)
        }
    }

    /// Create a list pre-linked to this event. An empty title field
    /// falls back to the shared default title, like the web flow.
    private func createShoppingListForEvent(_ existing: EventDTO) async {
        shoppingBusy = true
        shoppingError = nil
        defer { shoppingBusy = false }
        let title = newEventListTitle.trimmingCharacters(in: .whitespaces)
        do {
            _ = try await APIClient(state: state).createShoppingList(
                title: title.isEmpty ? "购买清单".loc : title,
                eventId: existing.id,
            )
            newEventListTitle = ""
            await loadShoppingLists()
        } catch {
            shoppingError = shoppingErrorText(error)
        }
    }

    private func refreshSuggestions() {
        localSuggestions = AddressBook.match(AddressBookStore.entries(), query: location, title: summary, limit: 5)
        onlineSuggestions = []
        suggestTask?.cancel()
        let q = location.trimmingCharacters(in: .whitespaces)
        guard locationFocused, localSuggestions.count < 3, q.count >= 3,
              AddressBookStore.onlineEnabled() else { return }
        suggestTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            let lang = LocaleManager.shared.current.isEmpty
                ? (Locale.current.language.languageCode?.identifier ?? "en")
                : LocaleManager.shared.current
            let found = await APIClient(state: state).geoSuggest(query: q, lang: lang)
            if Task.isCancelled { return }
            if location.trimmingCharacters(in: .whitespaces) == q {
                onlineSuggestions = found
            }
        }
    }

    /// 地址簿首次播种：宽窗口（过去 24 个月到未来 12 个月）拉一次
    /// 事件列表，只取 location。失败不置标记，下次打开编辑器再试。
    private func seedAddressBook() async {
        do {
            let now = Date()
            let from = now.addingTimeInterval(-24 * 30 * 24 * 3600)
            let to = now.addingTimeInterval(12 * 30 * 24 * 3600)
            let fmt = DateFormatters.isoPlain
            let path = "/events?from=\(fmt.string(from: from))&to=\(fmt.string(from: to))"
            let resp: EventsResponse = try await APIClient(state: state).get(path)
            AddressBookStore.seed(locations: resp.events.compactMap { $0.location })
        } catch {
            // 静默：见上。
        }
    }

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }

        guard dateOrderIsValid else {
            errorMessage = dateOrderError
            saveViaQuick = false
            return
        }
        let isoStart = iso(startsAt, allDay: allDay, isStart: true)
        let isoEnd = iso(endsAt, allDay: allDay, isStart: false)
        let extra = buildExtra()

        // 冲突检测（软检查，和网页端同一口径）：真正保存前先查一次，
        // 新建和编辑都查（编辑带 excludeId 排除自己），定时与全天都查。
        // 有冲突 → 弹确认框，用户选「仍要保存」才继续（靠
        // conflictCheckPassed 跳过复查）；选「取消」→ 中止保存、留在
        // 编辑页。查询本身失败（网络错等）绝不阻断保存，静默跳过。
        if !conflictCheckPassed {
            let conflicts = (try? await APIClient(state: state).checkConflicts(
                calendarId: calendarId,
                startsAt: isoStart,
                endsAt: isoEnd,
                excludeId: mode.existing?.id,
            )) ?? []
            if !conflicts.isEmpty {
                conflictPrompt = ConflictPrompt(conflicts: conflicts)
                return
            }
            conflictCheckPassed = true
        }

        do {
            // 保存走离线队列：请求体先序列化存进队列、本地立刻按新值
            // 显示，有网当场重放落定，没网排队等恢复——不再像以前那样
            // 断网点保存只剩一个报错、编辑内容全丢。重放复用同一份
            // 请求体字节和同一个 clientUid，服务端按 uid 幂等，
            // 重试不会建出重复事件。
            let service = state.offlineSync
            let saved: EventSaved
            switch mode {
            case .create, .duplicateOf:
                // Both paths POST a new event. Duplicate starts with an
                // empty recurrence editor (seeded in init) so the user
                // doesn't accidentally spawn a parallel recurring
                // series; a rule only goes out if they set one here.
                let input = EventCreateInput(
                    calendarId: calendarId,
                    summary: summary.trimmingCharacters(in: .whitespaces),
                    description: description.isEmpty ? nil : description,
                    location: location.isEmpty ? nil : location,
                    startsAt: isoStart,
                    endsAt: isoEnd,
                    allDay: allDay,
                    rrule: rruleState.build(),
                    extra: extra,
                    exdates: nil,
                    // Stable across retries within this editor session (see
                    // the clientUid @State). Always set in create/duplicate
                    // mode; this branch only runs for those modes.
                    clientUid: clientUid,
                )
                let bodyData = try JSONEncoder.iso().encode(AnyEncodable(input))
                let tempId = PendingOpLogic.localEventId(clientUid: clientUid ?? "")
                guard let localDTO = service.localDTO(forCreateBody: bodyData, tempId: tempId) else {
                    throw APIError.decode(NSError(domain: "offline-local-dto", code: 0))
                }
                service.enqueueCreate(bodyData: bodyData, localDTO: localDTO, clientUid: clientUid)
                // 落定了拿服务端那份（真实 id），没落定用本地那份——
                // 「已创建」条和日历页都先按本地的显示，同步后自动换正。
                saved = await service.replayCreate(tempId: tempId) ?? localDTO
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
                let input = EventUpdateInput(
                    calendarId: cidIfChanged,
                    summary: summary.trimmingCharacters(in: .whitespaces),
                    description: description,
                    location: location,
                    startsAt: startsAt == snapshot.startsAt && allDay == snapshot.allDay ? nil : isoStart,
                    endsAt: endsAt == snapshot.endsAt && allDay == snapshot.allDay ? nil : isoEnd,
                    allDay: allDay,
                    rrule: rruleToSend,
                    extra: extra,
                    scope: scope?.rawValue,
                    recurrenceId: recIdIso,
                    exdates: exdatesToSend,
                )
                let bodyData = try JSONEncoder.iso().encode(AnyEncodable(input))
                let baseF = ISO8601DateFormatter()
                baseF.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                service.enqueueUpdate(
                    eventId: existing.id, bodyData: bodyData,
                    scope: scope?.rawValue, recurrenceId: recIdIso,
                    baseStartsAt: baseF.string(from: existing.startsAt),
                    snapshot: [existing],
                    summary: summary.trimmingCharacters(in: .whitespaces),
                )
                await service.replay()
                saved = service.applyingUpdate(existing, payloadJson: String(data: bodyData, encoding: .utf8))
            }
            // Success buzz — mirrors WeekView.commitMove so every
            // create / edit / duplicate that lands on the server gives the
            // same confirmation feel.
            // Feed the create-default memory (see the create branch in
            // init): the next new event starts on the calendar this
            // save just used.
            UserDefaults.standard.set(calendarId, forKey: "lastUsedCalendarId")
            // 地址簿学习：选中又改了就更新原条目（编辑学习），
            // 没选过就按新地址记一次使用。
            if !location.isEmpty {
                AddressBookStore.learnFromSave(picked: pickedLocation, saved: location, title: summary)
            }
            pickedLocation = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            // 一句话直接保存：记到 AppState，日历页弹「已创建」条
            // （打开 / 撤销）。普通保存不记。
            if saveViaQuick {
                saveViaQuick = false
                state.noteQuickCreated(saved)
            }
            onSaved(saved)
        } catch let e as APIError {
            // 保存没成：下次再点保存要重新查冲突（用户多半会改时间）。
            conflictCheckPassed = false
            saveViaQuick = false
            errorMessage = e.localizedDescription
        } catch {
            conflictCheckPassed = false
            saveViaQuick = false
            errorMessage = error.localizedDescription
        }
    }

    /// rrule for the PATCH: only when the editor owns the rule AND
    /// the user changed it. Clearing sends "" — the web editor's
    /// convention, which the server reads as「rule removed」, while
    /// an omitted field keeps the stored rule (its series planner
    /// also keys off whether the value differs, so echoing the same
    /// string back would be noise).
    private var rruleToSend: String? {
        guard rruleEditable, rruleState.isEdited else { return nil }
        return rruleState.build() ?? ""
    }

    /// exdates for the PATCH: the full remaining list, only when the
    /// user restored at least one occurrence. Sending the list when
    /// it didn't change would fight the server's own exdate
    /// bookkeeping (scoped deletes append server-side; a time-zone
    /// change remaps them server-side).
    private var exdatesToSend: [String]? {
        guard exdatesEditable else { return nil }
        let original = mode.existing?.exdates ?? []
        return exdates != original ? exdates : nil
    }

    /// 新建（含「复制一份」）走 POST，编辑走 PATCH —— 两者对「字段空着」的含义不同。
    private var isNewEvent: Bool {
        switch mode {
        case .create, .duplicateOf: return true
        default: return false
        }
    }

    /// 这个界面负责的字段，空着时是什么意思：
    /// 新建时没有「原来的值」可删，直接不带上；编辑时空着就是用户清空了，要发显式 null。
    private func managed(_ v: String?) -> ExtraField<String> {
        if let v { return .value(v) }
        return isNewEvent ? .unmanaged : .cleared
    }

    /// 拼 API 请求里的 `extra`。
    ///
    /// 关键在于区分「这个界面不管这个字段」和「用户清空了它」：服务端是逐字段合并的，
    /// 键不出现 = 保持原样，显式 null = 删掉。以前这里统一用 Optional，nil 被
    /// Swift 省掉，于是会议链接和入会密码**永远删不掉**。
    private func buildExtra() -> EventExtra {
        let trimmedURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPassword = meetingPassword.trimmingCharacters(in: .whitespacesAndNewlines)
        // **手上这份事件根本没带 extra 的话，这个界面对这几个字段就「不归我管」。**
        // 区分不了「用户清空了」和「我从来没加载过」，就会把没加载过当成清空：
        // 搜索结果不带 extra（里面有入会密码，按设计不回），从搜索点进去改个标题，
        // 会议链接、入会密码、时区当场全没 —— 一个错都不报。
        // 注意这对「本来就没有 extra 的事件」是安全的：没东西可保，发不发 null 一样。
        let extraLoaded = mode.existing?.extra != nil
        func field(_ v: String?) -> ExtraField<String> {
            // 用户填了东西 —— 不管加载没加载过，都要发出去，否则「给一个没有 extra
            // 的事件加会议链接」会静默存不上。**「不归我管」只适用于空着的字段。**
            if let v { return managed(v) }
            // 空着：只有真的加载过、确认它原来有值，才当成「用户清空了」。
            return extraLoaded ? managed(nil) : .unmanaged
        }
        return EventExtra(
            // 全天事件这个界面不提供时区选择，所以它不是「被清空」而是「不归我管」。
            // 写成清空会把别的端设的时区删掉，而服务端算全天事件的提醒正要用它。
            timezone: startZoneField(),
            // 参与者有自己的页面和接口 —— 在这里发 null 等于把别人
            // 设的东西抹掉。分类不同：这个界面现在有分类选择器，
            // 走 field() 同一口径（选「无」= 清空，发显式 null）。
            attendees: .unmanaged,
            category: field(category.isEmpty ? nil : category),
            url: field(trimmedURL.isEmpty ? nil : trimmedURL),
            meetingPassword: field(trimmedPassword.isEmpty ? nil : trimmedPassword),
            alarms: alarmsField(extraLoaded: extraLoaded),
            endTimezone: endZoneField()
        )
    }

    private var endpointFieldsChanged: Bool {
        endpointZonesEdited || timezone != snapshot.timezone || endTimezone != snapshot.endTimezone ||
            calendarId != snapshot.calendarId || allDay != snapshot.allDay ||
            startsAt != snapshot.startsAt || endsAt != snapshot.endsAt
    }

    private func startZoneField() -> ExtraField<String> {
        guard !allDay else { return .unmanaged }
        let storedStart = mode.existing?.extra?.timezone.flatMap { TimeZone(identifier: $0) }
        guard isNewEvent || timezone != snapshot.timezone || calendarId != snapshot.calendarId ||
                (storedStart == nil && endpointFieldsChanged) else { return .unmanaged }
        return .value(timezone)
    }

    private func endZoneField() -> ExtraField<String> {
        guard !allDay else { return .unmanaged }
        if endZoneLinkedToStart || endTimezone == timezone {
            // New same-zone events inherit start. Switching an old independent
            // destination back to start removes its explicit override.
            return !isNewEvent && endpointFieldsChanged && mode.existing?.extra?.endTimezone != nil ? .cleared : .unmanaged
        }
        guard isNewEvent || endTimezone != snapshot.endTimezone || calendarId != snapshot.calendarId || allDay != snapshot.allDay else { return .unmanaged }
        return .value(endTimezone)
    }

    /// 拼 extra.alarms：选择器选中的一条 + 既有 alarms 里不归选择器管的那些。
    ///
    /// 归选择器管 = trigger 落在当前组（定时 / 全天）枚举内。导入进来的
    /// 自定义提醒（带参数的 TRIGGER、组外的值）不在枚举内，原样保留；
    /// 枚举内的旧提醒则被选择器的当前值取代（主提醒只有一个）。
    ///
    /// 选「无」且没有其余 alarms 时发显式 null：服务端是浅合并，
    /// 省略 = 保留原值，只有 null 能把这个键删掉（网页端同口径）。
    private func alarmsField(extraLoaded: Bool) -> ExtraField<[EventAlarmDTO]> {
        // extra 根本没加载进来（搜索结果不带 extra）时，区分不了
        // 「原来没有提醒」和「我没看到」：选择器没被动过就整个不归
        // 我管，免得把服务端上的提醒当成「用户清掉了」抹掉。
        if mode.existing != nil, !extraLoaded, reminder == initialReminder {
            return .unmanaged
        }
        let group = ReminderOptions.values(allDay: allDay)
        let preserved = (mode.seed?.extra?.alarms ?? []).filter {
            !group.contains($0.trigger.trimmingCharacters(in: .whitespaces))
        }
        var combined: [EventAlarmDTO] = []
        if !reminder.isEmpty {
            combined.append(EventAlarmDTO(
                trigger: reminder,
                action: "DISPLAY",
                description: summary.trimmingCharacters(in: .whitespaces),
            ))
        }
        combined.append(contentsOf: preserved)
        return combined.isEmpty ? .cleared : .value(combined)
    }

    /// Top-of-list candidate timezones for the picker. The system tz is
    /// inserted at index 0 (if not already present) so 「上海开发者」
    /// gets Asia/Shanghai as default. Full IANA list would be 500+ rows
    /// and overwhelm the menu picker; this is the same shortlist the
    /// web client uses.
    static let commonTimezones: [String] = {
        var list = [
            "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Asia/Hong_Kong",
            "Asia/Seoul", "Asia/Taipei", "Asia/Bangkok", "Asia/Kolkata",
            "Asia/Dubai", "Europe/London", "Europe/Berlin", "Europe/Paris",
            "Europe/Moscow", "America/New_York", "America/Chicago",
            "America/Los_Angeles", "America/Sao_Paulo", "Australia/Melbourne", "Australia/Sydney",
            "Pacific/Auckland", "UTC",
        ]
        let current = TimeZone.current.identifier
        if !list.contains(current) { list.insert(current, at: 0) }
        return list
    }()

    private func iso(_ d: Date, allDay: Bool, isStart: Bool) -> String {
        if allDay {
            // Match the web's all-day convention: UTC midnight for the
            // calendar date the user picked. Server interprets the date
            // portion only.
            let cal = civilCalendar
            var comps = cal.dateComponents([.year, .month, .day], from: d)
            comps.hour = isStart ? 0 : 23
            comps.minute = isStart ? 0 : 59
            comps.second = isStart ? 0 : 59
            comps.timeZone = TimeZone(identifier: "UTC")
            let utc = cal.date(from: comps) ?? d
            return ISO8601DateFormatter().string(from: utc)
        }
        return EventEditorDates.timedISO(d)
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

private struct EventEndpointZonePicker: View {
    let title: String
    @Binding var selection: String
    let date: Date
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    @Environment(\.locale) private var locale
    @State private var entries: [Entry] = []

    private struct Entry: Identifiable {
        let id: String
        let city: String
        let name: String
        let offset: String
    }

    private var filtered: [Entry] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return entries }
        return entries.filter {
            $0.id.replacingOccurrences(of: "_", with: " ").localizedCaseInsensitiveContains(query) ||
                $0.city.localizedCaseInsensitiveContains(query) ||
                $0.name.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        List(filtered) { entry in
            Button {
                selection = entry.id
                dismiss()
            } label: {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(entry.city) · \(entry.offset)")
                            .foregroundStyle(.primary)
                        Text("\(entry.name) · \(entry.id)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 4)
                    if entry.id == selection { Image(systemName: "checkmark") }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityAddTraits(entry.id == selection ? .isSelected : [])
        }
        .navigationTitle(title.loc)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: Text("event.timezone.search".loc))
        .task(id: locale.identifier) {
            // Build names once when this picker opens (or the locale changes),
            // not for every search keystroke or each scrolling row render.
            let identifiers = Set(TimeZone.knownTimeZoneIdentifiers + EventEditView.commonTimezones + [selection])
            entries = identifiers.compactMap { identifier in
                guard let zone = TimeZone(identifier: identifier) else { return nil }
                return Entry(id: identifier,
                    city: DateFormatters.localFormatter("VVV", template: false, zone: zone).string(from: date),
                    name: zone.localizedName(for: .generic, locale: locale) ?? identifier,
                    offset: Self.offsetLabel(zone, at: date))
            }.sorted { lhs, rhs in
                lhs.city == rhs.city ? lhs.id < rhs.id : lhs.city.localizedStandardCompare(rhs.city) == .orderedAscending
            }
        }
    }

    static func offsetLabel(_ zone: TimeZone, at date: Date) -> String {
        let seconds = zone.secondsFromGMT(for: date)
        let absolute = abs(seconds)
        return String(format: "UTC%@%02d:%02d", seconds < 0 ? "−" : "+", absolute / 3600, absolute % 3600 / 60)
    }
}
