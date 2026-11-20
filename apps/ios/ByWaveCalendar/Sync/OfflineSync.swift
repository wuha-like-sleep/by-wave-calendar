// OfflineSync.swift
// iOS 端的离线写队列：建 / 改 / 删事件先落本地 + 入队，然后尽快
// 重放；断网、服务端 5xx 就退避等下一次触发，4xx 业务拒绝停进
// 待处理等用户裁决。
//
// 语义与 Android / 桌面共用一份（shared/PendingOps.kt 是同一套规则
// 的 Kotlin 版）：合并规则、退避、错误分流逐条对应，改一处必须
// 同步另一处。iOS 没有本地数据库，事件只活在内存 + EventCache
// 文件里，所以队列条目自带本地行快照（snapshotJson）：新建的本地
// 行、裁决回滚要恢复的行，都从条目里取，不依赖别处的缓存。
//
// 队列按账号键（serverURL|email）存文件。退出登录 / 移除账号的
// retireCredentials 只清 EventCache 和提醒，不清队列文件——没送
// 出去的改动不能因为登出就被扔掉；重新登录同一账号，队列续传。

import Foundation
import Combine
import Network

enum PendingOpKind: String, Codable {
    case create = "CREATE"
    case update = "UPDATE"
    case delete = "DELETE"
}

enum PendingOpState: String, Codable {
    case pending = "PENDING"
    case attention = "ATTENTION"
}

struct PendingOp: Codable, Identifiable, Equatable {
    var id: String
    var seq: Int64
    var accountKey: String
    var kind: PendingOpKind
    /// 目标事件 id。CREATE 时是本地临时 id（local:<clientUid>），
    /// 创建落定后引擎把后续条目里的临时 id 改写为真实 id。
    var eventId: String
    var clientUid: String? = nil
    /// CREATE / UPDATE 的请求体 JSON。DELETE 为 nil（参数在
    /// scope / recurrenceId 里）。
    var payloadJson: String? = nil
    var scope: String? = nil
    var recurrenceId: String? = nil
    /// 这次改动针对的那一次发生的 startsAt（ISO）。无作用域 UPDATE
    /// 合并展示时，非时间字段套每一行、时间字段只套这一行。
    var baseStartsAt: String? = nil
    /// 本地行快照（[EventDTO] 的 JSON）：CREATE 是那一行本地 DTO，
    /// UPDATE / DELETE 是改动落下去之前的行。裁决回滚、撤销未同步
    /// 删除、离线新建的冷启动展示都靠它。
    var snapshotJson: String? = nil
    var summary: String
    var createdAtMs: Int64
    var attempts: Int = 0
    var nextRetryAtMs: Int64 = 0
    var state: PendingOpState = .pending
    var errorCode: String? = nil
    var errorMessage: String? = nil

    var mergeKey: String { "\(eventId)|\(scope ?? "")|\(recurrenceId ?? "")" }
}

enum PendingOpVerdict {
    case done, gone, retryable, attention, authBlocked
}

enum AttentionResolution {
    case keepMine, useServer, discard
}

/// 纯逻辑：合并 / 请求体合并 / 退避 / 错误分流 / 展示合并。
/// 不碰 AppState、不碰网络，Tests/PendingOpLogicCheck.swift 直接测它。
enum PendingOpLogic {

    // MARK: 入队合并（与 shared/PendingOps.kt 的 PendingOpMerger 逐条对应）

    static func enqueue(queue: [PendingOp], op: PendingOp) -> [PendingOp] {
        let pending = queue.filter { $0.state == .pending }
        let attention = queue.filter { $0.state == .attention }
        let merged = enqueueIntoPending(pending, op)
        return (attention + merged).sorted { $0.seq < $1.seq }
    }

    private static func enqueueIntoPending(_ queue: [PendingOp], _ op: PendingOp) -> [PendingOp] {
        var out = queue
        switch op.kind {
        case .create:
            out.append(op)

        case .update:
            // 整事件已排了删除 → 这次修改丢弃。
            if out.contains(where: { $0.kind == .delete && $0.eventId == op.eventId && $0.scope == nil }) {
                return out
            }
            // 折进还没落定的 CREATE（仅无作用域修改；作用域修改打的
            // 是某一次发生，建事件的请求体表达不了，必须排队跟上，
            // 等 CREATE 落定后靠 id 改写对上真实事件）。
            if op.scope == nil,
               let idx = out.firstIndex(where: { $0.kind == .create && $0.eventId == op.eventId }) {
                let create = out[idx]
                out[idx].payloadJson = mergePayloadJson(base: create.payloadJson, patch: op.payloadJson)
                if !op.summary.isEmpty { out[idx].summary = op.summary }
                return out
            }
            // 同键 UPDATE 合并（后写覆盖先写）。
            if let idx = out.firstIndex(where: { $0.kind == .update && $0.mergeKey == op.mergeKey }) {
                let prev = out[idx]
                out[idx].payloadJson = mergePayloadJson(base: prev.payloadJson, patch: op.payloadJson)
                if !op.summary.isEmpty { out[idx].summary = op.summary }
                return out
            }
            out.append(op)

        case .delete:
            if op.scope == nil {
                // 整事件删除：这个事件的排队条目全丢；它本身还没上
                // 服务端（有 CREATE）就连删除也不用发，两边抵消。
                let hasCreate = out.contains { $0.kind == .create && $0.eventId == op.eventId }
                out.removeAll { $0.eventId == op.eventId }
                if !hasCreate { out.append(op) }
                return out
            }
            // 作用域删除：丢同键 UPDATE，同键 DELETE 只留一条。
            out.removeAll {
                $0.eventId == op.eventId && $0.mergeKey == op.mergeKey &&
                    ($0.kind == .update || $0.kind == .delete)
            }
            out.append(op)
        }
        return out
    }

    /// 两个请求体的浅合并：patch 的非 null 字段覆盖 base；extra 两边
    /// 都有时再浅合并一层（和服务端 extra 的浅合并语义同口径）。
    static func mergePayloadJson(base: String?, patch: String?) -> String? {
        guard let base else { return patch }
        guard let patch else { return base }
        guard let baseObj = parseObject(base) else { return patch }
        guard let patchObj = parseObject(patch) else { return base }
        var merged = baseObj
        for (key, value) in patchObj {
            if key == "extra",
               let existing = merged[key] as? [String: Any],
               let incoming = value as? [String: Any] {
                var extraMerged = existing
                for (ek, ev) in incoming { extraMerged[ek] = ev }
                merged[key] = extraMerged
            } else if !(value is NSNull) {
                merged[key] = value
            }
        }
        return serializeObject(merged)
    }

    // MARK: 退避（30 秒起、翻倍、30 分钟封顶）

    static func backoffMs(attempts: Int) -> Int64 {
        var delay: Int64 = 30_000
        if attempts <= 1 { return delay }
        for _ in 0..<min(attempts - 1, 10) {
            delay = min(delay * 2, 30 * 60_000)
        }
        return delay
    }

    // MARK: 错误分流（与 shared 的 PendingOpErrors.classify 同一张表）

    static func classify(kind: PendingOpKind, status: Int?) -> PendingOpVerdict {
        guard let status else { return .retryable }
        switch status {
        case 200...299: return .done
        case 401: return .authBlocked
        case 404: return kind == .delete ? .done : (kind == .update ? .gone : .attention)
        case 500...599: return .retryable
        default: return .attention
        }
    }

    static func classify(kind: PendingOpKind, error: Error) -> (verdict: PendingOpVerdict, code: String?, message: String?) {
        if let api = error as? APIError {
            switch api {
            case .server(let status, let body):
                return (classify(kind: kind, status: status), APIError.serverErrorCode(body), api.localizedDescription)
            case .network:
                return (.retryable, nil, nil)
            case .deviceRevoked, .notSignedIn:
                return (.authBlocked, nil, nil)
            case .refreshFailed(let status):
                return (status == 401 ? .authBlocked : .retryable, nil, nil)
            case .decode:
                return (.retryable, nil, nil)
            }
        }
        return (.retryable, nil, nil)
    }

    // MARK: 展示合并

    /// 一条 DELETE 命中的行：整事件删打全部行；instance 只打那一次
    /// 发生；future 打那一次及其之后。
    static func deleteRemoves(_ op: PendingOp, _ dto: EventDTO) -> Bool {
        guard dto.id == op.eventId else { return false }
        guard let scope = op.scope, scope != "series" else { return true }
        guard let recId = op.recurrenceId, let recDate = AppState.parseIsoLenient(recId) else { return false }
        switch scope {
        case "instance": return dto.startsAt == recDate
        case "future": return dto.startsAt >= recDate
        default: return true
        }
    }

    /// 把一条 PATCH 请求体套到 DTO 上。键不存在 = 没改，保持原值
    ///（JSONEncoder.iso 丢 nil，所以没改的字段根本不在请求体里）。
    /// extra 在 JSON 层浅合并一层，和服务端同口径。
    static func applyingUpdate(_ dto: EventDTO, payloadJson: String?, timeFields: Bool) -> EventDTO {
        guard let payloadJson, let obj = parseObject(payloadJson) else { return dto }
        var calendarId = dto.calendarId
        var summary = dto.summary
        var description = dto.description
        var location = dto.location
        var startsAt = dto.startsAt
        var endsAt = dto.endsAt
        var allDay = dto.allDay
        var rrule = dto.rrule
        var exdates = dto.exdates
        var extra = dto.extra
        if let v = obj["calendarId"] as? String { calendarId = v }
        if let v = obj["summary"] as? String { summary = v }
        if let v = obj["description"] as? String { description = v }
        if let v = obj["location"] as? String { location = v }
        if timeFields {
            if let v = obj["startsAt"] as? String, let d = AppState.parseIsoLenient(v) { startsAt = d }
            if let v = obj["endsAt"] as? String, let d = AppState.parseIsoLenient(v) { endsAt = d }
        }
        if let v = obj["allDay"] as? Bool { allDay = v }
        if let v = obj["rrule"] as? String { rrule = v.isEmpty ? nil : v }
        if let v = obj["exdates"] as? [String] { exdates = v }
        if let extraObj = obj["extra"] as? [String: Any] {
            var base: [String: Any] = [:]
            if let existing = dto.extra,
               let data = try? JSONEncoder.iso().encode(existing),
               let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                base = decoded
            }
            for (k, v) in extraObj { base[k] = v }
            if let data = try? JSONSerialization.data(withJSONObject: base),
               let decoded = try? JSONDecoder.iso().decode(EventExtraDTO.self, from: data) {
                extra = decoded
            }
        }
        return EventDTO(
            id: dto.id, calendarId: calendarId, summary: summary,
            description: description, location: location,
            startsAt: startsAt, endsAt: endsAt, allDay: allDay,
            rrule: rrule, exdates: exdates, isOccurrence: dto.isOccurrence, extra: extra,
        )
    }

    /// 服务端窗口行 + 未同步条目 → 展示集。幂等：对已经合并过的
    /// 集合再合并一次结果不变（加载失败时拿现集兜底合并靠这个）。
    static func overlay(server: [EventDTO], ops: [PendingOp]) -> [EventDTO] {
        var out = server
        let deletes = ops.filter { $0.kind == .delete }
        if !deletes.isEmpty {
            out = out.filter { dto in !deletes.contains { deleteRemoves($0, dto) } }
        }
        for op in ops.filter({ $0.kind == .update }).sorted(by: { $0.seq < $1.seq }) {
            out = out.map { dto in
                guard dto.id == op.eventId else { return dto }
                if op.scope != nil {
                    let hit = op.recurrenceId.flatMap { AppState.parseIsoLenient($0) } == dto.startsAt
                    return hit ? applyingUpdate(dto, payloadJson: op.payloadJson, timeFields: true) : dto
                }
                let isBaseRow = op.baseStartsAt.flatMap { AppState.parseIsoLenient($0) } == dto.startsAt
                return applyingUpdate(dto, payloadJson: op.payloadJson, timeFields: isBaseRow)
            }
        }
        let creates = ops.filter { $0.kind == .create }
        if !creates.isEmpty {
            let present = Set(out.map { $0.id })
            for op in creates {
                guard !present.contains(op.eventId) else { continue }
                if let rows = decodeSnapshot(op.snapshotJson), let dto = rows.first {
                    out.append(dto)
                }
            }
        }
        return out
    }

    // MARK: 快照编解码

    static func encodeSnapshot(_ dtos: [EventDTO]) -> String? {
        guard let data = try? JSONEncoder.iso().encode(dtos) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func decodeSnapshot(_ json: String?) -> [EventDTO]? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder.iso().decode([EventDTO].self, from: data)
    }

    /// 离线新建在本地先立起来的那一行 DTO：CREATE 请求体补上临时 id
    /// 后按 EventDTO 解码（多出来的 clientUid 等键解码时自动忽略）。
    static func localDTO(forCreateBody data: Data, tempId: String) -> EventDTO? {
        guard var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        obj["id"] = tempId
        guard let injected = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return try? JSONDecoder.iso().decode(EventDTO.self, from: injected)
    }

    static func localEventId(clientUid: String) -> String { "local:\(clientUid)" }

    // MARK: JSON 小工具

    private static func parseObject(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func serializeObject(_ obj: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// 队列文件存储：一账号一个文件，Documents/pending-ops-v1-<账号键>.json。
/// 文件很小（几十条条目封顶），同步读写 + NSLock 串行即可——不像
/// EventCache 那样有成千上万条事件要躲开主线程。
private final class PendingOpFileStore: @unchecked Sendable {
    static let shared = PendingOpFileStore()
    private let lock = NSLock()
    private let fileManager = FileManager.default

    private func fileURL(accountKey: String) -> URL? {
        guard let dir = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        let safe = accountKey
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .replacingOccurrences(of: "|", with: "_")
        return dir.appendingPathComponent("pending-ops-v1-\(safe).json")
    }

    func load(accountKey: String) -> [PendingOp] {
        lock.lock(); defer { lock.unlock() }
        guard let url = fileURL(accountKey: accountKey),
              let data = try? Data(contentsOf: url),
              let ops = try? JSONDecoder().decode([PendingOp].self, from: data)
        else { return [] }
        return ops.sorted { $0.seq < $1.seq }
    }

    func save(accountKey: String, ops: [PendingOp]) {
        lock.lock(); defer { lock.unlock() }
        guard let url = fileURL(accountKey: accountKey),
              let data = try? JSONEncoder().encode(ops) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

@MainActor
final class OfflineSyncService: ObservableObject {
    @Published private(set) var ops: [PendingOp] = []

    private weak var state: AppState?
    private var replaying = false
    private var completedCreates: [String: EventDTO] = [:]
    private var pathMonitor: NWPathMonitor?

    var pendingIds: Set<String> { Set(ops.map { $0.eventId }) }
    var pendingCount: Int { ops.count { $0.state == .pending } }
    var attentionCount: Int { ops.count { $0.state == .attention } }

    /// 重放结束后要通知日历页刷新一次（服务端状态已经变了，本地的
    /// 临时行要换成真实行）。CalendarView 在 onAppear 时挂上。
    var onReplayFinished: (() -> Void)?

    func bind(state: AppState) {
        self.state = state
        reload()
        // 网络恢复触发点：NWPathMonitor 说有可用网络了就推一轮。
        // 回前台（CalendarView 的 scenePhase + 轮询加载成功后）也会
        // 各踢一脚，这里是最及时的一路。
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor [weak self] in await self?.replay() }
        }
        monitor.start(queue: DispatchQueue(label: "cn.bywave.calendar.offline-path"))
    }

    /// 账号切换 / 重新登录后调用：换成那个账号的队列。队列文件按
    /// 账号键存，退出登录不清，所以这里只是换内存里的这一份。
    func accountChanged() {
        reload()
    }

    func reload() {
        guard let key = currentAccountKey else { ops = []; return }
        ops = PendingOpFileStore.shared.load(accountKey: key)
    }

    private var currentAccountKey: String? {
        guard let profile = state?.activeProfile else { return nil }
        return "\(profile.serverURLString)|\(profile.userEmail ?? "")"
    }

    private func persist() {
        guard let key = currentAccountKey else { return }
        PendingOpFileStore.shared.save(accountKey: key, ops: ops)
    }

    private func nextSeq() -> Int64 { (ops.map { $0.seq }.max() ?? 0) + 1 }

    // MARK: 入队（视图在本地改动落下去的同时调用）

    func enqueueCreate(bodyData: Data, localDTO: EventDTO, clientUid: String?) {
        guard let key = currentAccountKey else { return }
        let op = PendingOp(
            id: UUID().uuidString, seq: nextSeq(), accountKey: key,
            kind: .create, eventId: localDTO.id, clientUid: clientUid,
            payloadJson: String(data: bodyData, encoding: .utf8),
            snapshotJson: PendingOpLogic.encodeSnapshot([localDTO]),
            summary: localDTO.summary,
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000),
        )
        ops = PendingOpLogic.enqueue(queue: ops, op: op)
        persist()
    }

    func enqueueUpdate(eventId: String, bodyData: Data, scope: String?, recurrenceId: String?,
                       baseStartsAt: String?, snapshot: [EventDTO], summary: String) {
        guard let key = currentAccountKey else { return }
        let op = PendingOp(
            id: UUID().uuidString, seq: nextSeq(), accountKey: key,
            kind: .update, eventId: eventId,
            payloadJson: String(data: bodyData, encoding: .utf8),
            scope: scope, recurrenceId: recurrenceId, baseStartsAt: baseStartsAt,
            snapshotJson: PendingOpLogic.encodeSnapshot(snapshot),
            summary: summary,
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000),
        )
        ops = PendingOpLogic.enqueue(queue: ops, op: op)
        persist()
    }

    func enqueueDelete(eventId: String, scope: String?, recurrenceId: String?,
                       snapshot: [EventDTO], summary: String) {
        guard let key = currentAccountKey else { return }
        let normalizedScope = (scope == "series") ? nil : scope
        let op = PendingOp(
            id: UUID().uuidString, seq: nextSeq(), accountKey: key,
            kind: .delete, eventId: eventId,
            scope: normalizedScope, recurrenceId: recurrenceId,
            snapshotJson: PendingOpLogic.encodeSnapshot(snapshot),
            summary: summary,
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000),
        )
        ops = PendingOpLogic.enqueue(queue: ops, op: op)
        persist()
    }

    /// 撤销一次还没同步出去的删除：条目还在队列里就直接抵消，
    /// 返回当时存的行快照让界面立刻放回去。不需要网络。条目已
    /// 落定则返回 nil，调用方走服务端 restore。
    func cancelPendingDelete(eventId: String) -> [EventDTO]? {
        guard let idx = ops.firstIndex(where: {
            $0.kind == .delete && $0.eventId == eventId && $0.state == .pending
        }) else { return nil }
        let op = ops.remove(at: idx)
        persist()
        return PendingOpLogic.decodeSnapshot(op.snapshotJson) ?? []
    }

    // MARK: 待处理裁决

    func resolveAttention(opId: String, resolution: AttentionResolution) async {
        guard let idx = ops.firstIndex(where: { $0.id == opId }) else { return }
        switch resolution {
        case .keepMine:
            ops[idx].state = .pending
            ops[idx].attempts = 0
            ops[idx].nextRetryAtMs = 0
            ops[idx].errorCode = nil
            ops[idx].errorMessage = nil
            persist()
            await replay()
        case .useServer, .discard:
            // 丢弃本地改动：条目移除后，下一次窗口拉取的 overlay 不再
            // 套这条改动，服务端版本自然回来；界面层在裁决后会主动
            // 刷新一次，不必等轮询。
            ops.remove(at: idx)
            persist()
        }
    }

    // MARK: 展示合并（CalendarView 的各条加载路径调用）

    func overlay(_ events: [EventDTO]) -> [EventDTO] {
        PendingOpLogic.overlay(server: events, ops: ops)
    }

    func localDTO(forCreateBody data: Data, tempId: String) -> EventDTO? {
        PendingOpLogic.localDTO(forCreateBody: data, tempId: tempId)
    }

    func applyingUpdate(_ dto: EventDTO, payloadJson: String?) -> EventDTO {
        PendingOpLogic.applyingUpdate(dto, payloadJson: payloadJson, timeFields: true)
    }

    // MARK: 重放

    /// 推一轮队列。返回是否有条目在本轮落定（落定意味着服务端状态
    /// 变了，调用方值得再拉一次）。已在跑就直接返回 false——那一轮
    /// 每步都重读 ops，新入队的条目自然被捎上。
    @discardableResult
    func replay() async -> Bool {
        guard !replaying, let state, state.isSignedIn, state.activeProfile != nil else { return false }
        replaying = true
        defer { replaying = false }
        var drained = false
        let client = APIClient(state: state)
        while let head = ops.first(where: { $0.state == .pending }) {
            if head.nextRetryAtMs > Int64(Date().timeIntervalSince1970 * 1000) { break }
            do {
                switch head.kind {
                case .create:
                    let body = Data((head.payloadJson ?? "").utf8)
                    let dto: EventDTO = try await client.postRaw("/events", bodyData: body)
                    completedCreates[head.eventId] = dto
                    removeOp(id: head.id)
                    // 后续条目可能还指着临时 id，统一改写成真实 id。
                    ops = ops.map { $0.eventId == head.eventId ? mutated($0, eventId: dto.id) : $0 }
                    persist()
                case .update:
                    let body = Data((head.payloadJson ?? "").utf8)
                    let _: EventDTO = try await client.patchRaw("/events/\(head.eventId)", bodyData: body)
                    removeOp(id: head.id)
                    persist()
                case .delete:
                    try await client.delete(Self.deletePath(for: head))
                    removeOp(id: head.id)
                    persist()
                }
                drained = true
            } catch is CancellationError {
                // 账号在请求途中换了：这一轮到此为止，条目原样留着。
                break
            } catch {
                let (verdict, code, message) = PendingOpLogic.classify(kind: head.kind, error: error)
                switch verdict {
                case .done:
                    removeOp(id: head.id)
                    persist()
                    drained = true
                case .gone:
                    removeOp(id: head.id)
                    persist()
                    drained = true
                case .retryable:
                    updateOp(id: head.id) {
                        $0.attempts += 1
                        $0.nextRetryAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                            + PendingOpLogic.backoffMs(attempts: $0.attempts)
                    }
                    persist()
                    return drained
                case .attention:
                    updateOp(id: head.id) {
                        $0.state = .attention
                        $0.errorCode = code
                        $0.errorMessage = message
                    }
                    persist()
                    // 继续推下一条：这条是被明确拒绝的，挡住后面
                    // 不相干的条目没有道理。
                case .authBlocked:
                    return drained
                }
            }
        }
        if drained { onReplayFinished?() }
        return drained
    }

    /// 编辑器保存新建后调用：推一轮，落定了就把服务端 DTO 还回去
    ///（界面要拿真实 id 记「已创建」条），没落定返回 nil（用本地 DTO）。
    func replayCreate(tempId: String) async -> EventDTO? {
        await replay()
        return completedCreates.removeValue(forKey: tempId)
    }

    private func removeOp(id: String) {
        ops.removeAll { $0.id == id }
    }

    private func updateOp(id: String, _ change: (inout PendingOp) -> Void) {
        guard let idx = ops.firstIndex(where: { $0.id == id }) else { return }
        change(&ops[idx])
    }

    private func mutated(_ op: PendingOp, eventId: String) -> PendingOp {
        var copy = op
        copy.eventId = eventId
        return copy
    }

    /// DELETE 的路径：作用域走 query（DELETE 没有 body），和事件
    /// 详情页一直以来的拼法一致。
    static func deletePath(for op: PendingOp) -> String {
        var path = "/events/\(op.eventId)"
        if let scope = op.scope, let recId = op.recurrenceId {
            let encoded = recId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? recId
            path += "?scope=\(scope)&recurrenceId=\(encoded)"
        }
        return path
    }
}
