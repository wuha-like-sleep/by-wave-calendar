// CalendarView.swift
// v0.5 shell. Owns:
//   - View mode (day / week / month / year)
//   - The "anchor" date that the current view centers on
//   - Date navigation (prev / today / next)
//   - Fetching events for the visible window
//   - On-disk cache (cold launch = instant render, then refetch)
//   - Foreground refresh (scenePhase becomes .active → reload)
//   - 60s background polling timer
//   - Last-synced label
//   - "+" toolbar to create events
//   - "齿轮" toolbar to open settings

import SwiftUI

private enum ViewMode: String, CaseIterable, Identifiable {
    case day = "日"
    case week = "周"
    case month = "月"
    case year = "年"
    var id: String { rawValue }
}

struct CalendarView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.scenePhase) private var scenePhase

    @State private var mode: ViewMode = .day
    @State private var anchor: Date = Calendar.current.startOfDay(for: Date())

    @State private var events: [EventDTO] = []
    @State private var calendars: [CalendarMeta] = []
    @State private var isLoading = false
    @State private var lastSyncedAt: Date?
    @State private var errorMessage: String?
    @State private var showingCreate = false
    @State private var showingSettings = false
    @State private var showingFilter = false
    @State private var showingSearch = false
    @State private var showingProfileSwitcher = false
    // Horizontal-swipe tracking for date navigation. Reset on each new
    // gesture; commits to a direction once user has moved > 50 pt.
    @State private var swipeOffset: CGFloat = 0

    // Polling timer — fires every 60s while in foreground.
    @State private var pollTask: Task<Void, Never>?
    // Debounce task for anchor/mode changes. Swiping rapidly through
    // a week would otherwise fire 5+ /api/v1/events requests back to
    // back; this collapses them into one after the user pauses.
    @State private var navDebounceTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                navBar
                ZStack(alignment: .top) {
                    contentForMode
                        // Without these the WeekView's outer VStack would
                        // be vertically centered inside the ZStack (default
                        // .center alignment), pushing the date headers and
                        // time grid into the middle of the screen with
                        // empty space above. Day/Month/Year are all happy
                        // to fill too.
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    if isLoading && events.isEmpty {
                        // Cache miss + first fetch in flight
                        ProgressView()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Color(.systemGroupedBackground))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            // 撤销删除 snackbar (v1.6.2, 对齐 Android/桌面) — floats over
            // whatever view mode is active; auto-dismisses after 5s.
            .overlay(alignment: .bottom) {
                undoDeleteBar
                    .animation(.snappy, value: state.pendingUndoDelete)
            }
            .navigationTitle(navTitle.loc)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel(Text("设置"))
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        anchor = Calendar.current.startOfDay(for: Date())
                    } label: {
                        Text("今天").font(.callout.weight(.medium))
                    }
                    .disabled(Calendar.current.isDateInToday(anchor) && mode == .day)
                }
                // Profile-switcher button — Google-style avatar circle
                // top-right. Tinted with brand accent, first letter of
                // email inside. Tap → opens ProfileSwitcherView sheet.
                // A small dot badge in the lower-right indicates "more
                // than one account stashed" so the affordance is
                // discoverable for users who don't know about multi-acct.
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingProfileSwitcher = true
                    } label: {
                        profileAvatarBadge
                    }
                    .accessibilityLabel(Text("切换账号"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            showingSearch = true
                        } label: { Label("搜索", systemImage: "magnifyingglass") }
                        Button {
                            showingFilter = true
                        } label: {
                            Label(state.hiddenCalendarIds.isEmpty ? "筛选日历".loc : "筛选日历 (%lld)".locFormat(visibleCalCount),
                                  systemImage: "line.3.horizontal.decrease.circle")
                        }
                        Button {
                            Task { await load(force: true) }
                        } label: { Label("刷新", systemImage: "arrow.clockwise") }
                            .disabled(isLoading)
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityLabel(Text("筛选日历"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingCreate = true } label: { Image(systemName: "plus") }
                        .disabled(calendars.isEmpty)
                        .accessibilityLabel(Text("新建事件"))
                }
            }
            .refreshable { await load(force: true) }
            .task {
                // On first appearance, hydrate from cache → instant render,
                // then fetch fresh. Cache hit means an old `lastSyncedAt`
                // appears in the footer until the new response replaces it.
                await loadFromCache()
                await load(force: false)
                startPolling()
            }
            .onDisappear { stopPolling() }
            .onChange(of: scenePhase) { _, new in
                // Returning to foreground → refresh + restart polling.
                if new == .active {
                    Task { await load(force: false) }
                    startPolling()
                } else {
                    stopPolling()
                }
            }
            // APNs silent push from the server posts this notification.
            // We reload immediately so the UI reflects whatever changed
            // on the server side (event created on another device, etc.).
            .onReceive(NotificationCenter.default.publisher(for: .bwcRemoteDataChanged)) { _ in
                Task { await load(force: true) }
            }
            .onChange(of: mode) { _, _ in
                // Mode switch is pure UI now (filter window changes) —
                // events are already cached for a wide range. No fetch.
                // Light selection tick so the day/week/month/year segmented
                // control feels physical, like the iOS Calendar tabs.
                UISelectionFeedbackGenerator().selectionChanged()
            }
            .onChange(of: anchor) { _, _ in
                // Only refetch when the user navigated far enough out of
                // the cached window. Within range, views filter locally
                // and switching dates is instant.
                if anchorOutsideFetchedWindow() {
                    scheduleDebouncedLoad()
                }
            }
            .onDisappear { navDebounceTask?.cancel() }
            .sheet(isPresented: $showingCreate) {
                NavigationStack {
                    EventEditView(
                        mode: .create,
                        calendars: calendars,
                        onSaved: { saved in
                            showingCreate = false
                            // 动线: jump to the day the new event lives on,
                            // so「明天下午3点开会」lands you ON tomorrow
                            // instead of leaving you staring at today.
                            withAnimation {
                                anchor = Calendar.current.startOfDay(for: saved.startsAt)
                            }
                            Task { await load(force: true) }
                        },
                        onCancel: { showingCreate = false },
                    )
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .sheet(isPresented: $showingFilter) {
                CalendarFilterView(
                    calendars: calendars,
                    onCalendarsChanged: { Task { await load(force: true) } },
                )
                .environmentObject(state)
            }
            .sheet(isPresented: $showingSearch) {
                SearchView(calendars: calendars).environmentObject(state)
            }
            .sheet(isPresented: $showingProfileSwitcher) {
                ProfileSwitcherView().environmentObject(state)
            }
            // Horizontal swipe on the body navigates dates. We only commit
            // when the gesture is decisively horizontal (avoids stealing
            // List scroll). Translation > 60 pt → snap to prev/next.
            .gesture(
                DragGesture(minimumDistance: 24)
                    .onEnded { value in
                        let h = value.translation.width
                        let v = value.translation.height
                        // Only navigate on a DECISIVELY horizontal swipe: the
                        // horizontal component must clearly dominate the vertical
                        // (≥1.8×), and travel a good distance (70pt). Stricter than
                        // before so diagonal / near-vertical drags and light flicks
                        // don't accidentally flip the week/month.
                        if abs(h) < abs(v) * 1.8 { return }
                        if h < -70 { shiftAnchor(by: 1) }
                        else if h > 70 { shiftAnchor(by: -1) }
                    },
            )
        }
    }

    private var visibleCalCount: Int {
        calendars.filter { !state.hiddenCalendarIds.contains($0.id) }.count
    }

    /// Small tinted circle showing the active account's email initial.
    /// A dot badge appears in the lower-right when there's more than one
    /// profile so users discover the multi-account feature without
    /// digging into Settings.
    private var profileAvatarBadge: some View {
        ZStack(alignment: .bottomTrailing) {
            ZStack {
                Circle()
                    .fill(state.themeAccent)
                    .frame(width: 28, height: 28)
                Text(profileInitial)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
            }
            if state.profiles.count > 1 {
                // Tiny dot badge — signals "you have multiple accounts
                // here, tap to switch". 8pt circle with border so it
                // doesn't blend into a busy header background.
                Circle()
                    .fill(Color.green)
                    .frame(width: 9, height: 9)
                    .overlay(
                        Circle().stroke(Color(.systemBackground), lineWidth: 1.5),
                    )
                    .offset(x: 2, y: 2)
            }
        }
    }

    private var profileInitial: String {
        if let email = state.currentUserEmail, let c = email.first {
            return String(c).uppercased()
        }
        if let host = state.serverURL?.host, let c = host.first {
            return String(c).uppercased()
        }
        return "?"
    }

    // MARK: - Header (mode picker + nav arrows + anchor date)
    private var navBar: some View {
        VStack(spacing: 6) {
            Picker("视图", selection: $mode) {
                ForEach(ViewMode.allCases) { Text($0.rawValue.loc).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 14)

            HStack(spacing: 6) {
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    shiftAnchor(by: -1)
                } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel(Text("上一页"))
                Spacer()
                Button { anchor = Calendar.current.startOfDay(for: Date()) } label: {
                    Text(anchorLabel)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                }
                Spacer()
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    shiftAnchor(by: 1)
                } label: { Image(systemName: "chevron.right") }
                    .accessibilityLabel(Text("下一页"))
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 4)

            if let synced = lastSyncedAt {
                Text(syncedLabel(for: synced))
                    .font(.caption2).foregroundStyle(.tertiary)
            } else if let err = errorMessage {
                Text(err).font(.caption2).foregroundStyle(.red)
            }
        }
        .padding(.top, 6)
        .background(Color(.systemBackground))
    }

    // MARK: - Body for each mode
    // All sub-views receive events already filtered by the user's
    // hidden-calendars set so toggling visibility in CalendarFilterView
    // re-renders the grids immediately.
    private var visibleEvents: [EventDTO] { state.visibleEvents(events) }

    @ViewBuilder
    private var contentForMode: some View {
        switch mode {
        case .day:
            DayView(
                anchor: anchor,
                events: eventsForDay(anchor),
                calendars: calendars,
                onEventChanged: { Task { await load(force: true) } },
            )
        case .week:
            WeekView(
                weekStart: startOfWeek(anchor),
                events: visibleEvents,
                calendars: calendars,
                onEventChanged: { Task { await load(force: true) } },
            )
        case .month:
            MonthView(
                monthAnchor: anchor,
                events: visibleEvents,
                calendars: calendars,
                onEventChanged: { Task { await load(force: true) } },
            )
        case .year:
            YearView(
                yearAnchor: anchor,
                events: visibleEvents,
                onMonthTap: { tappedMonthAnchor in
                    anchor = tappedMonthAnchor
                    mode = .month
                },
            )
        }
    }

    private var navTitle: String {
        switch mode {
        case .day, .week: return "日历"
        case .month, .year: return "日历"
        }
    }

    private var anchorLabel: String {
        // CLDR templates so the header follows the app language — was
        // hardcoded zh_CN patterns ("yyyy年M月d日") which leaked Chinese
        // into every other language's UI.
        let f = DateFormatter()
        f.locale = Locale.current
        switch mode {
        case .day:
            f.setLocalizedDateFormatFromTemplate("yMMMdEEEE")
            return f.string(from: anchor)
        case .week:
            let start = startOfWeek(anchor)
            let end = Calendar.current.date(byAdding: .day, value: 6, to: start)!
            f.setLocalizedDateFormatFromTemplate("MMMd")
            return "\(f.string(from: start)) – \(f.string(from: end))"
        case .month:
            f.setLocalizedDateFormatFromTemplate("yMMMM")
            return f.string(from: anchor)
        case .year:
            f.setLocalizedDateFormatFromTemplate("y")
            return f.string(from: anchor)
        }
    }

    private func syncedLabel(for date: Date) -> String {
        let secs = Int(Date().timeIntervalSince(date))
        if secs < 30 { return "已同步".loc }
        if secs < 60 { return "%lld 秒前同步".locFormat(secs) }
        if secs < 3600 { return "%lld 分钟前同步".locFormat(secs / 60) }
        // The trailing「同步」word is localized; the HH:mm time is formatted
        // separately so the date itself stays locale-neutral (24h clock).
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm"
        return "%@ 同步".locFormat(f.string(from: date))
    }

    // MARK: - Navigation
    private func shiftAnchor(by direction: Int) {
        let cal = Calendar.current
        switch mode {
        case .day:
            anchor = cal.date(byAdding: .day, value: direction, to: anchor) ?? anchor
        case .week:
            anchor = cal.date(byAdding: .day, value: 7 * direction, to: anchor) ?? anchor
        case .month:
            anchor = cal.date(byAdding: .month, value: direction, to: anchor) ?? anchor
        case .year:
            anchor = cal.date(byAdding: .year, value: direction, to: anchor) ?? anchor
        }
    }

    // MARK: - Date math
    private func startOfWeek(_ date: Date) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.firstWeekday = 2  // Monday
        let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return cal.date(from: comps) ?? date
    }

    private func eventsForDay(_ day: Date) -> [EventDTO] {
        let cal = Calendar.current
        let start = cal.startOfDay(for: day)
        let end = cal.date(byAdding: .day, value: 1, to: start)!
        return state.visibleEvents(events)
            .filter { $0.startsAt < end && $0.endsAt > start }
            .sorted { $0.startsAt < $1.startsAt }
    }

    // MARK: - Fetch window
    // v1.2.1: switched from per-view windows (day = 1 day, week = 7 days,
    // ...) to a single wide window centered on `anchor`. Reason: when
    // each view fetched only its own range, switching day→week→month
    // showed inconsistent event sets — each view kept the LAST window's
    // snapshot in `self.events`. Now every load fetches the same wide
    // range and the per-view filters slice it locally; switching modes
    // is pure UI work, no network hit.
    //
    // The window is anchored ±range around the current anchor. When the
    // user navigates far outside it (e.g. jump to next year), a new
    // fetch covers the new range.
    private static let windowMonthsBack: Int = 2
    private static let windowMonthsForward: Int = 13

    /// The single wide window we refetch into. All views filter from
    /// this in-memory set.
    private func currentWindow() -> (Date, Date) {
        let cal = Calendar.current
        let start = cal.date(byAdding: .month, value: -Self.windowMonthsBack, to: anchor) ?? anchor
        let end = cal.date(byAdding: .month, value: Self.windowMonthsForward, to: anchor) ?? anchor
        return (cal.startOfDay(for: start), cal.startOfDay(for: end))
    }

    /// True if the anchor moved far enough that the existing window
    /// no longer comfortably covers what the user is looking at. Used
    /// to skip refetches when navigating within the cached range.
    @State private var lastFetchedWindow: (start: Date, end: Date)?
    private func anchorOutsideFetchedWindow() -> Bool {
        guard let w = lastFetchedWindow else { return true }
        // Add a 2-week safety margin so we refetch BEFORE the visible
        // edge of week/month view hits the boundary.
        let margin: TimeInterval = 14 * 86400
        return anchor < w.start.addingTimeInterval(margin)
            || anchor > w.end.addingTimeInterval(-margin)
    }

    // MARK: - Cache hydration
    // MARK: - 撤销删除 (v1.6.2)

    @State private var restoringDeleted = false

    @ViewBuilder
    private var undoDeleteBar: some View {
        if let pending = state.pendingUndoDelete {
            HStack(spacing: 12) {
                Text("已删除「%@」".locFormat(pending.summary))
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    Task { await restoreDeleted(pending) }
                } label: {
                    if restoringDeleted {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("撤销删除").font(.subheadline.weight(.semibold))
                    }
                }
                .disabled(restoringDeleted)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: pending.token) {
                // Auto-dismiss after 5s — unless a newer delete replaced
                // this snackbar (token differs) or the user already undid.
                //
                // MUST bail on cancellation: the nav-pop transition that
                // brings the calendar back re-identifies this subtree and
                // cancels the task. `try?` would swallow that and fall
                // through to the clear below, killing the bar before the
                // user ever sees it (the original v1.6.2 bug).
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                if state.pendingUndoDelete?.token == pending.token {
                    withAnimation { state.pendingUndoDelete = nil }
                }
            }
        }
    }

    private func restoreDeleted(_ pending: PendingUndoDelete) async {
        restoringDeleted = true
        defer { restoringDeleted = false }
        do {
            try await APIClient(state: state).restoreEvent(id: pending.eventId)
            withAnimation { state.pendingUndoDelete = nil }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load(force: true)
        } catch {
            errorMessage = (error as? APIError)?.localizedDescription ?? error.localizedDescription
        }
    }

    private func loadFromCache() async {
        let key = EventCache.shared.key(serverURL: state.serverURL ?? URL(string: "http://nil")!, userEmail: state.currentUserEmail)
        // EventCache is now off the main actor (v1.0.1) — disk I/O +
        // JSON decode happen on a background queue, only the parsed
        // payload comes back here. Await is cheap (the decode is fast
        // compared to a network request).
        guard let payload = await EventCache.shared.read(key: key) else { return }
        // Use cached events only if the current view window overlaps the
        // cached window — otherwise we'd show stale events from a totally
        // different range. Server fetch updates within a moment anyway.
        let (start, end) = currentWindow()
        if payload.windowStart <= end && payload.windowEnd >= start {
            self.events = payload.events
            self.calendars = payload.calendars
            self.lastSyncedAt = payload.cachedAt
        }
    }

    // MARK: - Fetch
    private func load(force: Bool) async {
        // De-duplicate concurrent loads (polling + manual refresh racing).
        if isLoading && !force { return }
        let (from, to) = currentWindow()
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        // Remember what range we just covered so anchor-change handlers
        // can decide whether to refetch (only when navigating far enough
        // outside the cached window).
        lastFetchedWindow = (start: from, end: to)

        // Use the cached ISO8601 formatter — was creating a new one
        // per request, ~1ms overhead each. Tiny but cumulative under
        // swipe-spam.
        let path = "/events?from=\(DateFormatters.isoPlain.string(from: from).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)&to=\(DateFormatters.isoPlain.string(from: to).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)"

        do {
            let client = APIClient(state: state)
            let resp: EventsResponse = try await client.get(path)
            // Sort off the main actor before publishing. With a 12-month
            // pre-cache (incoming v1.0.x feature), the event count can
            // hit a few thousand — sorting 3000 elements on main was
            // ~30ms hitch. Detached task lets the main thread keep
            // rendering while we sort.
            let sortedEvents = await Task.detached(priority: .userInitiated) {
                resp.events.sorted { $0.startsAt < $1.startsAt }
            }.value
            self.calendars = resp.calendars
            self.events = sortedEvents
            self.lastSyncedAt = Date()
            // Persist to disk async — EventCache.write returns immediately
            // (enqueues on its background queue), so no UI hitch.
            let payload = EventCachePayload(
                events: sortedEvents,
                calendars: resp.calendars,
                cachedAt: Date(),
                windowStart: from,
                windowEnd: to,
            )
            let key = EventCache.shared.key(serverURL: state.serverURL ?? URL(string: "http://nil")!, userEmail: state.currentUserEmail)
            EventCache.shared.write(key: key, payload: payload)
            // Fire EventKit mirror (no-op if disabled / no permission).
            Task {
                await EventKitMirror.shared.mirror(events: resp.events, windowStart: from, windowEnd: to)
            }
            // Re-schedule local notifications. No-op when feature disabled
            // or permission denied. Always uses the full event set so
            // reminders for events outside the current view window still
            // queue up. We only re-schedule on substantial loads (day view
            // fetches just one day → we'd lose the rest); skip when the
            // window is < 2 days to avoid clearing the long-range schedule.
            let windowDays = Calendar.current.dateComponents([.day], from: from, to: to).day ?? 0
            if windowDays >= 2 {
                Task {
                    await LocalNotifications.shared.reschedule(events: resp.events, calendars: resp.calendars)
                }
            }
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Debounced load
    // Anchor/mode changes from swipe nav fire in rapid succession (each
    // chevron-tap or drag triggers @State updates). Without debounce we
    // hit the server N times and waste battery, and the UI feels janky
    // because each reload runs EventKit mirror + notification reschedule.
    // 220ms is long enough to coalesce a triple-tap, short enough to
    // feel "immediate" after a single swipe lands.
    private func scheduleDebouncedLoad() {
        navDebounceTask?.cancel()
        navDebounceTask = Task { [weak state] in
            try? await Task.sleep(nanoseconds: 220_000_000)
            if Task.isCancelled { return }
            guard state != nil else { return }
            await load(force: false)
        }
    }

    // MARK: - Polling
    private func startPolling() {
        stopPolling()
        pollTask = Task { [weak state] in
            // Sleep first, then loop forever. Foreground only — the
            // scenePhase observer cancels us when going to background.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                if Task.isCancelled { return }
                guard state != nil else { return }
                await load(force: false)
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}

// MARK: - Color from hex
// Reused across all sub-views. Defined once here.
extension Color {
    init?(hex: String?) {
        guard var s = hex else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        let r = Double((v >> 16) & 0xff) / 255
        let g = Double((v >> 8) & 0xff) / 255
        let b = Double(v & 0xff) / 255
        self = Color(red: r, green: g, blue: b)
    }
}
