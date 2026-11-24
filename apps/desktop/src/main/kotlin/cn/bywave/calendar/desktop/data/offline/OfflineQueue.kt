// OfflineQueue — 桌面端的离线写队列引擎。
//
// 语义与 Android / iOS 共用一份（shared/PendingOps.kt）：建 / 改 /
// 删先落本地 + 入队，保序重放；5xx 与网络错误退避，4xx 业务拒绝
// 停进待处理等用户裁决，401 整队暂停。合并 / 退避 / 错误分流的
// 纯逻辑都在 shared 里，这里只做：队列落盘（PendingOpStore）、
// 用 ApiClient 重放、把未同步条目合并进展示集（overlay）。
//
// 桌面没有本地事件库，事件活在 CalendarState 的 StateFlow 里，
// 所以条目自带本地行快照（snapshotJson）：离线新建的那一行、
// 裁决回滚要恢复的行，都从条目里取。窗口缓存文件里存的始终是
// 服务端原始响应，overlay 只在读出来展示时套。
//
// 桌面常在线，但休眠唤醒 / 网络切换 / VPN 抖动的窗口里同样会
// 攒下条目；触发点是每次 load 成功后 + 回到前台的 refreshIfIdle
//（MainScreen 已有焦点与定时刷新，都走 load）。

package cn.bywave.calendar.desktop.data.offline

import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.api.ApiException
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventExtra
import cn.bywave.calendar.desktop.data.model.EventExtraDTO
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.sync.ConfirmedEventDeletion
import cn.bywave.calendar.sync.PendingOp
import cn.bywave.calendar.sync.PendingOpBackoff
import cn.bywave.calendar.sync.PendingOpErrors
import cn.bywave.calendar.sync.PendingOpKind
import cn.bywave.calendar.sync.PendingOpMerger
import cn.bywave.calendar.sync.PendingOpState
import cn.bywave.calendar.sync.PendingOpVerdict
import cn.bywave.calendar.sync.localEventId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.util.UUID

enum class AttentionResolution { KEEP_MINE, USE_SERVER, DISCARD }

class OfflineQueue(
    private val client: ApiClient,
    private val scope: CoroutineScope,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val accountKey: String? = client.accountKey

    private val _ops = MutableStateFlow<List<PendingOp>>(
        accountKey?.let { PendingOpStore.read(it) } ?: emptyList(),
    )
    val ops: StateFlow<List<PendingOp>> = _ops.asStateFlow()

    private val queueMutex = Mutex()
    private val replayMutex = Mutex()
    private val completedCreates = mutableMapOf<String, EventDTO>()

    /** 有条目落定后回调（CalendarState 挂成「再 load 一次」：
     *  服务端状态变了，本地临时行要换成真实行）。 */
    var onDrained: (() -> Unit)? = null

    val pendingIds: Set<String> get() = _ops.value.map { it.eventId }.toSet()

    /** 队列里 CREATE 条目的临时 id 集。增量同步应用计划要把它们
     *  从服务端底稿里排除（本地新建行不是服务端镜像的一部分），
     *  与 pendingIds 分开给：protectedIds 是按主事件 id 保护，
     *  这一份是按临时行 id 排除，语义不同。 */
    val localCreateIds: Set<String> get() = _ops.value
        .filter { it.kind == PendingOpKind.CREATE }
        .map { it.eventId }
        .toSet()

    private fun persistLocked() {
        val key = accountKey ?: return
        PendingOpStore.write(key, _ops.value)
    }

    /** 入队（合并规则在 PendingOpMerger）。调用方必须持有 queueMutex。 */
    private fun enqueueLocked(op: PendingOp) {
        val key = accountKey ?: return
        val withSeq = op.copy(
            accountKey = key,
            seq = (_ops.value.maxOfOrNull { it.seq } ?: 0L) + 1,
        )
        _ops.value = PendingOpMerger.enqueue(_ops.value, withSeq)
        persistLocked()
    }

    // ---- 提交（入队 + 立即尝试重放；本地乐观显示由 CalendarState
    //      在调用前后自己套 overlay / 快照完成） ----

    /** 返回最终形态的 DTO：已同步就是服务端那份（真实 id），还
     *  在排队就是本地那份（临时 id，界面照样能打开 / 再编辑）。 */
    suspend fun submitCreate(input: EventCreateInput, clientUid: String): EventDTO {
        val tempId = localEventId(clientUid)
        val withUid = input.copy(clientUid = clientUid)
        val local = localDtoForCreate(tempId, withUid)
        val op = PendingOp(
            id = UUID.randomUUID().toString(),
            seq = 0,
            accountKey = "",
            kind = PendingOpKind.CREATE,
            eventId = tempId,
            clientUid = clientUid,
            payloadJson = json.encodeToString(EventCreateInput.serializer(), withUid),
            snapshotJson = json.encodeToString(
                ListSerializer(EventDTO.serializer()), listOf(local),
            ),
            summary = input.summary,
            createdAtMs = System.currentTimeMillis(),
        )
        queueMutex.withLock { enqueueLocked(op) }
        replay()
        return queueMutex.withLock { completedCreates.remove(tempId) } ?: local
    }

    suspend fun submitUpdate(
        eventId: String,
        input: EventUpdateInput,
        summary: String,
        baseStartsAt: String?,
        snapshot: List<EventDTO>,
    ) {
        val op = PendingOp(
            id = UUID.randomUUID().toString(),
            seq = 0,
            accountKey = "",
            kind = PendingOpKind.UPDATE,
            eventId = eventId,
            payloadJson = json.encodeToString(EventUpdateInput.serializer(), input),
            scope = input.scope,
            recurrenceId = input.recurrenceId,
            baseStartsAt = baseStartsAt,
            snapshotJson = json.encodeToString(ListSerializer(EventDTO.serializer()), snapshot),
            summary = summary,
            createdAtMs = System.currentTimeMillis(),
        )
        queueMutex.withLock { enqueueLocked(op) }
        replay()
    }

    suspend fun submitDelete(
        eventId: String,
        scope: String?,
        recurrenceId: String?,
        snapshot: List<EventDTO>,
        summary: String,
    ) {
        val op = PendingOp(
            id = UUID.randomUUID().toString(),
            seq = 0,
            accountKey = "",
            kind = PendingOpKind.DELETE,
            eventId = eventId,
            scope = scope,
            recurrenceId = recurrenceId,
            snapshotJson = json.encodeToString(ListSerializer(EventDTO.serializer()), snapshot),
            summary = summary,
            createdAtMs = System.currentTimeMillis(),
        )
        queueMutex.withLock { enqueueLocked(op) }
        replay()
    }

    /** 撤销一次还没同步出去的删除：条目还在就抵消，返回快照行让
     *  界面放回去。不需要网络。已落定返回 null，走服务端 restore。 */
    suspend fun cancelPendingDelete(eventId: String): List<EventDTO>? {
        val op = queueMutex.withLock {
            val found = _ops.value.firstOrNull {
                it.kind == PendingOpKind.DELETE && it.eventId == eventId && it.state == PendingOpState.PENDING
            } ?: return@withLock null
            _ops.value = _ops.value.filterNot { it.id == found.id }
            persistLocked()
            found
        } ?: return null
        return decodeSnapshot(op.snapshotJson)
    }

    // ---- 待处理裁决 ----

    suspend fun resolveAttention(opId: String, resolution: AttentionResolution) {
        queueMutex.withLock {
            when (resolution) {
                AttentionResolution.KEEP_MINE -> {
                    _ops.value = _ops.value.map {
                        if (it.id == opId) it.copy(
                            state = PendingOpState.PENDING,
                            attempts = 0,
                            nextRetryAtMs = 0,
                            errorCode = null,
                            errorMessage = null,
                        ) else it
                    }
                }
                AttentionResolution.USE_SERVER, AttentionResolution.DISCARD -> {
                    _ops.value = _ops.value.filterNot { it.id == opId }
                }
            }
            persistLocked()
        }
        if (resolution == AttentionResolution.KEEP_MINE) replay()
    }

    // ---- 重放 ----

    /** 在引擎自己的 scope 里推一轮（调用方不用等）。 */
    fun kickReplay() {
        scope.launch { replay() }
    }

    suspend fun replay() {
        if (accountKey == null) return
        if (!replayMutex.tryLock()) return
        var drained = false
        try {
            while (true) {
                val head = _ops.value.firstOrNull { it.state == PendingOpState.PENDING } ?: break
                if (head.nextRetryAtMs > System.currentTimeMillis()) break
                val outcome = execute(head)
                when (outcome.verdict) {
                    PendingOpVerdict.DONE -> {
                        queueMutex.withLock {
                            var rest = _ops.value.filterNot { it.id == head.id }
                            val serverDto = outcome.serverDto
                            if (head.kind == PendingOpKind.CREATE && serverDto != null) {
                                completedCreates[head.eventId] = serverDto
                                rest = rest.map {
                                    if (it.eventId == head.eventId) it.copy(eventId = serverDto.id) else it
                                }
                            }
                            _ops.value = rest
                            persistLocked()
                        }
                        drained = true
                    }
                    PendingOpVerdict.GONE -> {
                        queueMutex.withLock {
                            _ops.value = _ops.value.filterNot { it.id == head.id }
                            persistLocked()
                        }
                        drained = true
                    }
                    PendingOpVerdict.RETRYABLE -> {
                        queueMutex.withLock {
                            _ops.value = _ops.value.map {
                                if (it.id == head.id) {
                                    val attempts = it.attempts + 1
                                    it.copy(
                                        attempts = attempts,
                                        nextRetryAtMs = System.currentTimeMillis() +
                                            PendingOpBackoff.delayMs(attempts),
                                    )
                                } else it
                            }
                            persistLocked()
                        }
                        break
                    }
                    PendingOpVerdict.ATTENTION -> {
                        queueMutex.withLock {
                            _ops.value = _ops.value.map {
                                if (it.id == head.id) it.copy(
                                    state = PendingOpState.ATTENTION,
                                    errorCode = outcome.errorCode,
                                    errorMessage = outcome.errorMessage,
                                ) else it
                            }
                            persistLocked()
                        }
                        // 继续推下一条：这条被明确拒绝，挡住后面不相干的条目没道理。
                    }
                    PendingOpVerdict.AUTH_BLOCKED -> break
                }
            }
        } finally {
            replayMutex.unlock()
        }
        if (drained) onDrained?.invoke()
    }

    private data class ExecOutcome(
        val verdict: PendingOpVerdict,
        val serverDto: EventDTO? = null,
        val errorCode: String? = null,
        val errorMessage: String? = null,
    )

    private suspend fun execute(op: PendingOp): ExecOutcome {
        return try {
            when (op.kind) {
                PendingOpKind.CREATE -> {
                    val input = json.decodeFromString(
                        EventCreateInput.serializer(),
                        requireNotNull(op.payloadJson),
                    )
                    ExecOutcome(PendingOpVerdict.DONE, serverDto = client.createEvent(input))
                }
                PendingOpKind.UPDATE -> {
                    val input = json.decodeFromString(
                        EventUpdateInput.serializer(),
                        requireNotNull(op.payloadJson),
                    )
                    client.updateEvent(op.eventId, input)
                    ExecOutcome(PendingOpVerdict.DONE)
                }
                PendingOpKind.DELETE -> {
                    client.deleteEvent(op.eventId, op.scope, op.recurrenceId)
                    ExecOutcome(PendingOpVerdict.DONE)
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: ApiException) {
            ExecOutcome(
                verdict = PendingOpErrors.classify(op.kind, e.status, networkError = false),
                errorMessage = e.message,
            )
        } catch (e: Exception) {
            // 连不上、超时、解码失败都按可重试：宁可多试几次，也不能
            // 把用户的改动误判成被拒绝而停进待处理。
            ExecOutcome(PendingOpErrors.classify(op.kind, null, networkError = true))
        }
    }

    // ---- 展示合并 ----

    /**
     * 服务端（或窗口缓存）行 + 未同步条目 → 展示集：
     * 待删剔除、待改套用（非时间字段套每一行，时间字段只套
     * baseStartsAt 对着的那一行）、待建从条目快照追加。幂等。
     */
    fun overlay(events: List<EventDTO>): List<EventDTO> {
        val ops = _ops.value
        if (ops.isEmpty()) return events
        var out = events
        val deletes = ops.filter { it.kind == PendingOpKind.DELETE }
        if (deletes.isNotEmpty()) {
            out = out.filter { dto ->
                deletes.none {
                    ConfirmedEventDeletion(it.eventId, it.scope, it.recurrenceId)
                        .removes(dto.id, dto.startsAt)
                }
            }
        }
        for (op in ops.filter { it.kind == PendingOpKind.UPDATE }.sortedBy { it.seq }) {
            val input = op.payloadJson?.let {
                runCatching { json.decodeFromString(EventUpdateInput.serializer(), it) }.getOrNull()
            } ?: continue
            out = out.map { dto ->
                if (dto.id != op.eventId) {
                    dto
                } else if (op.scope != null) {
                    if (dto.startsAt == op.recurrenceId) applyUpdateToDto(dto, input) else dto
                } else if (dto.startsAt == op.baseStartsAt) {
                    applyUpdateToDto(dto, input)
                } else {
                    applyUpdateToDto(dto, input, timeFields = false)
                }
            }
        }
        val creates = ops.filter { it.kind == PendingOpKind.CREATE }
        if (creates.isNotEmpty()) {
            val present = out.map { it.id }.toSet()
            for (op in creates) {
                if (op.eventId in present) continue
                decodeSnapshot(op.snapshotJson)?.firstOrNull()?.let { out = out + it }
            }
        }
        return out
    }

    /** 把一条 PATCH 请求体套到 DTO 上。null 字段 = 没改，保持原值。
     *  extra 按服务端浅合并语义在 JSON 层合并一层。 */
    fun applyUpdateToDto(dto: EventDTO, input: EventUpdateInput, timeFields: Boolean = true): EventDTO {
        var out = dto
        input.calendarId?.let { out = out.copy(calendarId = it) }
        input.summary?.let { out = out.copy(summary = it) }
        input.description?.let { out = out.copy(description = it) }
        input.location?.let { out = out.copy(location = it) }
        if (timeFields) {
            input.startsAt?.let { out = out.copy(startsAt = it) }
            input.endsAt?.let { out = out.copy(endsAt = it) }
        }
        input.allDay?.let { out = out.copy(allDay = it) }
        input.rrule?.let { out = out.copy(rrule = it) }
        input.exdates?.let { out = out.copy(exdates = it) }
        input.extra?.let { extra ->
            val oldObj = out.extra?.let {
                json.encodeToJsonElement(EventExtraDTO.serializer(), it).jsonObject
            } ?: JsonObject(emptyMap())
            val newObj = json.encodeToJsonElement(EventExtra.serializer(), extra).jsonObject
            val merged = JsonObject(oldObj + newObj)
            out = out.copy(
                extra = runCatching {
                    json.decodeFromJsonElement(EventExtraDTO.serializer(), merged)
                }.getOrNull(),
            )
        }
        return out
    }

    /** 一条 UPDATE 真正命中的展示行（给 CalendarState 做即时乐观
     *  套用，与 overlay 同一条规矩）。 */
    fun applyToRows(rows: List<EventDTO>, op: PendingOp): List<EventDTO> {
        val input = op.payloadJson?.let {
            runCatching { json.decodeFromString(EventUpdateInput.serializer(), it) }.getOrNull()
        } ?: return rows
        return rows.map { dto ->
            if (dto.id != op.eventId) {
                dto
            } else if (op.scope != null) {
                if (dto.startsAt == op.recurrenceId) applyUpdateToDto(dto, input) else dto
            } else if (dto.startsAt == op.baseStartsAt) {
                applyUpdateToDto(dto, input)
            } else {
                applyUpdateToDto(dto, input, timeFields = false)
            }
        }
    }

    private fun decodeSnapshot(snapshotJson: String?): List<EventDTO> =
        snapshotJson?.let {
            runCatching { json.decodeFromString(ListSerializer(EventDTO.serializer()), it) }.getOrNull()
        } ?: emptyList()

    /** 离线新建在本地先立起来的那一行 DTO：CREATE 请求体补上临时
     *  id 后按 EventDTO 解码，形状与服务端将来返回的行一致。 */
    private fun localDtoForCreate(tempId: String, input: EventCreateInput): EventDTO {
        val obj = json.encodeToJsonElement(EventCreateInput.serializer(), input).jsonObject
        val withId = JsonObject(obj + ("id" to JsonPrimitive(tempId)))
        return json.decodeFromJsonElement(EventDTO.serializer(), withId)
    }
}
