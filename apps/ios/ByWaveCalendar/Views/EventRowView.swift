// EventRowView.swift
// Single row used by DayView + WeekView. Centralized so a layout tweak
// applies to both. MonthView/YearView use their own compact renders.

import SwiftUI

struct EventRowView: View {
    let event: EventDTO
    let calendar: CalendarMeta?
    // Optional callbacks for the long-press context menu. When nil, the
    // menu items don't render (used by SearchView where these actions
    // don't make sense without a parent refresh hook).
    var onDelete: (() -> Void)? = nil
    var onDuplicate: (() -> Void)? = nil
    var onCopySummary: (() -> Void)? = nil

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
                }
                HStack(spacing: 6) {
                    Image(systemName: "clock").font(.caption2)
                    Text(timeLabel).font(.caption).foregroundStyle(.secondary)
                }
                if let location = event.location, !location.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "mappin").font(.caption2)
                        Text(location).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                if let cal = calendar {
                    Text(cal.name).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private var timeLabel: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        if event.allDay {
            f.dateFormat = "M月d日（全天）"
            return f.string(from: event.startsAt)
        }
        let cal = Calendar.current
        let sameDay = cal.isDate(event.startsAt, inSameDayAs: event.endsAt)
        if sameDay {
            f.dateFormat = "HH:mm"
            return f.string(from: event.startsAt) + " – " + f.string(from: event.endsAt)
        } else {
            f.dateFormat = "M/d HH:mm"
            return f.string(from: event.startsAt) + " – " + f.string(from: event.endsAt)
        }
    }
}
