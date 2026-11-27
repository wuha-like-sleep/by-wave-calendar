// YearView.swift
// 12 mini month grids in a width- and text-size-aware layout. Each cell = month name + tiny 7×6
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

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var minimumCardWidth: CGFloat = 104
    @ScaledMetric(relativeTo: .subheadline) private var titleHeight: CGFloat = 28
    @ScaledMetric(relativeTo: .caption2) private var countHeight: CGFloat = 18

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2
        c.locale = Locale.current  // symbols follow app language (was zh_CN)
        return c
    }()

    private var year: Int { calendar.component(.year, from: yearAnchor) }

    private var monthAnchors: [Date] {
        (1...12).compactMap { month in
            calendar.date(from: DateComponents(year: year, month: month, day: 1))
        }
    }

    private let spacing: CGFloat = 14

    var body: some View {
        GeometryReader { geo in
            // The outer display keeps three columns at normal text sizes.
            // Larger text gets fewer, wider cards instead of squeezed titles.
            let cols = max(1, min(4, Int((geo.size.width - spacing) / (minimumCardWidth + spacing))))
            let rows = (12 + cols - 1) / cols
            let cardW = max(0, (geo.size.width - spacing * CGFloat(cols + 1)) / CGFloat(cols))
            let cardHFill = max(0, (geo.size.height - spacing * CGFloat(rows + 1)) / CGFloat(rows))
            let stackedTitle = dynamicTypeSize.isAccessibilitySize
            let headerHeight = titleHeight + (stackedTitle ? countHeight + 4 : 0)
            let inner = max(0, cardW - Self.cardPadding * 2)
            let dotByWidth = inner / 9.4
            let dotByHeight = (cardHFill - Self.cardPadding * 2 - headerHeight - 6) / 8
            let dot = min(dotByWidth, min(14, max(5, dotByHeight)))
            let gap = dot * 0.4
            let natural = Self.cardPadding * 2 + headerHeight + 6 + dot * 6 + gap * 5
            let cardH = max(44, max(natural, cardHFill))
            let summary = YearEventSummary(events: events, yearAnchor: yearAnchor, calendar: calendar)
            let occupied = summary.busyDays
            let counts = summary.eventCountByMonth

            ScrollView {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.fixed(cardW), spacing: spacing), count: cols),
                    spacing: spacing,
                ) {
                    ForEach(monthAnchors, id: \.self) { anchor in
                        let m = calendar.component(.month, from: anchor)
                        Button { onMonthTap(anchor) } label: {
                            MonthCard(
                                anchor: anchor,
                                calendar: calendar,
                                busyDays: occupied,
                                eventCount: counts[m] ?? 0,
                                isCurrentMonth: calendar.isDate(anchor, equalTo: Date(), toGranularity: .month),
                                dotSize: dot,
                                dotSpacing: gap,
                                padding: Self.cardPadding,
                                titleHeight: titleHeight,
                                countHeight: countHeight,
                                stackedTitle: stackedTitle
                            )
                            .frame(width: cardW, height: cardH)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(anchor.formatted(.dateTime.year().month(.wide))))
                        .accessibilityValue(Text("%lld 个事件".locFormat(counts[m] ?? 0)))
                        .accessibilityIdentifier("year.month.\(year)-\(m)")
                    }
                }
                .padding(spacing)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    fileprivate static let cardPadding: CGFloat = 10
}

private struct MonthCard: View {
    let anchor: Date
    let calendar: Calendar
    let busyDays: Set<Date>
    let eventCount: Int
    let isCurrentMonth: Bool
    let dotSize: CGFloat
    let dotSpacing: CGFloat
    let padding: CGFloat
    let titleHeight: CGFloat
    let countHeight: CGFloat
    let stackedTitle: Bool

    private var monthName: String {
        // CLDR template so each language names months its own way
        // ("8月" / "Aug" / "août") — was hardcoded "M月" (zh leak).
        let f = DateFormatter()
        f.locale = Locale.current
        f.setLocalizedDateFormatFromTemplate("MMM")
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
            if stackedTitle {
                VStack(alignment: .leading, spacing: 4) {
                    monthTitle.frame(height: titleHeight)
                    countBadge.frame(height: countHeight)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    monthTitle
                    Spacer(minLength: 0)
                    countBadge
                }
                .frame(height: titleHeight)
            }
            // 6 行 × 7 列的点阵，尺寸由外面按卡片大小算好传进来。
            LazyVGrid(
                columns: Array(repeating: GridItem(.fixed(dotSize), spacing: dotSpacing), count: 7),
                spacing: dotSpacing,
            ) {
                ForEach(days, id: \.self) { day in
                    let inMonth = calendar.isDate(day, equalTo: anchor, toGranularity: .month)
                    let busy = busyDays.contains(calendar.startOfDay(for: day))
                    Circle()
                        .fill(dotColor(inMonth: inMonth, busy: busy))
                        .frame(width: dotSize, height: dotSize)
                }
            }
            // 卡片被拉高时多出来的空间平摊到点阵上下，标题仍然贴顶。
            // 点径封顶后（宽屏上会封到 14pt）点阵会比卡片内宽窄一点，
            // 居中比靠左好看，手机上点阵正好填满、居中等于没动。
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
        .padding(padding)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .fill(isCurrentMonth ? Color.accentColor.opacity(0.12) : Theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .strokeBorder(isCurrentMonth ? Color.accentColor.opacity(0.5) : Theme.gridLine, lineWidth: isCurrentMonth ? 1 : 0.5)
        )
    }

    private var monthTitle: some View {
        Text(monthName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(isCurrentMonth ? Color.accentColor : .primary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .layoutPriority(1)
    }

    @ViewBuilder private var countBadge: some View {
        if eventCount > 0 {
            Text("\(eventCount)")
                .font(.caption2.weight(.medium).monospacedDigit())
                .foregroundStyle(isCurrentMonth ? Color.accentColor : .secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Capsule().fill(isCurrentMonth ? Color.accentColor.opacity(0.15) : Theme.chip))
        }
    }

    private func dotColor(inMonth: Bool, busy: Bool) -> Color {
        if !inMonth { return Theme.veryDimContent }
        if busy { return Color.accentColor }
        return Theme.dimContent
    }
}
