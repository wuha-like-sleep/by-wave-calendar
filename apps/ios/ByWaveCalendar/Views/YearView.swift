// YearView.swift
// 12 mini month grids stacked 3×4. Each cell = month name + tiny 7×6
// dot grid where a date with ≥1 event gets a filled dot. Tap a card to
// switch to the month view for that month.
//
// Note: rendering all 12 months without per-event data would be visually
// flat. We use a binary "busy / free" indicator per day — cheap to
// compute, glanceable. The full event list for the year is in events;
// we just summarize.

import SwiftUI

struct YearView: View {
    let yearAnchor: Date
    let events: [EventDTO]
    let onMonthTap: (Date) -> Void   // parent switches to month view + monthAnchor

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2
        c.locale = Locale(identifier: "zh_CN")
        return c
    }()

    private var year: Int { calendar.component(.year, from: yearAnchor) }

    private var monthAnchors: [Date] {
        (1...12).compactMap { month in
            calendar.date(from: DateComponents(year: year, month: month, day: 1))
        }
    }

    // Days that have ≥1 event, set for O(1) lookup per cell.
    private var busyDays: Set<Date> {
        var s = Set<Date>()
        for e in events {
            s.insert(calendar.startOfDay(for: e.startsAt))
        }
        return s
    }

    // Count events per month for the badge in each card.
    private var eventCountByMonth: [Int: Int] {
        var counts: [Int: Int] = [:]
        for e in events {
            let m = calendar.component(.month, from: e.startsAt)
            counts[m, default: 0] += 1
        }
        return counts
    }

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                ForEach(monthAnchors, id: \.self) { anchor in
                    let m = calendar.component(.month, from: anchor)
                    MonthCard(
                        anchor: anchor,
                        calendar: calendar,
                        busyDays: busyDays,
                        eventCount: eventCountByMonth[m] ?? 0,
                        isCurrentMonth: calendar.isDate(anchor, equalTo: Date(), toGranularity: .month),
                    )
                    .onTapGesture { onMonthTap(anchor) }
                }
            }
            .padding(14)
        }
    }
}

private struct MonthCard: View {
    let anchor: Date
    let calendar: Calendar
    let busyDays: Set<Date>
    let eventCount: Int
    let isCurrentMonth: Bool

    private var monthName: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "M月"
        return f.string(from: anchor)
    }

    private var days: [Date] {
        // First Monday on/before the 1st, fill 6×7=42 cells.
        let comps = calendar.dateComponents([.year, .month], from: anchor)
        guard let first = calendar.date(from: comps) else { return [] }
        let weekday = calendar.component(.weekday, from: first)
        let daysSinceMonday = (weekday + 5) % 7
        let gridStart = calendar.date(byAdding: .day, value: -daysSinceMonday, to: first) ?? first
        return (0..<42).compactMap { calendar.date(byAdding: .day, value: $0, to: gridStart) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(monthName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(isCurrentMonth ? Color.accentColor : .primary)
                Spacer()
                if eventCount > 0 {
                    Text("\(eventCount)")
                        .font(.caption2.weight(.medium).monospacedDigit())
                        .foregroundStyle(isCurrentMonth ? Color.accentColor : .secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(
                            Capsule().fill(isCurrentMonth ? Color.accentColor.opacity(0.15) : Color.gray.opacity(0.12))
                        )
                }
            }
            // 6 rows × 7 cols of 4pt dots
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(8), spacing: 2), count: 7), spacing: 2) {
                ForEach(days, id: \.self) { day in
                    let inMonth = calendar.isDate(day, equalTo: anchor, toGranularity: .month)
                    let busy = busyDays.contains(calendar.startOfDay(for: day))
                    Circle()
                        .fill(dotColor(inMonth: inMonth, busy: busy))
                        .frame(width: 5, height: 5)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(isCurrentMonth ? Color.accentColor.opacity(0.06) : Color.gray.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(isCurrentMonth ? Color.accentColor.opacity(0.4) : Color.gray.opacity(0.15), lineWidth: isCurrentMonth ? 1 : 0.5)
        )
    }

    private func dotColor(inMonth: Bool, busy: Bool) -> Color {
        if !inMonth { return Color.gray.opacity(0.12) }
        if busy { return Color.accentColor }
        return Color.gray.opacity(0.28)
    }
}
