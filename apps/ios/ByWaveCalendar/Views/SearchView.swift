// SearchView.swift
// Calls the server's /api/v1/search?q=… endpoint with a 250ms debounce.
// Reuses EventRowView for results; tap a result → EventDetailView.
//
// /search 按设计只回一部分字段（description 和 extra 是特意不回的：
// 一个是隐私取舍，一个装着入会密码）。所以搜索结果是「半个事件」，
// 点进去之前必须按 id 把完整那份取回来。
//
// ── 为什么非取不可 ──────────────────────────────────────────────────
// 缺的字段只能替它编一个默认值，而**编出来的默认值会被当成用户的修改
// 原样存回去**：从搜索结果点进去改一下标题，会议链接、入会密码、时区
// 全没了；全天事件变成定时事件、时间还跟着时区挪；重复事件因为看不见
// rrule 不弹「改这一个还是整个系列」，整条系列被改掉。全程不报错。
//
// 取不回来时（比如服务端是旧版本，还没有按 id 取这条路由）退回半个事件
// 照常显示 —— 真正兜住数据的是 EventEditView 那边：没加载过的字段一律
// 「不归我管」，不会发 null 去清空。

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
    // 可选：自建服务端可能比 App 旧，还没有这两个键。解不出来就是「不知道」，
    // 不能当成 false / 无重复 —— 那正是上面说的「编一个默认值」。
    let allDay: Bool?
    let rrule: String?
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
    /// 按 id 取回来的完整事件。搜索结果只有半个，编辑前必须用这份。
    @State private var hydrated: [String: EventDTO] = [:]
    let calendars: [CalendarMeta]

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
                }
                if results.isEmpty && !isSearching && !query.isEmpty {
                    // App target is iOS 17 → use the system component, same
                    // as ManageCalendarsView / BookingLinksView. (The old
                    // comment said this was held back by the deployment
                    // target, but the target is 17.0.)
                    ContentUnavailableView.search(text: query)
                        .listRowBackground(Color.clear)
                } else if isSearching && results.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowBackground(Color.clear)
                }
                ForEach(results) { r in
                    Button {
                        detailFor = r
                    } label: {
                        // Reuse the shared row so results render identically
                        // to Day/Week lists (dot, summary, time, location,
                        // calendar name). showsDate keeps the full date —
                        // search spans arbitrary days, unlike Day/Week.
                        // rrule / allDay 现在服务端会回，所以重复标记和全天
                        // 的样式在搜索结果里也是对的（旧服务端不回，退回原样）。
                        EventRowView(event: r.toEventDTO(), calendar: r.calendarMeta(), showsDate: true)
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
                        event: hydrated[r.id] ?? r.toEventDTO(),
                        calendar: r.calendarMeta(),
                        allCalendars: calendars,
                        onChanged: {
                            // Search result list doesn't auto-refresh after
                            // edit/delete because we don't have an easy way
                            // to know which fields changed. Re-run the
                            // current query.
                            scheduleSearch(query)
                        },
                    )
                    // 按 id 把完整的那一份取回来盖上去。取不到就用半个的照常显示
                    // （旧服务端没有这条路由），不给用户弹任何东西 —— 他要看的是
                    // 这个事件，不是一条关于接口版本的说明。
                    .task(id: r.id) {
                        guard hydrated[r.id] == nil else { return }
                        if let full: EventDTO = try? await APIClient(state: state).get("/events/\(r.id)") {
                            hydrated[r.id] = full
                        }
                    }
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

// Lift a search result up to a full EventDTO for the detail view. Fields
// not returned by /search default to nil/false; detail view re-fetches
// for edit/delete so missing rrule isn't a correctness problem.
private extension SearchResult {
    /// Build the CalendarMeta that EventRowView (and the detail sheet)
    /// need for the color dot + calendar-name line. Falls back to the
    /// brand indigo when /search omitted the color.
    func calendarMeta() -> CalendarMeta? {
        guard let name = calendarName else { return nil }
        return CalendarMeta(id: calendarId, name: name, color: calendarColor ?? "#6366f1")
    }

    func toEventDTO() -> EventDTO {
        EventDTO(
            id: id,
            calendarId: calendarId,
            summary: summary,
            description: nil,
            location: location,
            startsAt: startsAt,
            endsAt: endsAt,
            // 服务端没给就退回 false —— 但这条路上的 allDay 只用于**显示**，
            // 保存时由 EventEditView 决定发不发（没加载过就不发）。
            allDay: allDay ?? false,
            rrule: rrule,
            isOccurrence: nil,
            // extra 搜索结果里没有。**nil 的意思是「没加载过」，不是「空的」** ——
            // EventEditView 靠这个区分，不会拿它去清空别处设好的东西。
            extra: nil,
        )
    }
}
