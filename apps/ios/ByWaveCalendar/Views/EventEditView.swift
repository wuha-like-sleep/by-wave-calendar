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
            _summary = State(initialValue: e.summary)
            _location = State(initialValue: e.location ?? "")
            _description = State(initialValue: e.description ?? "")
            if useOriginalTime {
                _startsAt = State(initialValue: e.allDay ? EventEditorDates.localAllDay(e.startsAt) : e.startsAt)
                _endsAt = State(initialValue: e.allDay ? EventEditorDates.localAllDay(e.endsAt) : e.endsAt)
            } else {
                let (start, end) = EventEditorDates.duplicate(
                    start: e.startsAt, end: e.endsAt, allDay: e.allDay,
                    from: Self.roundUpToHalfHour(Date()))
                _startsAt = State(initialValue: start)
                _endsAt = State(initialValue: end)
            }
            _allDay = State(initialValue: e.allDay)
            _calendarId = State(initialValue: e.calendarId)
            // Preload timezone from the server's extra JSONB. Attendees
            // are not preloaded here — they live on the dedicated
            // AttendeesPage which fetches them fresh each open.
            if let tz = e.extra?.timezone, !tz.isEmpty {
                _timezone = State(initialValue: tz)
            }
            // Preload URL from extra. Existing events created on the web
            // (where the link field has been live for a while) will have
            // this populated; new iOS-created events start empty.
            if let storedURL = e.extra?.url, !storedURL.isEmpty {
                _url = State(initialValue: storedURL)
            }
            // Preload meeting passcode from extra, same as URL above.
            if let storedPassword = e.extra?.meetingPassword, !storedPassword.isEmpty {
                _meetingPassword = State(initialValue: storedPassword)
            }
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
            _calendarId = State(initialValue:
                calendars.first(where: { $0.id == lastUsed })?.id
                    ?? calendars.first?.id ?? "")
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
    // Recurrence produced by the quick-add parse (create modes only).
    // The editor has no recurrence picker of its own, so the parsed
    // rule is carried here, shown read-only in the form, and sent on
    // create. It is NOT seeded from a duplicated event — only an
    // explicit recurrence phrase in this session sets it.
    @State private var quickRrule: String?

    var body: some View {
        Form {
            if mode.isCreate {
                Section {
                    HStack(spacing: 8) {
                        TextField("试试：明天下午3点和老王开会", text: $quickText)
                            .autocorrectionDisabled(true)
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
                    // Timezone picker — only meaningful for timed events.
                    // All-day events span the calendar's local day per ICS
                    // spec, so the field would be misleading.
                    LabeledContent("显示时区", value: displayTimeZone.identifier)
                    Picker("日程时区", selection: $timezone) {
                        ForEach(EventEditView.commonTimezones, id: \.self) { tz in
                            Text(tz).tag(tz)
                        }
                    }
                    .pickerStyle(.menu)
                }
            }

            // Parsed recurrence from the quick-add phrase (create modes
            // only) — read-only display plus a way out: the editor has
            // no recurrence picker, so without the remove button a
            // mis-parsed 每周 would silently mint a series on save.
            if let quickRrule {
                Section("重复规则") {
                    Text(QuickParsedEvent.humanRrule(quickRrule))
                    Button("quickadd.rrule.remove", role: .destructive) {
                        self.quickRrule = nil
                    }
                }
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
            quickRrule = fill.rrule
            // The user got an explicit end from the parser — break the
            // start→end linkage so tweaking start won't shift it again.
            endLinkedToStart = false
            oldStartValue = fill.start
        }
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

        do {
            let client = APIClient(state: state)
            let saved: EventSaved
            switch mode {
            case .create, .duplicateOf:
                // Both paths POST a new event. Duplicate doesn't inherit
                // the source's rrule — we intentionally clear it so the
                // user doesn't accidentally spawn a parallel recurring
                // series. The only rrule a create can carry is one the
                // user just dictated through the quick-add phrase
                // (quickRrule, shown read-only in the form above).
                saved = try await client.post("/events", body: EventCreateInput(
                    calendarId: calendarId,
                    summary: summary.trimmingCharacters(in: .whitespaces),
                    description: description.isEmpty ? nil : description,
                    location: location.isEmpty ? nil : location,
                    startsAt: isoStart,
                    endsAt: isoEnd,
                    allDay: allDay,
                    rrule: quickRrule,
                    extra: extra,
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
                    rrule: nil,
                    extra: extra,
                    scope: scope?.rawValue,
                    recurrenceId: recIdIso,
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
            onSaved(saved)
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
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
            // 参与者有自己的页面和接口，分类和提醒由网页 / 其它端维护 ——
            // 在这里发 null 等于把别人设的东西抹掉。
            attendees: .unmanaged,
            category: .unmanaged,
            url: field(trimmedURL.isEmpty ? nil : trimmedURL),
            meetingPassword: field(trimmedPassword.isEmpty ? nil : trimmedPassword),
        )
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
