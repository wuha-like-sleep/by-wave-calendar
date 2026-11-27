// CalendarView.swift
// v0.5 shell. Owns:
//   - View mode (day / week / month / year)
//   - The "anchor" date that the current view centers on
//   - Date navigation (prev / today / next)
//   - Fetching events for the visible window
//   - On-disk cache (cold launch = instant render, then refetch)
//   - Foreground refresh (scenePhase becomes .active → reload)
//   - Foreground refresh every 15 seconds
//   - Last-synced label
//   - "+" toolbar to create events
//   - "齿轮" toolbar to open settings

import SwiftUI
import UniformTypeIdentifiers

/// 日视图的三种形态（对齐苹果日历日视图菜单：Single Day /
/// Multi Day / List）。选择持久化，折叠展开共用同一份。
private enum DayViewMode: String, CaseIterable {
    case single, multi, list

    var title: String {
        switch self {
        case .single: return "单日"
        case .multi: return "多日"
        case .list: return "列表"
        }
    }

    var symbol: String {
        switch self {
        case .single: return "rectangle.split.2x1"
        case .multi: return "rectangle.split.3x1"
        case .list: return "list.bullet"
        }
    }
}

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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var deviceTimeZone = DateFormatters.refreshDeviceTimeZone()

    @State private var mode: ViewMode = .day
    @AppStorage("bwc.dayViewMode") private var dayViewMode: DayViewMode = .single
    @State private var anchor: Date = Calendar.current.startOfDay(for: Date())

    @State private var events: [EventDTO] = []
    @State private var calendars: [CalendarMeta] = []
    @State private var isLoading = false
    @State private var loadGeneration = 0
    @State private var lastSyncedAt: Date?
    @State private var errorMessage: String?
    @State private var showingCreate = false
    @State private var showingPendingOps = false
    @State private var showingSettings = false
    @State private var showingFilter = false
    @State private var showingSearch = false
    @State private var showingProfileSwitcher = false
    // Invitations addressed to me: sheet visibility, the pending-count
    // badge on the toolbar button, and the deep-link token to open on.
    @State private var showingInvitations = false
    @State private var pendingInvitationCount = 0
    @State private var invitationOpenToken: String?
    // ICS import: the fileImporter toggle, plus the file (picked or
    // handed over by the system) whose confirmation sheet is showing.
    @State private var showingImportPicker = false
    @State private var importFileURL: URL?
    // Horizontal-swipe tracking for date navigation. Reset on each new
    // gesture; commits to a direction once user has moved > 50 pt.
    @State private var swipeOffset: CGFloat = 0

    // Polling timer — fires every 60s while in foreground.
    @State private var pollTask: Task<Void, Never>?
    // Debounce task for anchor/mode changes. Swiping rapidly through
    // a week would otherwise fire 5+ /api/v1/events requests back to
    // back; this collapses them into one after the user pauses.
    @State private var navDebounceTask: Task<Void, Never>?

    /// 展开的大画布（Duo 展开 / iPad）= regular 宽度；折叠 Duo 与
    /// 普通 iPhone 都是 compact。两种画布是两个独立的布局目标，
    /// 不是同一套布局的拉伸与否。
    private var useSplitLayout: Bool { horizontalSizeClass == .regular }

    var body: some View {
        // 分支在本视图内部换：mode / anchor / events / calendars 这些
        // @State 都长在本视图身上，不随分支重建。以前宽屏走另一套
        // 外壳、里面是第二个 CalendarView 实例，Duo 每次折叠/展开、
        // iPad 每次拖分屏，整棵日历连同状态一起被换掉——这次同一个
        // 实例只换 body 的分支，状态原地保留。
        Group {
            if useSplitLayout {
                NavigationSplitView {
                    sidebar
                } detail: {
                    NavigationStack { calendarWithSheets }
                }
            } else {
                NavigationStack { calendarWithSheets }
            }
        }
        // 撤销删除 snackbar (v1.6.2, 对齐 Android/桌面)。挂在 NavigationStack
        // 外层——详情页里删除、pop 动画还没结束时它就已经可见,而不是等回到
        // 根视图才出现。5 秒自动消失。
        .overlay(alignment: .bottom) {
            VStack(spacing: 8) {
                undoDeleteBar
                createdBar
            }
            .animation(.snappy, value: state.pendingUndoDelete)
            .animation(.snappy, value: state.pendingQuickCreated)
        }
        .sheet(item: $createdDetailEvent) { ev in
            NavigationStack {
                EventDetailView(
                    event: ev,
                    calendar: calendars.first { $0.id == ev.calendarId },
                    allCalendars: calendars,
                    onChanged: { Task { await load(force: true) } },
                )
            }
        }
    }

    // body 原来是一条近 260 行的单表达式（VStack + 三十多个修饰符），
    // Swift 类型检查器在整条链上求解超时（"unable to type-check this
    // expression in reasonable time"）。拆成两段计算属性分别求解：
    // calendarContent 是 VStack + 前半修饰符，calendarWithSheets 再叠
    // 后半的 sheet / fileImporter / 手势。修饰符顺序与原来逐字一致，
    // 行为不变。
    @ViewBuilder
    private var calendarWithSheets: some View {
        calendarContent
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
            .sheet(isPresented: $showingPendingOps) {
                PendingOpsView(onResolved: { Task { await load(force: true) } })
            }
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
            // ICS import confirmation — one sheet for both entry
            // points (the toolbar menu's fileImporter below and a
            // system handover parked in AppState.pendingImportURL).
            .sheet(isPresented: Binding(
                get: { importFileURL != nil },
                set: { if !$0 { importFileURL = nil } }
            )) {
                if let url = importFileURL {
                    ImportIcsView(
                        fileURL: url,
                        calendars: calendars,
                        onFinished: { didImport in
                            importFileURL = nil
                            if didImport { Task { await load(force: true) } }
                        }
                    )
                    .environmentObject(state)
                }
            }
            .fileImporter(
                isPresented: $showingImportPicker,
                allowedContentTypes: [UTType(filenameExtension: "ics") ?? .data],
                allowsMultipleSelection: false
            ) { result in
                if case .success(let urls) = result, let url = urls.first {
                    importFileURL = url
                }
            }
            .onChange(of: state.pendingImportURL) { _, url in
                if let url {
                    importFileURL = url
                    state.pendingImportURL = nil
                }
            }
            .onAppear {
                if let url = state.pendingImportURL {
                    importFileURL = url
                    state.pendingImportURL = nil
                }
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

    /// 冷启动首拉还没回、且一个事件都没有时的整屏加载态。抽成计算属性是
    /// 为了让 ZStack 里的 overlay 和它的淡入淡出动画共用同一个条件，
    /// 两边写散了迟早会不一致。
    private var showsInitialLoading: Bool {
        events.isEmpty && (isLoading || (lastSyncedAt == nil && errorMessage == nil))
    }

    @ViewBuilder
    private var calendarContent: some View {
            VStack(spacing: 0) {
                // 「某个账号被服务端登出、已切到这个账号」的提示。放在导航栏下面、
                // 视图切换条上面：放到 NavigationStack 外面（safeAreaInset）的话，
                // iOS 26 起的浮动导航栏不会让位，提示条会盖住设置 / 头像 / 日周月年。
                if let notice = state.accountNotice, let current = state.activeProfile {
                    AccountNoticeBanner(notice: notice, current: current) {
                        withAnimation(.snappy) { state.dismissAccountNotice() }
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                // 服务端公告（新版本在商店里）：样式与账号提示条一脉，
                // 多一个「去更新」。关掉后同一轮发布不再弹（AppState 记戳）。
                if let announcement = state.pendingAnnouncement {
                    AnnouncementBanner(announcement: announcement) {
                        withAnimation(.snappy) { state.dismissAnnouncement() }
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                // 离线队列指示：有没送出去的改动就亮一条，待处理
                //（被服务端拒绝、要用户裁决）优先。点开是队列页。
                PendingSyncBarView(service: state.offlineSync) {
                    showingPendingOps = true
                }
                navBar
                ZStack(alignment: .top) {
                    contentForMode
                        .id(deviceTimeZone.identifier)
                        // Without these the WeekView's outer VStack would
                        // be vertically centered inside the ZStack (default
                        // .center alignment), pushing the date headers and
                        // time grid into the middle of the screen with
                        // empty space above. Day/Month/Year are all happy
                        // to fill too.
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        // 日/周/月/年切换走交叉淡入淡出，别硬切：四个视图
                        // 布局差异大，滑动式过渡反而会显得乱，淡入最稳。
                        .transition(.opacity)
                    // 还没有任何结果（缓存没读出来、第一次请求也还没回）时同样显示加载中。
                    // 以前只看 isLoading，而 .task 开跑之前那一段它还是 false，
                    // 冷启动先闪一下「今天没有事件」，几秒后日程才冒出来。
                    if showsInitialLoading {
                        // Cache miss + first fetch in flight
                        ProgressView()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Color(.systemGroupedBackground))
                            .transition(.opacity)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: mode)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: showsInitialLoading)
            }
            .animation(.snappy, value: state.accountNotice)
            .animation(.snappy, value: state.pendingAnnouncement)
            .navigationTitle(navTitle.loc)
            .navigationBarTitleDisplayMode(.inline)
            // 展开态所有按钮都进侧边栏（见 sidebar），详情页顶部
            // 不留工具栏 —— 用户原话：按钮在侧面，不是在上方。
            // 折叠 / 普通 iPhone 没有侧边栏，工具栏照旧全套。
            .toolbar { if !useSplitLayout { calendarToolbar } }
            .refreshable { await load(force: true) }
            .task {
                // On first appearance, hydrate from cache → instant render,
                // then fetch fresh. Cache hit means an old `lastSyncedAt`
                // appears in the footer until the new response replaces it.
                state.offlineSync.onReplayFinished = {
                    Task { await load(force: false) }
                }
                await loadFromCache()
                await load(force: false)
                await refreshInvitationBadge()
                startPolling()
            }
            .environment(\.timeZone, deviceTimeZone)
            .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in
                deviceTimeZone = DateFormatters.refreshDeviceTimeZone()
            }
            .onDisappear { stopPolling() }
            .onChange(of: scenePhase) { _, new in
                // Returning to foreground → refresh + restart polling.
                if new == .active {
                    deviceTimeZone = DateFormatters.refreshDeviceTimeZone()
                    Task { await load(force: false) }
                    // 回前台也是离线队列的重放触发点：后台期间攒的 /
                    // 退避到期的条目在这里续推。
                    Task { await state.offlineSync.replay() }
                    startPolling()
                } else {
                    stopPolling()
                }
            }
            // APNs silent push from the server posts this notification.
            // We reload immediately so the UI reflects whatever changed
            // on the server side (event created on another device, etc.).
            .onReceive(NotificationCenter.default.publisher(for: .bwcRemoteDataChanged)) { note in
                Task { await load(force: true) }
                // A push that carries an invitation routes straight to
                // that invitation's respond screen.
                if let userInfo = note.userInfo,
                   let token = InvitationPushRouting.token(from: userInfo) {
                    invitationOpenToken = token
                    showingInvitations = true
                }
                Task { await refreshInvitationBadge() }
            }
            // Deep link bywave://invitations/<token> is consumed by
            // MainTabView (switches to the invitations tab) — not here:
            // the invitations sheet in this view is only for the
            // toolbar / sidebar buttons and the push route below.
            .sheet(isPresented: $showingInvitations, onDismiss: {
                invitationOpenToken = nil
                Task { await refreshInvitationBadge() }
            }) {
                InvitationsView(openToken: invitationOpenToken)
                    .environmentObject(state)
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
    }

    @ToolbarContentBuilder
    private var calendarToolbar: some ToolbarContent {
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
        // 搜索是独立顶栏按钮（和 Android 顶栏、桌面工具栏一致的一级入口），
        // 不再埋在筛选菜单里 —— 之前用户得先点开筛选图标才找得到搜索。
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showingSearch = true
            } label: {
                Image(systemName: "magnifyingglass")
            }
            .accessibilityLabel(Text("搜索"))
        }
        // 我收到的邀请：一级入口，徽章是还没回应的邀请数（和 Android
        // 顶栏、桌面工具栏同一个位置口径）。
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                invitationOpenToken = nil
                showingInvitations = true
            } label: {
                Image(systemName: "envelope")
                    .overlay(alignment: .topTrailing) {
                        if pendingInvitationCount > 0 {
                            Text("\(pendingInvitationCount)")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.red))
                                .offset(x: 8, y: -6)
                        }
                    }
            }
            .accessibilityLabel(Text("我收到的邀请"))
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
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
                Button {
                    showingImportPicker = true
                } label: { Label("导入 .ics 文件", systemImage: "square.and.arrow.down") }
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

    /// ‹ 日期 › 这一行。紧凑态排在分段控件下面（navBar 里）；
    /// 展开态出现在侧边栏顶部，同一份实现两边共用。
    private var dateNavRow: some View {
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
            // 日视图样式切换（单日 / 多日 / 列表）：苹果把这个
            // 菜单放在日视图右上角，这里跟在日期行尾，两边
            // （紧凑态日期行、展开态侧边栏顶部）共用同一处。
            if mode == .day {
                Menu {
                    Picker("日视图样式", selection: $dayViewMode) {
                        ForEach(DayViewMode.allCases, id: \.self) { m in
                            Label(m.title, systemImage: m.symbol).tag(m)
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    Image(systemName: dayViewMode.symbol)
                }
                .accessibilityLabel(Text("日视图样式"))
            }
        }
    }

    /// 农历只在 App 语言为中文时显示（苹果那边也是开了中国
    /// 日历才有）。语言切换要重启 App 才生效，这里直接读
    /// 当前值即可，不需要观察变化。
    private var showsLunarCalendar: Bool {
        let picked = LocaleManager.shared.current
        if !picked.isEmpty { return picked.hasPrefix("zh") }
        return Locale.current.language.languageCode?.identifier == "zh"
    }

    /// 紧凑态日视图顶部的一周条（学苹果日历的布局与逻辑）：
    /// 星期、日期、农历日三行一列一天；点哪天锚点跳到哪天；
    /// 今天红字，选中日品牌色实心圈；整条下面居中是选中日的
    /// 农历全称（干支年 + 月 + 日）。
    private var dayWeekStrip: some View {
        let cal = Calendar.current
        let start = startOfWeek(anchor)
        return VStack(spacing: 2) {
            HStack(spacing: 0) {
                ForEach(0..<7, id: \.self) { i in
                    let day = cal.date(byAdding: .day, value: i, to: start) ?? start
                    let selected = cal.isDate(day, inSameDayAs: anchor)
                    let today = cal.isDateInToday(day)
                    Button {
                        anchor = cal.startOfDay(for: day)
                    } label: {
                        VStack(spacing: 1) {
                            Text(weekdaySymbol(for: day, calendar: cal))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("\(cal.component(.day, from: day))")
                                .font(.callout.weight(selected || today ? .semibold : .regular))
                                .foregroundStyle(selected ? Color.white : (today ? Color.red : Color.primary))
                                .frame(width: 34, height: 34)
                                .background {
                                    if selected { Circle().fill(state.themeAccent) }
                                }
                            if showsLunarCalendar {
                                Text(LunarDate.dayName(for: day))
                                    .font(.system(size: 9))
                                    .foregroundStyle(today && !selected ? Color.red : Color.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            if showsLunarCalendar {
                Text(LunarDate.fullDate(for: anchor))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 2)
    }

    private func weekdaySymbol(for day: Date, calendar cal: Calendar) -> String {
        let symbols = cal.veryShortStandaloneWeekdaySymbols
        let weekday = cal.component(.weekday, from: day)
        return (1...7).contains(weekday) && symbols.count == 7 ? symbols[weekday - 1] : ""
    }

    // MARK: - 展开态侧边栏（regular 宽度）

    /// 展开态的家：视图切换、日期导航、迷你月历、日历显示开关和
    /// 常用入口都在这里，内容区只放日历主体。全部用系统 List /
    /// Picker / Toggle，不自绘控件；绑定的都是本视图自己的
    /// @State 与 AppState，折叠回去时紧凑布局读的是同一份状态。
    private var sidebar: some View {
        List {
            Section {
                Picker("视图", selection: $mode) {
                    ForEach(ViewMode.allCases) { Text($0.rawValue.loc).tag($0) }
                }
                .pickerStyle(.segmented)
                dateNavRow
            }
            Section {
                MiniMonthView(anchor: anchor) { day in
                    anchor = Calendar.current.startOfDay(for: day)
                }
                .listRowInsets(EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14))
            }
            Section {
                ForEach(calendars) { cal in
                    Toggle(isOn: sidebarVisibilityBinding(for: cal.id)) {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(Color(hex: cal.color) ?? .accentColor)
                                .frame(width: 12, height: 12)
                            Text(cal.name).lineLimit(1)
                        }
                    }
                }
                if !state.hiddenCalendarIds.isEmpty {
                    Button("全部显示") { state.hiddenCalendarIds.removeAll() }
                }
            } header: {
                Text("显示的日历")
            }
            Section {
                Button {
                    showingCreate = true
                } label: {
                    Label("新建事件", systemImage: "plus")
                }
                .disabled(calendars.isEmpty)
                Button {
                    showingSearch = true
                } label: {
                    Label("搜索", systemImage: "magnifyingglass")
                }
                Button {
                    invitationOpenToken = nil
                    showingInvitations = true
                } label: {
                    HStack {
                        Label("我收到的邀请", systemImage: "envelope")
                        if pendingInvitationCount > 0 {
                            Spacer()
                            Text("\(pendingInvitationCount)")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.red))
                        }
                    }
                }
                Button {
                    showingProfileSwitcher = true
                } label: {
                    Label("切换账号", systemImage: "person.crop.circle")
                }
                Button {
                    showingSettings = true
                } label: {
                    Label("设置", systemImage: "gearshape")
                }
                // 顶栏菜单里剩下的两件也搬进侧边栏：展开态顶部
                // 一个按钮都不留，功能不能跟着工具栏一起消失。
                Button {
                    Task { await load(force: true) }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(isLoading)
                Button {
                    showingImportPicker = true
                } label: {
                    Label("导入 .ics 文件", systemImage: "square.and.arrow.down")
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle(navTitle.loc)
    }

    /// 与筛选日历页同一个绑定口径：Toggle 的 on = 不在 hidden 集合里。
    /// 两边写的是同一份 AppState.hiddenCalendarIds，改哪边都即时
    /// 反映到另一边和日历主体。
    private func sidebarVisibilityBinding(for id: String) -> Binding<Bool> {
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

    // MARK: - Header (mode picker + nav arrows + anchor date)
    private var navBar: some View {
        VStack(spacing: 6) {
            // 展开态这两组控件在侧边栏里，内容区顶部只留同步/错误状态行。
            if !useSplitLayout {
                Picker("视图", selection: $mode) {
                    ForEach(ViewMode.allCases) { Text($0.rawValue.loc).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14)
            }

            if !useSplitLayout {
                dateNavRow
                    .padding(.horizontal, 14)
                    .padding(.bottom, 4)
            }

            // 紧凑态日视图的一周条；展开态有侧边栏迷你月历，
            // 不重复放（实现见 dayWeekStrip）。
            if !useSplitLayout && mode == .day {
                dayWeekStrip
                    .padding(.bottom, 4)
            }

            // 错误独立一行，且优先于「X 分钟前同步」。
            //
            // 以前这两个是 if / else-if：只要同步成功过一次（或读到过磁盘缓存），
            // lastSyncedAt 就不为 nil，错误提示**永远渲染不出来**。后果是
            // 同步一直在后台静默失败，而界面上只有一个慢慢变大的「X 分钟前同步」
            // ——用户完全看不出坏了。
            if let err = errorMessage {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.circle.fill")
                    Text(err)
                }
                .font(.caption2)
                .foregroundStyle(.red)
                .padding(.horizontal, 14)
                .multilineTextAlignment(.center)
            }
            if let synced = lastSyncedAt {
                Text(syncedLabel(for: synced))
                    .font(.caption2).foregroundStyle(.tertiary)
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
            // 「日」的三种形态和苹果日历的日视图菜单对齐：单日
            // 时间轴（默认）/ 多日时间轴 / 列表。时间轴是同一套
            // WeekView 网格只改列数；列表即原来的 DayView 议程。
            switch dayViewMode {
            case .single, .multi:
                WeekView(
                    weekStart: Calendar.current.startOfDay(for: anchor),
                    events: visibleEvents,
                    calendars: calendars,
                    onEventChanged: { Task { await load(force: true) } },
                    dayCount: dayViewMode == .single ? 1 : 3,
                )
            case .list:
                DayView(
                    anchor: anchor,
                    events: eventsForDay(anchor),
                    calendars: calendars,
                    onEventChanged: { Task { await load(force: true) } },
                )
            }
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
        // 全天事件不能按本地时刻比：它存的是 UTC 午夜，东八区里一个
        // 「9 月 21 日」的全天事件会同时落进 21 日和 22 日的日视图。见 AllDayDates。
        let cal = Calendar.current
        return state.visibleEvents(events)
            .filter { AllDayDates.occupies($0, localDay: day, calendar: cal) }
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

    /// 「已创建」条里点「打开」时要展示详情的事件。
    @State private var createdDetailEvent: EventDTO?
    @State private var undoingCreated = false

    /// 一句话直接保存后的「已创建「X」」条：打开看详情，或撤销这次
    /// 创建。撤销走整事件删除，删完由 undoDeleteBar 接力给恢复入口
    /// （同一条既有链）。5 秒自动消失，token 守卫同 undoDeleteBar。
    @ViewBuilder
    private var createdBar: some View {
        if let pending = state.pendingQuickCreated {
            HStack(spacing: 12) {
                Text("已创建「%@」".locFormat(pending.event.summary))
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    createdDetailEvent = pending.event
                    withAnimation { state.clearQuickCreated() }
                } label: {
                    Text("打开").font(.subheadline.weight(.semibold))
                }
                Button {
                    Task { await undoCreated(pending) }
                } label: {
                    if undoingCreated {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("撤销").font(.subheadline.weight(.semibold))
                    }
                }
                .disabled(undoingCreated)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: pending.token) {
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                if state.pendingQuickCreated?.token == pending.token {
                    withAnimation { state.clearQuickCreated() }
                }
            }
        }
    }

    private func undoCreated(_ pending: AppState.PendingQuickCreated) async {
        undoingCreated = true
        defer { undoingCreated = false }
        // 走离线队列：这个事件若是离线建的、还没同步出去，队列合并
        // 会把「建」和这条「删」直接抵消，服务端根本不会见到它；
        // 已同步的则正常排一条删除重放。
        state.offlineSync.enqueueDelete(
            eventId: pending.event.id, scope: nil, recurrenceId: nil,
            snapshot: [pending.event], summary: pending.event.summary,
        )
        await state.offlineSync.replay()
        withAnimation { state.clearQuickCreated() }
        // 删除已在本地生效 → 既有撤销删除条接力（可恢复）。
        state.noteEventDeleted(id: pending.event.id, summary: pending.event.summary)
        // 这里不给触觉：触觉定版口径只给正向确认（保存成功、
        // RSVP、清单勾选），删除与撤销一律不震。
        await load(force: true)
    }

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
        // 删除若还躺在离线队列里（没网删的），直接抵消条目、把快照行
        // 放回去就行，不需要网络；已经同步出去的才走服务端 restore。
        if let restored = state.offlineSync.cancelPendingDelete(eventId: pending.eventId) {
            let existing = Set(events.map { "\($0.id)|\($0.startsAt)" })
            events += restored.filter { !existing.contains("\($0.id)|\($0.startsAt)") }
            events.sort { $0.startsAt < $1.startsAt }
            withAnimation { state.pendingUndoDelete = nil }
            // 撤销删除不给触觉（定版口径：删除/撤销不震），
            // 两个恢复分支保持一致。
            await load(force: true)
            return
        }
        do {
            try await APIClient(state: state).restoreEvent(id: pending.eventId)
            withAnimation { state.pendingUndoDelete = nil }
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
            // 缓存里存的是上次展示的那一份；再套一次队列合并（幂等）
            // 是为了把「缓存写入之后才入队」的改动也算进来。
            self.events = state.offlineSync.overlay(payload.events)
            self.calendars = payload.calendars
            self.lastSyncedAt = payload.cachedAt
        }
    }

    /// /events 窗口的 ETag 存档键（UserDefaults）：离线缓存键（服务器 +
    /// 账号）再加上窗口起止。少了窗口这一维，就会拿着 A 窗口的令牌去
    /// 问 B 窗口、换回一个假的 304 把 B 窗口的新数据挡在门外。
    private func eventsETagKey(from: Date, to: Date) -> String {
        let key = EventCache.shared.key(serverURL: state.serverURL ?? URL(string: "http://nil")!, userEmail: state.currentUserEmail)
        return "bwc.eventsETag.\(key).\(DateFormatters.isoPlain.string(from: from)).\(DateFormatters.isoPlain.string(from: to))"
    }

    /// /invitations 的 ETag 存档键（UserDefaults）：和 /events 窗口同一
    /// 套分键（服务器 + 账号），只是没有窗口这一维 —— 邀请列表不分窗。
    private func invitationsETagKey() -> String {
        let key = EventCache.shared.key(serverURL: state.serverURL ?? URL(string: "http://nil")!, userEmail: state.currentUserEmail)
        return "bwc.invitationsETag.\(key)"
    }

    /// /events/sync 的同步存档键（UserDefaults）：令牌与它的窗口基线
    /// 分开两键存、一起读一起写——令牌只对它签发时那个窗口的本地
    /// 镜像有效，窗口对不上就当没有令牌（走全量重建基线），和 Web
    /// syncPlan 的基线语义一致。分键方式与 ETag 存档相同（服务器 +
    /// 账号），登出时由 AppState.retireCredentials 一并清掉。
    private func eventsSyncTokenKey() -> String {
        let key = EventCache.shared.key(serverURL: state.serverURL ?? URL(string: "http://nil")!, userEmail: state.currentUserEmail)
        return "bwc.eventsSyncToken.\(key)"
    }

    private func eventsSyncWindowKey() -> String {
        let key = EventCache.shared.key(serverURL: state.serverURL ?? URL(string: "http://nil")!, userEmail: state.currentUserEmail)
        return "bwc.eventsSyncWindow.\(key)"
    }

    /// 窗口基线串：与请求路径同一种格式化（isoPlain），存档与请求
    /// 永远同源，不会出现「格式差一点、基线永远对不上」。
    private func syncWindowBaseline(from: Date, to: Date) -> String {
        "\(DateFormatters.isoPlain.string(from: from))|\(DateFormatters.isoPlain.string(from: to))"
    }

    /// 取这个窗口基线的令牌：基线对不上（窗口变了）返回 nil，调用方
    /// 按「没有令牌」走全量同步、重建基线。
    private func storedSyncToken(forBaseline baseline: String) -> String? {
        guard UserDefaults.standard.string(forKey: eventsSyncWindowKey()) == baseline else { return nil }
        return UserDefaults.standard.string(forKey: eventsSyncTokenKey())
    }

    private func saveSyncState(token: String, baseline: String) {
        UserDefaults.standard.set(token, forKey: eventsSyncTokenKey())
        UserDefaults.standard.set(baseline, forKey: eventsSyncWindowKey())
    }

    private func clearSyncState() {
        UserDefaults.standard.removeObject(forKey: eventsSyncTokenKey())
        UserDefaults.standard.removeObject(forKey: eventsSyncWindowKey())
    }

    /// 邀请徽章数：还没回应的、事件没取消、邀请没过期的条数。拉不到
    /// 就保持原值 —— 徽章是提示性的，失败必须静默。
    /// 走条件请求：没新邀请、没人回应时服务端回 304，整表不下载、
    /// 不解码，徽章保持原值 —— 这正是 304 在这里想要的语义。
    private func refreshInvitationBadge() async {
        do {
            let etagKey = invitationsETagKey()
            let (fetched, newETag) = try await APIClient(state: state).getInvitationsConditional(
                ifNoneMatch: UserDefaults.standard.string(forKey: etagKey))
            guard let invitations = fetched else { return }
            if let newETag { UserDefaults.standard.set(newETag, forKey: etagKey) }
            let now = Date()
            pendingInvitationCount = invitations.filter { inv in
                guard inv.responseStatus == "pending", !inv.event.cancelled else { return false }
                if let expiry = InvitationTimeText.parse(inv.expiresAt) {
                    return expiry > now
                }
                return true
            }.count
            // 镜像一份到 AppState：标签栏的邀请角标读它，刷新逻辑
            // 仍然只有这一份。
            state.pendingInvitationCount = pendingInvitationCount
        } catch {
            // keep the previous count
        }
    }

    /// 一次窗口拉取的结局。events 是服务端底稿行（还没套离线队列的
    /// 展示合并）；syncState 是这次拉取换来的新同步存档——**只在结果
    /// 真正落进本地集之后才由 load() 写入**：令牌要是先存下、结果却
    /// 被账号切换 / 新一代加载丢掉，令牌就越过了没被应用的那批变化，
    /// 它们再也不会被增量带回来（ETag 没有这个坑，304 顶多让人多等
    /// 一次内容变化；syncToken 越过就是永久漏数据）。
    private enum WindowLoadOutcome {
        case unchanged
        case events(calendars: [CalendarMeta], events: [EventDTO], syncState: (token: String, baseline: String)?)
    }

    /// 窗口拉取：先走 /events/sync（有基线令牌走增量、没有走全量），
    /// 同步通道任何非 410 失败都清掉同步存档、回退到原来的 ETag
    /// 条件请求全量路径——同步挂掉不能把日历也拖挂。410 只出现在
    /// 增量路径上（令牌解不开 / 已被服务端日志裁剪）：清存档后无
    /// 令牌全量重建一次，重建再失败同样回退旧路径，不连环重试。
    private func fetchWindow(client: APIClient, from: Date, to: Date, legacyPath: String) async throws -> WindowLoadOutcome {
        let fromIso = DateFormatters.isoPlain.string(from: from)
        let toIso = DateFormatters.isoPlain.string(from: to)
        let baseline = syncWindowBaseline(from: from, to: to)
        if let token = storedSyncToken(forBaseline: baseline) {
            do {
                let delta = try await client.getEventsSync(from: fromIso, to: toIso, syncToken: token)
                // 增量套到本地集（展示集口径）：没被队列碰过的母事件，
                // 展示行与服务端镜像行是同一批，整组替换等价；被队列
                // 占住的母事件整组跳过，本地版本原样留着。
                let merged = EventSyncLogic.applyDelta(
                    local: self.events,
                    upsertedIds: delta.upsertedIds ?? [],
                    deletedIds: delta.deletedIds ?? [],
                    incoming: delta.events,
                    visibleCalendarIds: Set(delta.calendars.map { $0.id }),
                    protectedIds: state.offlineSync.pendingIds,
                )
                return .events(calendars: delta.calendars, events: merged, syncState: (token: delta.nextSyncToken, baseline: baseline))
            } catch is CancellationError {
                // 账号在请求途中换了 / 视图正在撤下：不是同步失败，
                // 存档别动，原样往上抛给 load() 的取消分支。
                throw CancellationError()
            } catch let e as APIError {
                clearSyncState()
                if case .server(let status, _) = e, status == 410 {
                    // 令牌过期：本地服务端镜像按令牌那一代算已经不可信，
                    // 无令牌全量重建（本地未同步写入靠 load() 之后的
                    // overlay 保住，不会跟着镜像一起丢）。只试这一次。
                    if let full = try? await client.getEventsSync(from: fromIso, to: toIso, syncToken: nil) {
                        return .events(calendars: full.calendars, events: full.events, syncState: (token: full.nextSyncToken, baseline: baseline))
                    }
                }
            } catch {
                clearSyncState()
            }
        } else if let full = try? await client.getEventsSync(from: fromIso, to: toIso, syncToken: nil) {
            // 没有基线令牌（首次 / 窗口变了 / 存档被清）：全量同步，
            // 顺带把基线立到这个窗口上。
            return .events(calendars: full.calendars, events: full.events, syncState: (token: full.nextSyncToken, baseline: baseline))
        } else {
            clearSyncState()
        }
        // 回退：原来的 ETag 条件请求全量路径，一字不改。
        let etagKey = eventsETagKey(from: from, to: to)
        let (fetched, newETag) = try await client.getEventsConditional(
            path: legacyPath, ifNoneMatch: UserDefaults.standard.string(forKey: etagKey))
        guard let resp = fetched else { return .unchanged }
        if let newETag { UserDefaults.standard.set(newETag, forKey: etagKey) }
        return .events(calendars: resp.calendars, events: resp.events, syncState: nil)
    }

    // MARK: - Fetch
    private func load(force: Bool) async {
        // De-duplicate concurrent loads (polling + manual refresh racing).
        if isLoading && !force { return }
        loadGeneration += 1
        let generation = loadGeneration
        let (from, to) = currentWindow()
        isLoading = true
        errorMessage = nil
        defer { if generation == loadGeneration { isLoading = false } }
        // 注意：lastFetchedWindow 只在**请求成功之后**才记录（见下面成功分支）。
        //
        // 以前是在这里、发请求之前就记上的。于是一旦这次加载失败，这个窗口
        // 就被永久标记成「已取过」，再也不会重试——用户翻到那个月看到的是
        // 「没有任何安排」，而不是「加载失败」。他会真的以为自己那个月没事，
        // 可能因此错过安排。

        // Use the cached ISO8601 formatter — was creating a new one
        // per request, ~1ms overhead each. Tiny but cumulative under
        // swipe-spam.
        let path = "/events?from=\(DateFormatters.isoPlain.string(from: from).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)&to=\(DateFormatters.isoPlain.string(from: to).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)"

        // 这次加载是替哪个账号取的。下面每个 await 之后都可能已经换了账号
        // （切账号、被服务端登出后自动切走、移除账号）；
        // 缓存键、提醒、系统日历镜像要是在 await 之后才去读「当前账号」，
        // 上一个账号的日程就会写进下一个账号的离线缓存、按下一个账号的名义排提醒。
        let loadingProfileId = state.activeProfileId

        do {
            let client = APIClient(state: state)
            // 拉取通道在 fetchWindow 里：增量同步（/events/sync）优先，
            // 同步通道失败回退 ETag 条件请求全量。两条路的结局在这里
            // 汇成同一份处理——排序、展示合并、缓存、镜像、提醒重排
            // 都不分岔。unchanged 只来自旧路径的 304：服务端窗口没变，
            // 整个窗口的下载、解码、缓存重写全部跳过，15 秒一次的
            // 轮询绝大多数时候就该是这个结局（增量路径同理，没变化时
            // 响应里只有空名单和新令牌）。
            let outcome = try await fetchWindow(client: client, from: from, to: to, legacyPath: path)
            guard case .events(let outcomeCalendars, let outcomeEvents, let syncState) = outcome else {
                guard !Task.isCancelled, generation == loadGeneration, state.isSignedIn, state.activeProfileId == loadingProfileId else { return }
                // 304 = 服务端窗口没变，但本地队列可能刚有新条目
                //（刚在详情页删了事件）：把队列合并重新套到现集上，
                // 不然被删的事件要等下一次内容变化才消失。
                self.events = state.offlineSync.overlay(self.events)
                self.lastSyncedAt = Date()
                self.lastFetchedWindow = (start: from, end: to)
                return
            }
            let resp = EventsResponse(calendars: outcomeCalendars, events: outcomeEvents)
            // Sort off the main actor before publishing. With a 12-month
            // pre-cache (incoming v1.0.x feature), the event count can
            // hit a few thousand — sorting 3000 elements on main was
            // ~30ms hitch. Detached task lets the main thread keep
            // rendering while we sort.
            let sortedEvents = await Task.detached(priority: .userInitiated) {
                resp.events.sorted { $0.startsAt < $1.startsAt }
            }.value
            // 账号已经换了（或已退出）：这份数据不属于现在的账号，整个丢掉。
            // 这个视图本身也马上会被 RootView 按新账号重新挂载。
            guard !Task.isCancelled, generation == loadGeneration, state.isSignedIn, state.activeProfileId == loadingProfileId else { return }
            // 结果确认要落进本地集了，才把新同步令牌存档（见
            // WindowLoadOutcome 的注释：先存令牌、结果被丢掉 =
            // 令牌越过没被应用的变化，永久漏数据）。
            if let syncState { saveSyncState(token: syncState.token, baseline: syncState.baseline) }
            self.calendars = resp.calendars
            // 服务端窗口是权威底稿，但还没同步出去的本地改动不能被
            // 这次替换冲掉：待删的剔除、待改的套用、待建的保留
            //（OfflineSync 的展示合并，幂等）。缓存里也存合并后的
            // 这一份，和用户刚看到的保持一致。
            let displayEvents = state.offlineSync.overlay(sortedEvents)
            self.events = displayEvents
            self.lastSyncedAt = Date()
            // 取到了才算这个窗口覆盖过——失败的窗口要能被重试。
            self.lastFetchedWindow = (start: from, end: to)
            // Persist to disk async — EventCache.write returns immediately
            // (enqueues on its background queue), so no UI hitch.
            let payload = EventCachePayload(
                events: displayEvents,
                calendars: resp.calendars,
                cachedAt: Date(),
                windowStart: from,
                windowEnd: to,
            )
            let key = EventCache.shared.key(serverURL: state.serverURL ?? URL(string: "http://nil")!, userEmail: state.currentUserEmail)
            EventCache.shared.write(key: key, payload: payload)
            // Fire EventKit mirror (no-op if disabled / no permission).
            Task {
                guard generation == loadGeneration, state.isSignedIn, state.activeProfileId == loadingProfileId, let profileID = loadingProfileId else { return }
                await EventKitMirror.shared.mirror(events: displayEvents, windowStart: from, windowEnd: to, selectedCalendarIDs: EventKitMirror.shared.selectedCalendars(profileID: profileID))
            }
            // Re-schedule local notifications. No-op when feature disabled
            // or permission denied. Always uses the full event set so
            // reminders for events outside the current view window still
            // queue up. We only re-schedule on substantial loads (day view
            // fetches just one day → we'd lose the rest); skip when the
            // window is < 2 days to avoid clearing the long-range schedule.
            let windowDays = Calendar.current.dateComponents([.day], from: from, to: to).day ?? 0
            if windowDays >= 2, let profileId = state.activeProfileId {
                // 只给**看得见**的日历排提醒。以前传的是全部事件，于是用户在
                // 「筛选日历」里隐藏掉的日历，界面上看不见了、到点照样弹 ——
                // 而他关掉它正是因为不想再被它打扰。
                let scheduled = state.visibleEvents(displayEvents)
                Task {
                    await LocalNotifications.shared.reschedule(
                        profileId: profileId, events: scheduled, calendars: resp.calendars)
                }
            }
            // 拉取成功 = 网络是通的：顺手把离线队列推一轮（回前台 /
            // 轮询的兜底触发点之一）。有条目落定时 onReplayFinished
            // 会再触发一次加载，把本地临时行换成服务端真实行。
            Task { await state.offlineSync.replay() }
        } catch let e as APIError {
            // 加载失败也要把队列合并套到现集上：离线删掉/改掉的事件
            // 不能因为这次拉取失败就弹回原样（合并幂等，重复套无妨）。
            if generation == loadGeneration, state.activeProfileId == loadingProfileId {
                self.events = state.offlineSync.overlay(self.events)
            }
            errorMessage = e.localizedDescription
        } catch is CancellationError {
            // 账号在请求途中换了（AppState.refreshIfNeeded 丢掉了上一个账号的令牌），
            // 或者视图正在被撤下。不是错误，别在界面上写一行看不懂的英文。
        } catch {
            guard generation == loadGeneration, !Task.isCancelled, state.activeProfileId == loadingProfileId else { return }
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
                try? await Task.sleep(nanoseconds: 15 * 1_000_000_000)
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

/// 「某个账号被服务端登出、已经换到另一个账号」的提示条。
///
/// 被登出的是谁、为什么、现在用的是谁，三样都写出来 —— 悄悄换过去的话，
/// 用户会以为自己还在原来那个账号里。不自动消失，点 × 才关。
private struct AccountNoticeBanner: View {
    let notice: AccountNotice
    let current: Profile
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text("%@ 已被登出".locFormat(labels.gone))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text("密码已更改或此设备已被移除。现在使用的是 %@。".locFormat(labels.now))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            Spacer(minLength: 4)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("关闭"))
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.orange.opacity(0.4), lineWidth: 0.5),
        )
        .frame(maxWidth: 560)
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity)
        .background(Color(.systemBackground))
    }

    /// 两个账号邮箱一样（在不同服务器上）时只写邮箱分不出谁是谁，补上服务器。
    private var labels: (gone: String, now: String) {
        let gone = notice.accountLabel
        let now = current.displayLabel
        guard gone == now else { return (gone, now) }
        return ("\(gone) · \(notice.accountHost)", "\(now) · \(current.displaySubtitle)")
    }
}

/// 服务端公告的横幅。标题 / 正文是管理员在后台写的原文（跟着后台的
/// 语言走，不走本地化）；本地只提供「去更新」和关闭。标题为空时用
/// 本地化的默认标题兜底，正文为空就只显示标题一行。
private struct AnnouncementBanner: View {
    let announcement: IosAnnouncement
    let onDismiss: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrow.down.circle.fill")
                .foregroundStyle(Theme.brandStart)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(announcement.title.isEmpty ? "announcement.defaultTitle".loc : announcement.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                if !announcement.body.isEmpty {
                    Text(announcement.body)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Button {
                    openURL(announcement.effectiveStoreURL)
                } label: {
                    Text("announcement.updateNow".loc)
                        .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            Spacer(minLength: 4)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("关闭"))
        }
        .padding(12)
        .background(Theme.brandStart.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Theme.brandStart.opacity(0.35), lineWidth: 0.5),
        )
        .frame(maxWidth: 560)
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity)
        .background(Color(.systemBackground))
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

/// 侧边栏里的迷你月历：显示锚点所在的月，点某天把锚点跳过去
/// （视图模式不变，四个视图都以锚点为准）。不复用 MonthView——
/// 那是整屏视图（事件行 + 点选弹层），塞不进侧边栏；这里只做
/// 日期格本身，日期数学与 MonthView 同一套：公历、周一开头、
/// 星期符号跟随应用语言。今天与锚点的标记法也与周视图的
/// DayHeader 一致（今天 = 品牌色实心圆，锚点 = 淡填充圆）。
private struct MiniMonthView: View {
    let anchor: Date
    let onSelect: (Date) -> Void

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2  // Monday-first to match the rest of the app
        c.locale = Locale.current
        return c
    }()

    private var monthStart: Date {
        calendar.dateInterval(of: .month, for: anchor)?.start ?? anchor
    }

    private var gridStart: Date {
        // First day of the grid = Monday on or before the 1st.
        let weekday = calendar.component(.weekday, from: monthStart)
        let daysSinceMonday = (weekday + 5) % 7
        return calendar.date(byAdding: .day, value: -daysSinceMonday, to: monthStart) ?? monthStart
    }

    private var days: [Date] {
        (0..<42).compactMap { calendar.date(byAdding: .day, value: $0, to: gridStart) }
    }

    private var monthTitle: String {
        let f = DateFormatter()
        f.locale = Locale.current
        f.setLocalizedDateFormatFromTemplate("yMMMM")
        return f.string(from: anchor)
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text(monthTitle)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    onSelect(Date())
                } label: {
                    Text("今天").font(.caption.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
            HStack(spacing: 0) {
                ForEach(Array(Self.weekdaySymbols.enumerated()), id: \.offset) { _, symbol in
                    Text(symbol)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7),
                spacing: 2,
            ) {
                ForEach(days, id: \.self) { day in
                    dayCell(day)
                }
            }
        }
    }

    private func dayCell(_ day: Date) -> some View {
        let isToday = calendar.isDateInToday(day)
        let isAnchor = calendar.isDate(day, inSameDayAs: anchor)
        let inMonth = calendar.isDate(day, equalTo: anchor, toGranularity: .month)
        return Button {
            onSelect(day)
        } label: {
            Text("\(calendar.component(.day, from: day))")
                .font(.caption.weight(isToday || isAnchor ? .bold : .regular))
                .frame(width: 26, height: 26)
                .background(cellBackground(isToday: isToday, isAnchor: isAnchor), in: Circle())
                .foregroundStyle(cellForeground(isToday: isToday, inMonth: inMonth))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    private func cellBackground(isToday: Bool, isAnchor: Bool) -> Color {
        if isToday { return .accentColor }
        if isAnchor { return Color.secondary.opacity(0.22) }
        return .clear
    }

    private func cellForeground(isToday: Bool, inMonth: Bool) -> Color {
        if isToday { return .white }
        return inMonth ? .primary : Color(.tertiaryLabel)
    }

    /// `veryShortWeekdaySymbols` is Sunday-first; rotate so Monday
    /// leads, same derivation as MonthView's header.
    private static var weekdaySymbols: [String] {
        var cal = Calendar.current
        cal.locale = Locale(identifier: Bundle.main.preferredLocalizations.first ?? "zh-Hans")
        let symbols = cal.veryShortWeekdaySymbols  // [Sun, Mon, ..., Sat]
        return Array(symbols[1...]) + symbols[0...0]  // [Mon, ..., Sat, Sun]
    }
}
