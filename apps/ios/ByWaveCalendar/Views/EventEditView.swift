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

    @EnvironmentObject var state: AppState
    @Environment(\.timeZone) private var displayTimeZone

    @State private var summary: String
    @State private var location: String
    @State private var description: String
    @State private var startsAt: Date
    @State private var endsAt: Date
    @State private var allDay: Bool
    @State private var calendarId: String
    // Recurrence/calendar timezone metadata. DatePicker displays the device
    // zone and keeps Date instants; this field never reinterprets its clock.
    // "(默认)" lets the server use the calendar's stored timezone.
    @State private var timezone: String = TimeZone.current.identifier
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
    private let snapshot: FormSnapshot

    /// The form's seed values, captured in init. `isDirty` compares
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
            calendarId: calendarId, timezone: timezone,
            url: url, meetingPassword: meetingPassword,
            category: category, reminder: reminder,
            rruleBuilt: rruleState.build(), exdates: exdates,
        )
    }

    private var isDirty: Bool { currentSnapshot != snapshot }

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
        if let e = mode.seed {
            // For "duplicate" we want today's slot, not the source's
            // possibly-historical start. Edit keeps the original time.
            let useOriginalTime = mode.existing != nil
            let seedStart: Date
            let seedEnd: Date
            if useOriginalTime {
                seedStart = e.allDay ? EventEditorDates.localAllDay(e.startsAt) : e.startsAt
                seedEnd = e.allDay ? EventEditorDates.localAllDay(e.endsAt) : e.endsAt
            } else {
                (seedStart, seedEnd) = EventEditorDates.duplicate(
                    start: e.startsAt, end: e.endsAt, allDay: e.allDay,
                    from: Self.roundUpToHalfHour(Date()))
            }
            _summary = State(initialValue: e.summary)
            _location = State(initialValue: e.location ?? "")
            _description = State(initialValue: e.description ?? "")
            _startsAt = State(initialValue: seedStart)
            _endsAt = State(initialValue: seedEnd)
            _allDay = State(initialValue: e.allDay)
            _calendarId = State(initialValue: e.calendarId)
            // Preload timezone from the server's extra JSONB. Attendees
            // are not preloaded here — they live on the dedicated
            // AttendeesPage which fetches them fresh each open.
            let seedTimezone = (e.extra?.timezone?.isEmpty == false)
                ? e.extra!.timezone! : TimeZone.current.identifier
            if seedTimezone != TimeZone.current.identifier {
                _timezone = State(initialValue: seedTimezone)
            }
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
                calendarId: e.calendarId, timezone: seedTimezone,
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
            let freshRrule = RruleState.parse(nil, seedStart: start)
            _rruleState = State(initialValue: freshRrule)
            snapshot = FormSnapshot(
                summary: "", location: "", description: "",
                startsAt: start, endsAt: start.addingTimeInterval(3600),
                allDay: false, calendarId: initialCalendarId,
                timezone: TimeZone.current.identifier,
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
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                    // Timezone picker — only meaningful for timed events.
                    // All-day events span the calendar's local day per ICS
                    // spec, so the field would be misleading.
                    LabeledContent("显示时区", value: displayTimeZone.identifier)
                    Picker("日程时区", selection: $timezone) {
                        ForEach(pickerTimezones, id: \.self) { tz in
                            Text(tz).tag(tz)
                        }
                    }
                    .pickerStyle(.menu)
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
                .disabled(saving || summary.trimmingCharacters(in: .whitespaces).isEmpty || calendarId.isEmpty)
            }
        }
        .onAppear {
            oldStartValue = startsAt
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

    // Used by the .onChange handler to compute the start-time delta and
    // shift end accordingly. Tracks the value seen at the previous frame.
    @State private var oldStartValue: Date?

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
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        do {
            let parsed = try await APIClient(state: state)
                .parseQuickEvent(text: text, now: f.string(from: Date()))
            guard let s = QuickParsedEvent.localDate(parsed.startsAt),
                  let e = QuickParsedEvent.localDate(parsed.endsAt)
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
            oldStartValue = fill.start
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
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        let weekdayFmt = DateFormatter()
        weekdayFmt.locale = Locale(identifier: "zh_CN")
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
            guard let s = QuickParsedEvent.localDate(r.content.startsAt),
                  let e = QuickParsedEvent.localDate(r.content.endsAt),
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

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }

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
            let client = APIClient(state: state)
            let saved: EventSaved
            switch mode {
            case .create, .duplicateOf:
                // Both paths POST a new event. Duplicate starts with an
                // empty recurrence editor (seeded in init) so the user
                // doesn't accidentally spawn a parallel recurring
                // series; a rule only goes out if they set one here.
                saved = try await client.post("/events", body: EventCreateInput(
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
                    description: description,
                    location: location,
                    startsAt: isoStart,
                    endsAt: isoEnd,
                    allDay: allDay,
                    rrule: rruleToSend,
                    extra: extra,
                    scope: scope?.rawValue,
                    recurrenceId: recIdIso,
                    exdates: exdatesToSend,
                ))
            }
            // Success buzz — mirrors WeekView.commitMove so every
            // create / edit / duplicate that lands on the server gives the
            // same confirmation feel.
            // Feed the create-default memory (see the create branch in
            // init): the next new event starts on the calendar this
            // save just used.
            UserDefaults.standard.set(calendarId, forKey: "lastUsedCalendarId")
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
            timezone: allDay ? .unmanaged : field(timezone.isEmpty ? nil : timezone),
            // 参与者有自己的页面和接口 —— 在这里发 null 等于把别人
            // 设的东西抹掉。分类不同：这个界面现在有分类选择器，
            // 走 field() 同一口径（选「无」= 清空，发显式 null）。
            attendees: .unmanaged,
            category: field(category.isEmpty ? nil : category),
            url: field(trimmedURL.isEmpty ? nil : trimmedURL),
            meetingPassword: field(trimmedPassword.isEmpty ? nil : trimmedPassword),
            alarms: alarmsField(extraLoaded: extraLoaded),
        )
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

    /// Picker options for THIS event: the common shortlist plus the
    /// event's own zone when it isn't in the shortlist, so the Picker
    /// can always represent the current value faithfully. Without
    /// this, an event anchored outside the 20-zone shortlist (e.g.
    /// America/Denver, set on the web) rendered a blank selection —
    /// the same silent-substitution bug EditCalendarView already
    /// fixed for calendars. The zone only changes when the user
    /// actually picks another row.
    private var pickerTimezones: [String] {
        var list = Self.commonTimezones
        if !timezone.isEmpty && !list.contains(timezone) {
            list.append(timezone)
        }
        return list
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
            "America/Los_Angeles", "America/Sao_Paulo", "Australia/Sydney",
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
            let cal = Calendar.current
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
