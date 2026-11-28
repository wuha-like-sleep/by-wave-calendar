// EventRowView.swift
// Single row used by DayView + WeekView. Centralized so a layout tweak
// applies to both. MonthView/YearView use their own compact renders.

import SwiftUI

struct EventRowView: View {
    @Environment(\.timeZone) private var displayZone
    let event: EventDTO
    let calendar: CalendarMeta?
    // Show the full calendar date in the time line. Day/Week lists leave
    // this false — the date is already implied by the view they're in, so
    // a per-row date would be noise. SearchView sets it true: results span
    // arbitrary dates, so "14:00–15:00" alone is ambiguous there.
    var showsDate: Bool = false
    // Search summaries only carry a display hint; their editable metadata is unloaded.
    var searchSourceTimezone: String? = nil
    // Optional callbacks for the long-press context menu. When nil, the
    // menu items don't render (used by SearchView where these actions
    // don't make sense without a parent refresh hook).
    var onDelete: (() -> Void)? = nil
    var onDuplicate: (() -> Void)? = nil
    var onCopySummary: (() -> Void)? = nil
    // 这条事件有还没同步到服务端的改动（离线队列里有它的条目）。
    // 调用方按队列现状算好传进来，行里只负责亮一个标记——本地已经
    // 是改后的样子，但不能让用户以为别台设备上也能看到了。
    var isPendingSync: Bool = false

    /// "Past" = the event has fully ended before now. Used to gray out
    /// + strike through the title so the user can tell at a glance
    /// which events on a busy day are still to come vs. already over.
    private var isPast: Bool {
        event.endsAt < Date()
    }

    var body: some View {
        rowContent
            // Drop the whole row's opacity for past events. Combined
            // with strikethrough on the title, this matches what iOS
            // Calendar does after an event ends — easy at-a-glance scan.
            .opacity(isPast ? 0.55 : 1.0)
            .contextMenu {
                if let onCopySummary {
                    Button {
                        UIPasteboard.general.string = event.summary
                        onCopySummary()
                    } label: {
                        Label("复制标题", systemImage: "doc.on.doc")
                    }
                }
                if let onDuplicate {
                    Button {
                        onDuplicate()
                    } label: {
                        Label("复制为新事件", systemImage: "plus.square.on.square")
                    }
                }
                if let onDelete {
                    Button(role: .destructive) {
                        onDelete()
                    } label: {
                        Label("删除", systemImage: "trash")
                    }
                }
            }
    }

    private var rowContent: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(Color(hex: calendar?.color) ?? .accentColor)
                .frame(width: 10, height: 10)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(event.summary)
                        .font(.body.weight(.medium))
                        .lineLimit(2)
                        .strikethrough(isPast, color: .secondary)
                    if event.rrule != nil {
                        Image(systemName: "repeat")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if isPast {
                        // Tiny ✓ pill so it's not JUST visual styling —
                        // accessibility users + tiny strikethrough on dense
                        // lists won't miss it.
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if isPendingSync {
                        Text("待同步".loc)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.orange)
                    }
                }
                if let source = CalendarDisplayDates.sourceTimeZone(for: event, calendarZone: searchSourceTimezone ?? calendar?.timezone, viewerZone: displayZone) {
                    let datesNeeded = showsDate || CalendarDisplayDates.differentLocalDates(start: event.startsAt, end: event.endsAt, in: displayZone, and: source)
                    clockLine(zone: displayZone, datesNeeded: datesNeeded, icon: "clock")
                    clockLine(zone: source, datesNeeded: datesNeeded, icon: "globe")
                        .foregroundStyle(.secondary)
                } else {
                    Label(timeLabel, systemImage: "clock")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let location = event.location, !location.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "mappin").font(.caption2)
                        Text(location).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                if let cal = calendar {
                    Text(cal.name).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private var timeLabel: String {
        // Use cached shared formatters — instantiating DateFormatter
        // per row was a measurable hot path (DateFormatter init is
        // surprisingly expensive on iOS).
        if event.allDay {
            // 按 UTC 渲染，且末日要减一天：iCalendar 的 DTEND 是开区间，
            // 一个「只有 9 月 21 日一天」的全天事件 endsAt 是 9 月 22 日，
            // 直接拿去显示就成了两天的事。见 AllDayDates。
            let f = DateFormatters.monthDayUTC
            let start = f.string(from: event.startsAt)
            if AllDayDates.isSingleDay(event) {
                return start + " · " + "全天".loc
            }
            let last = f.string(from: AllDayDates.lastInclusiveUTCDay(of: event))
            return start + " – " + last + " · " + "全天".loc
        }
        return DateFormatters.timedRange(start: event.startsAt, end: event.endsAt, zone: displayZone,
                                        includeDate: showsDate, includeYear: showsDate)
    }

    private func clockLine(zone: TimeZone, datesNeeded: Bool, icon: String) -> some View {
        let city = DateFormatters.zoneLabel(zone, at: event.startsAt)
        let range = DateFormatters.timedRange(start: event.startsAt, end: event.endsAt, zone: zone,
                                            includeDate: datesNeeded, includeYear: showsDate)
        return Label(city + " · " + range, systemImage: icon)
            .font(.caption)
            .fixedSize(horizontal: false, vertical: true)
    }
}
