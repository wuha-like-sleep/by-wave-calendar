// SearchView.swift
// Calls the server's /api/v1/search?q=… endpoint with a 250ms debounce.
// Reuses EventRowView for results; tap a result → EventDetailView.
//
// Returned events from /search don't include every field EventDTO needs
// (notably `rrule` and `isOccurrence` aren't in the search response shape).
// We decode into a lighter SearchResult struct then promote to EventDTO
// on tap with the missing fields filled in as nil/false.

import SwiftUI

private struct SearchResult: Decodable, Identifiable, Hashable {
    let id: String
    let calendarId: String
    let calendarName: String?
    let calendarColor: String?
    let summary: String
    let location: String?
    let startsAt: Date
    let endsAt: Date
}

private struct SearchResponse: Decodable {
    let events: [SearchResult]
}

struct SearchView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var isSearching = false
    @State private var debounceTask: Task<Void, Never>?
    @State private var errorMessage: String?
    @State private var detailFor: SearchResult?
    let calendars: [CalendarMeta]

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
                }
                if results.isEmpty && !isSearching && !query.isEmpty {
                    ContentUnavailableView("没有匹配", systemImage: "magnifyingglass")
                        .listRowBackground(Color.clear)
                } else if isSearching && results.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowBackground(Color.clear)
                }
                ForEach(results) { r in
                    Button {
                        detailFor = r
                    } label: {
                        SearchRow(result: r)
                    }
                    .buttonStyle(.plain)
                }
            }
            .navigationTitle("搜索事件")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "标题 / 描述 / 地点")
            .onChange(of: query) { _, newValue in
                scheduleSearch(newValue)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .sheet(item: $detailFor) { r in
                NavigationStack {
                    EventDetailView(
                        event: r.toEventDTO(),
                        calendar: r.calendarName.flatMap { name in
                            CalendarMeta(id: r.calendarId, name: name, color: r.calendarColor ?? "#6366f1")
                        },
                        allCalendars: calendars,
                        onChanged: {
                            // Search result list doesn't auto-refresh after
                            // edit/delete because we don't have an easy way
                            // to know which fields changed. Re-run the
                            // current query.
                            scheduleSearch(query)
                        },
                    )
                }
            }
        }
    }

    private func scheduleSearch(_ q: String) {
        debounceTask?.cancel()
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            results = []
            errorMessage = nil
            return
        }
        debounceTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            await runSearch(trimmed)
        }
    }

    private func runSearch(_ q: String) async {
        isSearching = true
        errorMessage = nil
        defer { isSearching = false }
        do {
            let client = APIClient(state: state)
            // Server endpoint: GET /api/v1/search?q=...&limit=100
            let escaped = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
            let resp: SearchResponse = try await client.get("/search?limit=100&q=\(escaped)")
            self.results = resp.events
        } catch let e as APIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SearchRow: View {
    let result: SearchResult
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(Color(hex: result.calendarColor) ?? .accentColor)
                .frame(width: 10, height: 10)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                Text(result.summary).font(.body.weight(.medium)).lineLimit(2)
                HStack(spacing: 6) {
                    Image(systemName: "clock").font(.caption2)
                    Text(timeLabel).font(.caption).foregroundStyle(.secondary)
                }
                if let location = result.location, !location.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "mappin").font(.caption2)
                        Text(location).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                if let n = result.calendarName {
                    Text(n).font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }
    private var timeLabel: String {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "yyyy年M月d日 HH:mm"
        return f.string(from: result.startsAt)
    }
}

// Lift a search result up to a full EventDTO for the detail view. Fields
// not returned by /search default to nil/false; detail view re-fetches
// for edit/delete so missing rrule isn't a correctness problem.
private extension SearchResult {
    func toEventDTO() -> EventDTO {
        EventDTO(
            id: id,
            calendarId: calendarId,
            summary: summary,
            description: nil,
            location: location,
            startsAt: startsAt,
            endsAt: endsAt,
            allDay: false,
            rrule: nil,
            isOccurrence: nil,
        )
    }
}
