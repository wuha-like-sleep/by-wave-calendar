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

    @State private var selectedDay: Date?
    @State private var showDaySheet = false
    @EnvironmentObject private var state: AppState

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2  // Monday-first to match the web
        c.locale = Locale(identifier: "zh_CN")
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
        var m = [Date: [EventDTO]]()
        for e in events {
            let key = calendar.startOfDay(for: e.startsAt)
            m[key, default: []].append(e)
        }
        for k in m.keys {
            m[k]?.sort { $0.startsAt < $1.startsAt }
        }
        return m
    }

    var body: some View {
        VStack(spacing: 0) {
            weekdayHeader
            GeometryReader { geo in
                let cellW = geo.size.width / 7
                let cellH = geo.size.height / 6
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(cellW), spacing: 0), count: 7), spacing: 0) {
                    ForEach(days, id: \.self) { day in
                        DayCell(
                            day: day,
                            inMonth: calendar.isDate(day, equalTo: monthAnchor, toGranularity: .month),
                            isToday: calendar.isDateInToday(day),
                            events: eventsByDay[calendar.startOfDay(for: day)] ?? [],
                            calendars: calendars,
                            height: cellH,
                        )
                        .frame(width: cellW, height: cellH)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            selectedDay = day
                            showDaySheet = true
                        }
                        // Long-press a day to peek at its events without
                        // opening the sheet — quick scan + jump-to options.
                        .contextMenu {
                            let dayEvents = eventsByDay[calendar.startOfDay(for: day)] ?? []
                            ForEach(dayEvents.prefix(5)) { ev in
                                Button {
                                    selectedDay = day
                                    showDaySheet = true
                                } label: {
                                    Text(ev.summary).lineLimit(1)
                                }
                            }
                            if dayEvents.count > 5 {
                                Text("还有 \(dayEvents.count - 5) 个…")
                            }
                            if dayEvents.isEmpty {
                                Text("无事件").foregroundStyle(.secondary)
                            }
                            Divider()
                            Button {
                                selectedDay = day
                                showDaySheet = true
                            } label: {
                                Label("打开这一天", systemImage: "calendar.day.timeline.left")
                            }
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showDaySheet) {
            if let day = selectedDay {
                NavigationStack {
                    DayView(
                        anchor: calendar.startOfDay(for: day),
                        events: (eventsByDay[calendar.startOfDay(for: day)] ?? [])
                            .sorted { $0.startsAt < $1.startsAt },
                        calendars: calendars,
                        onEventChanged: {
                            // Day sheet edited an event — parent reloads,
                            // which republishes events to this view.
                            onEventChanged()
                        },
                    )
                    .navigationTitle(dayTitle(day))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("关闭") { showDaySheet = false }
                        }
                    }
                }
            }
        }
    }

    private var weekdayHeader: some View {
        let labels = ["一", "二", "三", "四", "五", "六", "日"]
        return HStack(spacing: 0) {
            ForEach(labels, id: \.self) { label in
                Text(label)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6)
        .background(Theme.subtleSurface)
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
    let height: CGFloat

    private var dayNumber: Int { Calendar.current.component(.day, from: day) }

    private var calLookup: [String: CalendarMeta] {
        Dictionary(uniqueKeysWithValues: calendars.map { ($0.id, $0) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(dayNumber)")
                    .font(.callout.weight(isToday ? .bold : .regular))
                    .foregroundStyle(numberColor)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(isToday ? Color.accentColor : .clear, in: Circle())
                    .foregroundStyle(isToday ? .white : numberColor)
                Spacer()
            }
            // Up to 3 events with a colored bar; more compressed when no space.
            // Text bumped from 9pt → 10.5pt with medium weight for legibility
            // — 9pt was readable on a Retina screen but too thin in dark mode
            // / for older eyes.
            if height > 60 {
                ForEach(events.prefix(3)) { ev in
                    HStack(spacing: 3) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(Color(hex: calLookup[ev.calendarId]?.color) ?? .accentColor)
                            .frame(width: 3)
                        Text(ev.summary)
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                    }
                }
                if events.count > 3 {
                    Text("+\(events.count - 3)")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            } else {
                // Compact: just colored dots in a row.
                HStack(spacing: 2) {
                    ForEach(events.prefix(4)) { ev in
                        Circle()
                            .fill(Color(hex: calLookup[ev.calendarId]?.color) ?? .accentColor)
                            .frame(width: 5, height: 5)
                    }
                    if events.count > 4 {
                        Text("+\(events.count - 4)").font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(
            Rectangle().stroke(Theme.gridLine, lineWidth: 0.5)
        )
        .opacity(inMonth ? 1.0 : 0.35)
    }

    private var numberColor: Color {
        if isToday { return .accentColor }
        return inMonth ? .primary : .secondary
    }
}
