import Foundation

// 增量同步本地应用计划校验（Sync/OfflineSync.swift 的 EventSyncLogic）：
// 整组替换、删除、日历剪枝、离线队列保护。与 Web 的 planDeltaApply
// 同一套语义。本机无 Xcode 工具链，这份脚本随代码提交、在有工具链的
// 环境按其余 *Check.swift 的方式编译运行（依赖 Models.swift 的
// EventDTO 与 OfflineSync.swift）。
@main struct EventSyncLogicCheck {
    static func dto(id: String, calendarId: String = "c1", startsAt: String) throws -> EventDTO {
        try JSONDecoder.iso().decode(EventDTO.self, from: Data("""
        {"id":"\(id)","calendarId":"\(calendarId)","summary":"s-\(id)","startsAt":"\(startsAt)","endsAt":"\(startsAt)","allDay":false}
        """.utf8))
    }

    static func keys(_ events: [EventDTO]) -> [String] {
        events.map { "\($0.id)@\($0.startsAt.timeIntervalSince1970)" }.sorted()
    }

    static func main() throws {
        let t1 = "2026-06-01T10:00:00.000Z"
        let t2 = "2026-06-02T10:00:00.000Z"
        let t3 = "2026-06-03T10:00:00.000Z"
        let visible: Set<String> = ["c1", "c2"]

        // ---- 整组替换：母事件的旧行全删、响应行全收 ----
        var out = try EventSyncLogic.applyDelta(
            local: [dto(id: "a", startsAt: t1), dto(id: "a", startsAt: t2), dto(id: "b", startsAt: t1)],
            upsertedIds: ["a"], deletedIds: [],
            incoming: [dto(id: "a", startsAt: t3)],
            visibleCalendarIds: visible, protectedIds: [])
        precondition(keys(out) == keys([try dto(id: "a", startsAt: t3), dto(id: "b", startsAt: t1)]))

        // ---- 母事件移出窗口：upserted 里有它、响应里没有行 → 删干净 ----
        out = try EventSyncLogic.applyDelta(
            local: [dto(id: "a", startsAt: t1), dto(id: "b", startsAt: t1)],
            upsertedIds: ["a"], deletedIds: [],
            incoming: [],
            visibleCalendarIds: visible, protectedIds: [])
        precondition(keys(out) == keys([try dto(id: "b", startsAt: t1)]))

        // ---- deletedIds 直接删 ----
        out = try EventSyncLogic.applyDelta(
            local: [dto(id: "a", startsAt: t1), dto(id: "b", startsAt: t1)],
            upsertedIds: [], deletedIds: ["b"],
            incoming: [],
            visibleCalendarIds: visible, protectedIds: [])
        precondition(keys(out) == keys([try dto(id: "a", startsAt: t1)]))

        // ---- 队列保护：待同步的母事件，upsert 与 delete 都跳过，
        //      服务端给它的新行也不收（本地版本说了算） ----
        out = try EventSyncLogic.applyDelta(
            local: [dto(id: "c", startsAt: t1), dto(id: "d", startsAt: t1)],
            upsertedIds: ["c"], deletedIds: ["d"],
            incoming: [dto(id: "c", startsAt: t3)],
            visibleCalendarIds: visible, protectedIds: ["c", "d"])
        precondition(keys(out) == keys([try dto(id: "c", startsAt: t1), dto(id: "d", startsAt: t1)]))

        // ---- 日历剪枝：名单外的日历整批剪掉；被保护的留在原地 ----
        out = try EventSyncLogic.applyDelta(
            local: [
                dto(id: "a", calendarId: "c1", startsAt: t1),
                dto(id: "b", calendarId: "gone", startsAt: t1),
                dto(id: "e", calendarId: "gone", startsAt: t1),
            ],
            upsertedIds: [], deletedIds: [],
            incoming: [],
            visibleCalendarIds: visible, protectedIds: ["e"])
        precondition(keys(out) == keys([
            try dto(id: "a", calendarId: "c1", startsAt: t1),
            dto(id: "e", calendarId: "gone", startsAt: t1),
        ]))

        // ---- 没被点名的母事件原样保留；离线新建的临时行不被名单误伤 ----
        out = try EventSyncLogic.applyDelta(
            local: [dto(id: "a", startsAt: t1), dto(id: "local:u1", startsAt: t2)],
            upsertedIds: [], deletedIds: [],
            incoming: [],
            visibleCalendarIds: visible, protectedIds: ["local:u1"])
        precondition(out.count == 2)

        print("EventSyncLogicCheck: all passed")
    }
}
