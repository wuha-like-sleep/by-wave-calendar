import Foundation

// 离线写队列纯逻辑校验（Sync/OfflineSync.swift 的 PendingOpLogic）：
// 合并规则、请求体合并、退避、错误分流、展示合并。与 Android / 桌面
// 共用同一套语义（shared/PendingOps.kt），用例与那边的
// PendingOpsTest.kt 一一对应。本机无 Xcode 工具链，这份脚本随代码
// 提交、在有工具链的环境按其余 *Check.swift 的方式编译运行。

@main struct PendingOpLogicCheck {
    static func op(
        kind: PendingOpKind, eventId: String, seq: Int64,
        payload: String? = nil, scope: String? = nil, recurrenceId: String? = nil,
        state: PendingOpState = .pending,
    ) -> PendingOp {
        PendingOp(
            id: "op-\(seq)", seq: seq, accountKey: "https://example.test|a@b.c",
            kind: kind, eventId: eventId, payloadJson: payload,
            scope: scope, recurrenceId: recurrenceId,
            summary: "s\(seq)", createdAtMs: seq, state: state,
        )
    }

    static func dto(id: String, summary: String, startsAt: String) throws -> EventDTO {
        try JSONDecoder.iso().decode(EventDTO.self, from: Data("""
        {"id":"\(id)","calendarId":"c","summary":"\(summary)","startsAt":"\(startsAt)","endsAt":"\(startsAt)","allDay":false}
        """.utf8))
    }

    static func main() throws {
        // ---- 合并规则 ----
        // 建 + 无作用域改 → 折进建的请求体
        var out = PendingOpLogic.enqueue(
            queue: [op(kind: .create, eventId: "local:u1", seq: 1, payload: #"{"summary":"A","startsAt":"t1"}"#)],
            op: op(kind: .update, eventId: "local:u1", seq: 2, payload: #"{"summary":"B"}"#))
        precondition(out.count == 1 && out[0].kind == .create)
        precondition(out[0].payloadJson!.contains("\"summary\":\"B\""))
        precondition(out[0].payloadJson!.contains("\"startsAt\":\"t1\""))

        // 建 + 作用域改 → 不折，排队跟上
        out = PendingOpLogic.enqueue(
            queue: [op(kind: .create, eventId: "local:u1", seq: 1, payload: #"{"summary":"A"}"#)],
            op: op(kind: .update, eventId: "local:u1", seq: 2, payload: #"{"summary":"B"}"#, scope: "instance", recurrenceId: "t1"))
        precondition(out.count == 2)

        // 建 + 整事件删 → 互相抵消
        out = PendingOpLogic.enqueue(
            queue: [op(kind: .create, eventId: "local:u1", seq: 1)],
            op: op(kind: .delete, eventId: "local:u1", seq: 2))
        precondition(out.isEmpty)

        // 同键改 + 改 → 请求体合并
        out = PendingOpLogic.enqueue(
            queue: [op(kind: .update, eventId: "e1", seq: 1, payload: #"{"summary":"A","location":"L1"}"#)],
            op: op(kind: .update, eventId: "e1", seq: 2, payload: #"{"location":"L2"}"#))
        precondition(out.count == 1)
        precondition(out[0].payloadJson!.contains("\"summary\":\"A\""))
        precondition(out[0].payloadJson!.contains("\"location\":\"L2\""))

        // 整事件删 → 丢掉排队的改
        out = PendingOpLogic.enqueue(
            queue: [op(kind: .update, eventId: "e1", seq: 1)],
            op: op(kind: .delete, eventId: "e1", seq: 2))
        precondition(out.count == 1 && out[0].kind == .delete)

        // 删之后再来的改 → 丢弃
        out = PendingOpLogic.enqueue(
            queue: [op(kind: .delete, eventId: "e1", seq: 1)],
            op: op(kind: .update, eventId: "e1", seq: 2))
        precondition(out.count == 1 && out[0].kind == .delete)

        // 同键删重复入队 → 只留一条
        out = PendingOpLogic.enqueue(
            queue: [op(kind: .delete, eventId: "e1", seq: 1, scope: "instance", recurrenceId: "t1")],
            op: op(kind: .delete, eventId: "e1", seq: 2, scope: "instance", recurrenceId: "t1"))
        precondition(out.count == 1)

        // 待处理条目不被合并动
        out = PendingOpLogic.enqueue(
            queue: [op(kind: .update, eventId: "e1", seq: 1, payload: #"{"summary":"A"}"#, state: .attention)],
            op: op(kind: .delete, eventId: "e1", seq: 2))
        precondition(out.count == 2)
        precondition(out.first { $0.kind == .update }?.state == .attention)

        // ---- 请求体合并 ----
        let merged = PendingOpLogic.mergePayloadJson(
            base: #"{"summary":"A","extra":{"color":"red","url":"https://x.test"}}"#,
            patch: #"{"location":"L","extra":{"color":"blue"}}"#)!
        precondition(merged.contains("\"summary\":\"A\""))
        precondition(merged.contains("\"location\":\"L\""))
        precondition(merged.contains("\"color\":\"blue\""))
        precondition(merged.contains("\"url\":\"https://x.test\""))
        precondition(PendingOpLogic.mergePayloadJson(base: nil, patch: #"{"a":1}"#) == #"{"a":1}"#)
        precondition(PendingOpLogic.mergePayloadJson(base: #"{"a":1}"#, patch: nil) == #"{"a":1}"#)

        // ---- 退避 ----
        precondition(PendingOpLogic.backoffMs(attempts: 1) == 30_000)
        precondition(PendingOpLogic.backoffMs(attempts: 2) == 60_000)
        precondition(PendingOpLogic.backoffMs(attempts: 3) == 120_000)
        precondition(PendingOpLogic.backoffMs(attempts: 20) == 30 * 60_000)

        // ---- 错误分流 ----
        precondition(PendingOpLogic.classify(kind: .create, status: 201) == .done)
        precondition(PendingOpLogic.classify(kind: .delete, status: 404) == .done)
        precondition(PendingOpLogic.classify(kind: .update, status: 404) == .gone)
        precondition(PendingOpLogic.classify(kind: .update, status: 409) == .attention)
        precondition(PendingOpLogic.classify(kind: .create, status: 400) == .attention)
        precondition(PendingOpLogic.classify(kind: .update, status: 503) == .retryable)
        precondition(PendingOpLogic.classify(kind: .update, status: 401) == .authBlocked)
        precondition(PendingOpLogic.classify(kind: .update, status: nil) == .retryable)

        // ---- 展示合并 ----
        let e1 = try dto(id: "e1", summary: "A", startsAt: "2026-11-20T01:00:00.000Z")
        let e2 = try dto(id: "e2", summary: "B", startsAt: "2026-11-20T02:00:00.000Z")
        // 待删剔除
        var shown = PendingOpLogic.overlay(
            server: [e1, e2],
            ops: [op(kind: .delete, eventId: "e1", seq: 1)])
        precondition(shown.map { $0.id } == ["e2"])
        // 待改套用
        shown = PendingOpLogic.overlay(
            server: [e1],
            ops: [op(kind: .update, eventId: "e1", seq: 1, payload: #"{"summary":"A2"}"#,
                     baseStartsAt: "2026-11-20T01:00:00.000Z")])
        precondition(shown.first?.summary == "A2")
        // 待建追加 + 幂等（合并两次不变）
        let createOp = PendingOp(
            id: "op-c", seq: 1, accountKey: "k", kind: .create, eventId: "local:u9",
            snapshotJson: PendingOpLogic.encodeSnapshot([try dto(id: "local:u9", summary: "N", startsAt: "2026-11-20T03:00:00.000Z")]),
            summary: "N", createdAtMs: 1)
        let once = PendingOpLogic.overlay(server: [e1], ops: [createOp])
        let twice = PendingOpLogic.overlay(server: once, ops: [createOp])
        precondition(once.count == 2 && twice.count == 2)

        // ---- 本地 DTO 构造 ----
        let body = Data(#"{"calendarId":"c","summary":"X","startsAt":"2026-11-20T01:00:00.000Z","endsAt":"2026-11-20T02:00:00.000Z","allDay":false,"clientUid":"u9"}"#.utf8)
        let local = PendingOpLogic.localDTO(forCreateBody: body, tempId: "local:u9")
        precondition(local?.id == "local:u9" && local?.summary == "X")

        print("PendingOpLogicCheck: all preconditions passed")
    }
}
