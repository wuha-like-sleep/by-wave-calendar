// CalendarView.swift
// v0.1 — list of today + upcoming events. Just enough to prove the
// auth + API plumbing all works end to end.
//
// Future iterations will replace this with a proper day/week/month grid.

import SwiftUI

struct CalendarView: View {
    @EnvironmentObject var state: AppState
    @State private var events: [EventDTO] = []
    @State private var calendars: [CalendarMeta] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var calLookup: [String: CalendarMeta] {
        Dictionary(uniqueKeysWithValues: calendars.map { ($0.id, $0) })
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && events.isEmpty {
                    ProgressView("加载中…")
                } else if events.isEmpty {
                    EmptyEventsView()
                } else {
                    eventList
                }
            }
            .navigationTitle("今天")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("刷新", systemImage: "arrow.clockwise") {
                            Task { await load() }
                        }
                        Divider()
                        Button("退出登录", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            state.signOut()
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private var eventList: some View {
        List {
            if let errorMessage {
                Text(errorMessage).foregroundStyle(.red).font(.callout)
            }
            ForEach(events) { ev in
                EventRow(event: ev, calendar: calLookup[ev.calendarId])
            }
        }
        .listStyle(.insetGrouped)
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        // Pull the next 7 days. Server expands recurring rules so we
        // get individual occurrences here.
        let cal = Calendar.current
        let from = cal.startOfDay(for: Date())
        let to = cal.date(byAdding: .day, value: 7, to: from)!
        let iso = ISO8601DateFormatter()
        let path = "/events?from=\(iso.string(from: from).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)&to=\(iso.string(from: to).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)"

        do {
            let client = APIClient(state: state)
            let resp: EventsResponse = try await client.get(path)
            self.calendars = resp.calendars
            // Sort by start time, hide events that already ended >2h ago.
            let cutoff = Date().addingTimeInterval(-2 * 3600)
            self.events = resp.events
                .filter { $0.endsAt >= cutoff }
                .sorted { $0.startsAt < $1.startsAt }
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct EventRow: View {
    let event: EventDTO
    let calendar: CalendarMeta?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Color dot for the owning calendar.
            Circle()
                .fill(Color(hex: calendar?.color) ?? .accentColor)
                .frame(width: 10, height: 10)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                Text(event.summary).font(.body.weight(.medium)).lineLimit(2)
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
        // Same day → "10:00 – 11:30"; cross-day → "11/3 10:00 – 11/4 02:00"
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

private struct EmptyEventsView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "calendar")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)
            Text("接下来 7 天没有事件").font(.headline)
            Text("可以在网页或这里创建新事件。下拉刷新").font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Color from hex
// Tiny helper to map server's "#3b82f6" strings to SwiftUI Color.
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
