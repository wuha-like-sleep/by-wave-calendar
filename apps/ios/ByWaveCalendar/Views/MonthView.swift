// MonthView.swift
// Classic 7×6 month grid. Each cell = date number + up to 3 dots (one per
// event) + a "+N more" indicator. Tapping a day opens a sheet showing
// that day's events (reuses DayView).
//
// Layout:
//   - Top row of weekday labels (一 二 三 四 五 六 日)
//   - 6 rows × 7 cols of day cells (fills out adjacent-month padding)
//   - Tap any cell → bottom-sheet DayView for that day

import SwiftUI

struct MonthView: View {
    let monthAnchor: Date    // any date in the target month
    let events: [EventDTO]
    let calendars: [CalendarMeta]
    let onEventChanged: () -> Void

    private struct DaySelection: Identifiable {
        let date: Date
        var id: Date { date }
    }

    @State private var selectedDay: DaySelection?
    @ScaledMetric(relativeTo: .callout) private var dateBadgeSize: CGFloat = 24
    @ScaledMetric(relativeTo: .caption2) private var eventFontSize: CGFloat = 11
    @ScaledMetric(relativeTo: .caption2) private var eventLineHeight: CGFloat = 14

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2  // Monday-first to match the web
        // Grid math uses the explicit firstWeekday above; the locale only
        // feeds any symbol lookups, so it must follow the app language
        // (was hardcoded zh_CN → leaked Chinese in non-zh UI).
        c.locale = Locale.current
        return c
    }()

    private var monthStart: Date {
        calendar.dateInterval(of: .month, for: monthAnchor)?.start ?? monthAnchor
    }

    private var gridStart: Date {
        // First day of the grid = Monday on or before the 1st of the month.
        let comps = calendar.dateComponents([.year, .month], from: monthAnchor)
        guard let first = calendar.date(from: comps) else { return monthAnchor }
        let weekday = calendar.component(.weekday, from: first)
        // weekday: 1=Sun, 2=Mon, ..., 7=Sat. Convert to "days since Monday".
        let daysSinceMonday = (weekday + 5) % 7
        return calendar.date(byAdding: .day, value: -daysSinceMonday, to: first) ?? first
    }

    private var days: [Date] {
        (0..<42).compactMap { calendar.date(byAdding: .day, value: $0, to: gridStart) }
    }

    private var eventsByDay: [Date: [EventDTO]] {
        // 以前是「按 startsAt 的本地当天」分一次桶，两个后果：
        // ① 全天事件存的是 UTC 午夜，UTC 以西的时区会整体归到前一天；
        // ② 跨天的事件只出现在第一格 —— 一个三天的出差，月视图上只看得到一天。
        // 现在逐格问「这个事件占不占这一天」，两件事一起解决。
        // 这份按「占不占」分的表喂的是点开某一天的日视图和长按速览：
        // 它们要按实际时段画，跨午夜事件在次日凌晨那段必须在。
        // 格子里挂的条走下面 chipEventsByDay，口径不同，别混用。
        var m = [Date: [EventDTO]]()
        for day in days {
            let list = events
                .filter { AllDayDates.occupies($0, localDay: day, calendar: calendar) }
                .sorted { $0.startsAt < $1.startsAt }
            if !list.isEmpty { m[calendar.startOfDay(for: day)] = list }
        }
        return m
    }

    /// 格子里实际挂的条：全天事件挂它占的每一格，定时事件只挂
    /// 开始日一格（见 AllDayDates.showsInMonthCell）。跨午夜的
    /// 定时事件若在次日格子里再挂一条，看起来像重复事件。
    private var chipEventsByDay: [Date: [EventDTO]] {
        var m = [Date: [EventDTO]]()
        for day in days {
            let list = events
                .filter { AllDayDates.showsInMonthCell($0, localDay: day, calendar: calendar) }
                .sorted { $0.startsAt < $1.startsAt }
            if !list.isEmpty { m[calendar.startOfDay(for: day)] = list }
        }
        return m
    }

    /// 网格两侧的留白。以前是 0，日期数字直接顶在屏幕边缘，
    /// 「今天」那个圆圈几乎被屏幕圆角切到。
    private let sideInset: CGFloat = 6

    var body: some View {
        VStack(spacing: 0) {
            weekdayHeader
            GeometryReader { geo in
                let cellW = geo.size.width / 7
                // Keep all six weeks reachable when landscape or Dynamic Type
                // leaves too little height. Each day remains a usable tap target.
                let cellH = max(geo.size.height / 6, max(44, dateBadgeSize + eventLineHeight + 12))
                let occupied = eventsByDay
                let chips = chipEventsByDay
                ScrollView(.vertical) {
                    LazyVGrid(columns: Array(repeating: GridItem(.fixed(cellW), spacing: 0), count: 7), spacing: 0) {
                        ForEach(days, id: \.self) { day in
                            let dayEvents = occupied[calendar.startOfDay(for: day)] ?? []
                            Button {
                                openDay(day)
                            } label: {
                                DayCell(
                                    day: day,
                                    inMonth: calendar.isDate(day, equalTo: monthAnchor, toGranularity: .month),
                                    isToday: calendar.isDateInToday(day),
                                    events: chips[calendar.startOfDay(for: day)] ?? [],
                                    calendars: calendars,
                                    width: cellW,
                                    height: cellH,
                                    dateBadgeSize: dateBadgeSize,
                                    eventFontSize: eventFontSize,
                                    eventLineHeight: eventLineHeight
                                )
                                .frame(width: cellW, height: cellH)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(day.formatted(date: .complete, time: .omitted)))
                            .accessibilityValue(Text("%lld 个事件".locFormat(dayEvents.count)))
                            .accessibilityIdentifier("month.day.\(calendar.component(.year, from: day))-\(calendar.component(.month, from: day))-\(calendar.component(.day, from: day))")
                            // Long-press a day to peek at its events without
                            // opening the sheet — quick scan + jump-to options.
                            .contextMenu {
                                ForEach(dayEvents.prefix(5)) { ev in
                                    Button {
                                        openDay(day)
                                    } label: {
                                        Text(ev.summary).lineLimit(1)
                                    }
                                }
                                if dayEvents.count > 5 {
                                    Text("还有 %lld 个…".locFormat(dayEvents.count - 5))
                                }
                                if dayEvents.isEmpty {
                                    Text("无事件").foregroundStyle(.secondary)
                                }
                                Divider()
                                Button {
                                    openDay(day)
                                } label: {
                                    Label("打开这一天", systemImage: "calendar.day.timeline.left")
                                }
                            }
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .padding(.horizontal, sideInset)
            .safeAreaPadding(.bottom)
        }
        .sheet(item: $selectedDay) { selection in
            let day = selection.date
            NavigationStack {
                DayView(
                    anchor: day,
                    events: (eventsByDay[day] ?? [])
                        .sorted { $0.startsAt < $1.startsAt },
                    calendars: calendars,
                    onEventChanged: onEventChanged
                )
                .navigationTitle(dayTitle(day))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("关闭") { selectedDay = nil }
                    }
                }
            }
        }
    }

    private func openDay(_ day: Date) {
        selectedDay = DaySelection(date: calendar.startOfDay(for: day))
    }

    private var weekdayHeader: some View {
        // Locale-aware weekday abbreviations, Monday-first to match the
        // grid. Using the current locale's `shortWeekdaySymbols` (instead
        // of a hardcoded 「一二三…日」 array) means the header follows the
        // APP language: 一二三…/Mon Tue…/Lun Mar… etc.
        let labels = Self.localizedWeekdaySymbols
        return HStack(spacing: 0) {
            ForEach(Array(labels.enumerated()), id: \.offset) { _, label in
                Text(label)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, sideInset)   // 与下面的网格列对齐
        .background(Theme.subtleSurface)
    }

    /// `shortWeekdaySymbols` is Sunday-first; rotate so Monday leads to
    /// match the Monday-first grid. Driven by the resolved bundle locale.
    private static var localizedWeekdaySymbols: [String] {
        var cal = Calendar.current
        cal.locale = Locale(identifier: Bundle.main.preferredLocalizations.first ?? "zh-Hans")
        let symbols = cal.shortWeekdaySymbols  // [Sun, Mon, ..., Sat]
        return Array(symbols[1...]) + symbols[0...0]  // [Mon, ..., Sat, Sun]
    }

    private func dayTitle(_ d: Date) -> String {
        DateFormatters.monthDay.string(from: d)
    }
}

// One cell in the month grid.
private struct DayCell: View {
    let day: Date
    let inMonth: Bool
    let isToday: Bool
    let events: [EventDTO]
    let calendars: [CalendarMeta]
    let width: CGFloat
    let height: CGFloat
    let dateBadgeSize: CGFloat
    let eventFontSize: CGFloat
    let eventLineHeight: CGFloat

    private var dayNumber: Int { Calendar.current.component(.day, from: day) }

    private var calLookup: [String: CalendarMeta] {
        Dictionary(uniqueKeysWithValues: calendars.map { ($0.id, $0) })
    }

    // Text and capacity use the same scaled metrics, so larger text removes
    // preview rows instead of clipping a date or half an event summary.
    private var eventLineCapacity: Int {
        min(3, max(0, Int((height - dateBadgeSize - 8) / (eventLineHeight + 4))))
    }

    var body: some View {
        let lines = eventLineCapacity
        let shown = events.count > lines ? max(0, lines - 1) : events.count
        let hidden = events.count - shown
        VStack(alignment: .leading, spacing: 4) {
            Text("\(dayNumber)")
                .font(.callout.weight(isToday ? .bold : .regular))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(width: max(0, min(dateBadgeSize, width - 8)), height: dateBadgeSize)
                .background(isToday ? Color.accentColor : .clear, in: Circle())
                .foregroundStyle(isToday ? Color.white : numberColor)
            if lines > 0 {
                ForEach(events.prefix(shown)) { ev in
                    HStack(spacing: 3) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(Color(hex: calLookup[ev.calendarId]?.color) ?? .accentColor)
                            .frame(width: 3, height: eventLineHeight - 2)
                        Text(ev.summary)
                            .font(.system(size: eventFontSize, weight: .medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                    }
                    .frame(height: eventLineHeight)
                }
                if hidden > 0 {
                    Text("+\(hidden)")
                        .font(.system(size: eventFontSize, weight: .medium).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .frame(height: eventLineHeight)
                }
            } else if !events.isEmpty {
                HStack(spacing: 2) {
                    ForEach(events.prefix(4)) { ev in
                        Circle()
                            .fill(Color(hex: calLookup[ev.calendarId]?.color) ?? .accentColor)
                            .frame(width: 5, height: 5)
                    }
                }
            }
        }
        .padding(4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .clipped()
        .background(Rectangle().stroke(Theme.gridLine, lineWidth: 0.5))
        .opacity(inMonth ? 1.0 : 0.35)
    }

    /// 非「今天」格子的数字颜色。今天走上面的 .white（配蓝底圆），
    /// 不经过这里——以前这里对 isToday 返回品牌蓝，正是蓝底蓝字那个 bug 的一半。
    private var numberColor: Color {
        inMonth ? .primary : .secondary
    }
}
