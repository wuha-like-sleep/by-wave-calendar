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
        c.locale = Locale.current  // symbols follow app language (was zh_CN)
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

    private let spacing: CGFloat = 14

    var body: some View {
        GeometryReader { geo in
            // 手机竖屏 3 列 × 4 行；iPad / Catalyst 宽屏时 4 列 × 3 行，
            // 免得一行三张卡在大屏上各自撑得过宽。
            let cols = geo.size.width >= 700 ? 4 : 3
            let rows = 12 / cols

            let cardW = max(60, (geo.size.width - spacing * CGFloat(cols + 1)) / CGFloat(cols))
            // 四行铺满可见高度，而不是挤在顶上、下面空掉近一半屏幕。
            let cardHFill = (geo.size.height - spacing * CGFloat(rows + 1)) / CGFloat(rows)

            // 点阵按卡片尺寸缩放。以前点固定 5pt、槽位固定 8pt，卡片变宽
            // 也不会跟着变大，一屏看下来那 12 组点小到分辨不出疏密。
            // 7 列点 + 6 个间隙(0.4 倍点径)正好填满卡片内宽；
            // 竖向 6 行同理，取两边较小的那个，并封顶 14pt 防止大屏上过胖。
            let inner = cardW - Self.cardPadding * 2
            let dotByWidth = inner / 9.4
            let dotByHeight = (cardHFill - Self.cardPadding * 2 - Self.titleHeight - 6) / 8.0
            let dot = min(14, max(4, min(dotByWidth, dotByHeight)))
            let gap = dot * 0.4

            // 卡片的自然高度。可见高度不够时（横屏、超大字号）退回自然高度，
            // 由外层 ScrollView 滚动，而不是把内容压扁切掉。
            let natural = Self.cardPadding * 2 + Self.titleHeight + 6 + (dot * 6 + gap * 5)
            let cardH = max(natural, cardHFill)

            ScrollView {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.fixed(cardW), spacing: spacing), count: cols),
                    spacing: spacing,
                ) {
                    ForEach(monthAnchors, id: \.self) { anchor in
                        let m = calendar.component(.month, from: anchor)
                        MonthCard(
                            anchor: anchor,
                            calendar: calendar,
                            busyDays: busyDays,
                            eventCount: eventCountByMonth[m] ?? 0,
                            isCurrentMonth: calendar.isDate(anchor, equalTo: Date(), toGranularity: .month),
                            dotSize: dot,
                            dotSpacing: gap,
                            padding: Self.cardPadding,
                        )
                        .frame(width: cardW, height: cardH)
                        .onTapGesture { onMonthTap(anchor) }
                    }
                }
                .padding(spacing)
            }
        }
    }

    /// 卡片内边距与标题行高度。算点阵尺寸时要减掉它们，抽成常量
    /// 是为了「这里改了那里忘改」不会静默把最后一行点挤出卡片。
    fileprivate static let cardPadding: CGFloat = 10
    fileprivate static let titleHeight: CGFloat = 22
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
                            Capsule().fill(isCurrentMonth ? Color.accentColor.opacity(0.15) : Theme.chip)
                        )
                }
            }
            .frame(height: YearView.titleHeight)
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

    private func dotColor(inMonth: Bool, busy: Bool) -> Color {
        if !inMonth { return Theme.veryDimContent }
        if busy { return Color.accentColor }
        return Theme.dimContent
    }
}
