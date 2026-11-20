// OfflineQueue — Android 端的离线写队列引擎。
//
// 建 / 改 / 删事件先落本地（Room 事件行立刻改）+ 入队，然后尽快
// 重放；断网、服务端 5xx 就退避等下一次触发，4xx 业务拒绝停进
// 待处理等用户裁决。合并 / 退避 / 错误分流的纯逻辑在 shared 的
// PendingOps.kt 里（三端共用一份语义），这里只做三件事：
//   1. 把改动乐观地写进 Room 并入队（与 fetchAndCache 的快照应用
//      共用 SnapshotMutationGate 串行，避免互相覆盖）；
//   2. 按 seq 保序重放，CREATE 落定后把本地临时 id 换成服务端 id；
//   3. 窗口拉取时把服务端行与未同步条目合并（mergeServerEvents），
//      保证刷新不把本地改动冲掉、也不复活已删的事件。
//
// 队列按 accountKey（serverUrl|email）归属，不按 profile id：
// 退出登录再重新配对，profile id 会换、账号键不变，队列能续传。
// 退出登录 / 移除账号都不清队列（清缓存的路径不碰 pending_ops），
// 免得把用户还没送出去的改动一起扔掉。

package cn.bywave.calendar.data.store

import androidx.room.withTransaction
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.auth.ProfileStore
import cn.bywave.calendar.data.model.EventCreateInput
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.EventUpdateInput
import cn.bywave.calendar.sync.ConfirmedEventDeletion
import cn.bywave.calendar.sync.PendingOp
import cn.bywave.calendar.sync.PendingOpBackoff
import cn.bywave.calendar.sync.PendingOpErrors
import cn.bywave.calendar.sync.PendingOpKind
import cn.bywave.calendar.sync.PendingOpMerger
import cn.bywave.calendar.sync.PendingOpState
import cn.bywave.calendar.sync.PendingOpVerdict
import cn.bywave.calendar.sync.SnapshotMutationGate
import cn.bywave.calendar.sync.isLocalEventId
import cn.bywave.calendar.sync.localEventId
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException
import java.util.UUID

enum class AttentionResolution { KEEP_MINE, USE_SERVER, DISCARD }

class OfflineQueue(
    private val db: AppDatabase,
    private val profiles: ProfileStore,
    private val gate: SnapshotMutationGate,
    private val dtoJson: Json,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val queueMutex = Mutex()
    private val replayMutex = Mutex()

    fun accountKeyOf(profile: Profile): String = "${profile.serverUrl}|${profile.email}"

    // ---- 读取 ----

    fun observeFor(profile: Profile): Flow<List<PendingOp>> =
        db.pendingOpDao().observeForAccount(accountKeyOf(profile))
            .map { rows -> rows.mapNotNull { decodeOp(it) } }

    suspend fun pendingFor(profile: Profile): List<PendingOp> =
        queueMutex.withLock { loadQueue(accountKeyOf(profile)) }

    private fun decodeOp(row: PendingOpEntity): PendingOp? =
        runCatching { json.decodeFromString(PendingOp.serializer(), row.payload) }.getOrNull()

    private fun encodeOp(op: PendingOp): PendingOpEntity = PendingOpEntity(
        id = op.id,
        accountKey = op.accountKey,
        seq = op.seq,
        eventId = op.eventId,
        state = op.state.name,
        summary = op.summary,
        payload = json.encodeToString(PendingOp.serializer(), op),
    )

    private suspend fun loadQueue(accountKey: String): List<PendingOp> =
        db.pendingOpDao().listForAccount(accountKey).mapNotNull { decodeOp(it) }.sortedBy { it.seq }

    /** 调用方必须持有 queueMutex。 */
    private suspend fun storeQueueLocked(accountKey: String, ops: List<PendingOp>) {
        db.withTransaction {
            db.pendingOpDao().clearAccount(accountKey)
            ops.forEach { db.pendingOpDao().upsert(encodeOp(it)) }
        }
    }

    /** 入队（合并规则在 PendingOpMerger）。调用方必须持有 queueMutex。 */
    private suspend fun enqueueLocked(profile: Profile, op: PendingOp): List<PendingOp> {
        val key = accountKeyOf(profile)
        val current = loadQueue(key)
        val withSeq = op.copy(
            accountKey = key,
            seq = (current.maxOfOrNull { it.seq } ?: 0L) + 1,
        )
        val merged = PendingOpMerger.enqueue(current, withSeq)
        storeQueueLocked(key, merged)
        return merged
    }

    // ---- 提交（乐观写本地 + 入队 + 立即尝试重放） ----
    //
    // submitUpdate / submitDelete 返回「是否已经同步落定」：条目
    // 还留在队列里（含停进待处理）就是 false。调用方（编辑器）
    // 不区分这两种未落定——都算保存成功、关编辑器，区别只在
    // 日历页的待同步指示上。submitCreate 返回最终形态的 DTO。

    /** 刚落定的新建：临时 id → 服务端返回的真实 DTO。快速添加的
     *  「已创建」提示要拿真实 id 去打开 / 撤销，所以重放落定时先
     *  攒在这里，submitCreate 回来取。 */
    private val completedCreates = mutableMapOf<String, EventDTO>()

    /** 返回最终形态的 DTO：已同步就是服务端那份（真实 id），还
     *  在排队就是本地那份（临时 id，界面照样能打开 / 再编辑）。 */
    suspend fun submitCreate(profile: Profile, input: EventCreateInput, clientUid: String): EventDTO {
        val tempId = localEventId(clientUid)
        val dto = localDtoForCreate(tempId, input)
        val op = PendingOp(
            id = UUID.randomUUID().toString(),
            seq = 0,
            accountKey = "",
            kind = PendingOpKind.CREATE,
            eventId = tempId,
            clientUid = clientUid,
            payloadJson = json.encodeToString(EventCreateInput.serializer(), input),
            summary = input.summary,
            createdAtMs = System.currentTimeMillis(),
        )
        gate.mutate {
            db.withTransaction {
                db.eventDao().insertAll(listOf(EventEntity.from(dto, profile.id, dtoJson)))
            }
            queueMutex.withLock { enqueueLocked(profile, op) }
        }
        replay(profile)
        return queueMutex.withLock { completedCreates.remove(tempId) } ?: dto
    }

    suspend fun submitUpdate(
        profile: Profile,
        eventId: String,
        input: EventUpdateInput,
        summary: String,
        baseStartsAt: String?,
    ): Boolean {
        val rows = db.eventDao().listForProfile(profile.id).filter { it.id == eventId }
        val targets = targetRows(rows, input)
        val snapshot = targets.map { it.toDto(dtoJson) }
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
        gate.mutate {
            db.withTransaction {
                if (targets.isNotEmpty()) {
                    db.eventDao().deleteRows(targets)
                    db.eventDao().insertAll(targets.map { row ->
                        // 时间字段只套编辑时对着的那一行：整事件的其余
                        // 发生（occurrence）各有自己的 startsAt，全套
                        // 上去会把它们压成同一行（和 mergeServerEvents
                        // 同一条规矩）。
                        val withTime = input.scope != null || row.startsAt == baseStartsAt
                        EventEntity.from(
                            applyUpdateToDto(row.toDto(dtoJson), input, timeFields = withTime),
                            profile.id, dtoJson,
                        )
                    })
                }
            }
            queueMutex.withLock { enqueueLocked(profile, op) }
        }
        replay(profile)
        return queueMutex.withLock { loadQueue(accountKeyOf(profile)).none { it.eventId == eventId } }
    }

    suspend fun submitDelete(profile: Profile, eventId: String, scope: String?, recurrenceId: String?): Boolean {
        val deletion = ConfirmedEventDeletion(eventId, scope, recurrenceId)
        val rows = db.eventDao().listForProfile(profile.id)
            .filter { deletion.removes(it.id, it.startsAt) }
        val snapshot = rows.map { it.toDto(dtoJson) }
        val op = PendingOp(
            id = UUID.randomUUID().toString(),
            seq = 0,
            accountKey = "",
            kind = PendingOpKind.DELETE,
            eventId = eventId,
            scope = scope,
            recurrenceId = recurrenceId,
            snapshotJson = json.encodeToString(ListSerializer(EventDTO.serializer()), snapshot),
            summary = snapshot.firstOrNull()?.summary ?: "",
            createdAtMs = System.currentTimeMillis(),
        )
        gate.mutate {
            db.withTransaction { if (rows.isNotEmpty()) db.eventDao().deleteRows(rows) }
            queueMutex.withLock { enqueueLocked(profile, op) }
        }
        replay(profile)
        return queueMutex.withLock {
            loadQueue(accountKeyOf(profile)).none { it.kind == PendingOpKind.DELETE && it.eventId == eventId }
        }
    }

    /** 撤销一次还没同步出去的删除（日历页「已删除 · 撤销」在离线时
     *  的走法）：条目还在队列里就直接抵消 + 把本地行放回去，根本
     *  不需要网络。条目已落定则返回 false，调用方走服务端 restore。 */
    suspend fun cancelPendingDelete(profile: Profile, eventId: String): Boolean {
        val key = accountKeyOf(profile)
        val op = queueMutex.withLock {
            val ops = loadQueue(key)
            val found = ops.firstOrNull {
                it.kind == PendingOpKind.DELETE && it.eventId == eventId && it.state == PendingOpState.PENDING
            } ?: return@withLock null
            storeQueueLocked(key, ops.filterNot { it.id == found.id })
            found
        } ?: return false
        restoreSnapshot(profile, op)
        return true
    }

    // ---- 待处理裁决 ----

    suspend fun resolveAttention(profile: Profile, opId: String, resolution: AttentionResolution) {
        val key = accountKeyOf(profile)
        val op = queueMutex.withLock {
            val ops = loadQueue(key)
            val found = ops.firstOrNull { it.id == opId } ?: return@withLock null
            when (resolution) {
                AttentionResolution.KEEP_MINE -> {
                    storeQueueLocked(key, ops.map {
                        if (it.id == opId) it.copy(
                            state = PendingOpState.PENDING,
                            attempts = 0,
                            nextRetryAtMs = 0,
                            errorCode = null,
                            errorMessage = null,
                        ) else it
                    })
                    found
                }
                AttentionResolution.USE_SERVER, AttentionResolution.DISCARD -> {
                    storeQueueLocked(key, ops.filterNot { it.id == opId })
                    found
                }
            }
        } ?: return
        if (resolution != AttentionResolution.KEEP_MINE) {
            // 丢弃本地改动：把本地行恢复到这条改动落下去之前的样子
            // （UPDATE / DELETE 有快照；CREATE 直接删掉临时行）。
            // 服务端版本随下一次窗口拉取覆盖，这一步只是让界面立刻
            // 回到改动前，不必等网络。
            gate.mutate {
                db.withTransaction {
                    val rows = db.eventDao().listForProfile(profile.id).filter { it.id == op.eventId }
                    if (rows.isNotEmpty()) db.eventDao().deleteRows(rows)
                }
                if (op.kind != PendingOpKind.CREATE) restoreSnapshotRows(profile, op)
            }
        }
        replay(profile)
    }

    private suspend fun restoreSnapshot(profile: Profile, op: PendingOp) {
        gate.mutate { restoreSnapshotRows(profile, op) }
    }

    private suspend fun restoreSnapshotRows(profile: Profile, op: PendingOp) {
        val dtos = op.snapshotJson?.let {
            runCatching { json.decodeFromString(ListSerializer(EventDTO.serializer()), it) }.getOrNull()
        } ?: return
        db.withTransaction {
            db.eventDao().insertAll(dtos.map { EventEntity.from(it, profile.id, dtoJson) })
        }
    }

    // ---- 重放 ----

    /** 把队列往前推。已有重放在跑就直接返回（它每轮都重读队列，
     *  新入队的条目自然会被捎上）。 */
    suspend fun replay(profile: Profile) {
        if (!replayMutex.tryLock()) return
        try {
            val key = accountKeyOf(profile)
            val client = ApiClient.forProfile(profile, profiles)
            while (true) {
                val head = queueMutex.withLock {
                    loadQueue(key).firstOrNull { it.state == PendingOpState.PENDING }
                } ?: break
                if (head.nextRetryAtMs > System.currentTimeMillis()) break
                val outcome = execute(client, head)
                when (outcome.verdict) {
                    PendingOpVerdict.DONE -> {
                        queueMutex.withLock {
                            var rest = loadQueue(key).filterNot { it.id == head.id }
                            val serverDto = outcome.serverDto
                            if (head.kind == PendingOpKind.CREATE && serverDto != null) {
                                // 本地临时 id 退场：后面排队的作用域改动
                                // 可能还指着临时 id，统一改写成真实 id。
                                rest = rest.map {
                                    if (it.eventId == head.eventId) it.copy(eventId = serverDto.id) else it
                                }
                            }
                            storeQueueLocked(key, rest)
                        }
                        val serverDto = outcome.serverDto
                        if (head.kind == PendingOpKind.CREATE && serverDto != null) {
                            queueMutex.withLock { completedCreates[head.eventId] = serverDto }
                            gate.mutate {
                                db.withTransaction {
                                    val rows = db.eventDao().listForProfile(profile.id)
                                        .filter { it.id == head.eventId }
                                    if (rows.isNotEmpty()) db.eventDao().deleteRows(rows)
                                    db.eventDao().insertAll(
                                        listOf(EventEntity.from(serverDto, profile.id, dtoJson)),
                                    )
                                }
                            }
                        }
                    }
                    PendingOpVerdict.GONE -> {
                        queueMutex.withLock {
                            storeQueueLocked(key, loadQueue(key).filterNot { it.id == head.id })
                        }
                        gate.mutate {
                            db.withTransaction {
                                val rows = db.eventDao().listForProfile(profile.id)
                                    .filter { it.id == head.eventId }
                                if (rows.isNotEmpty()) db.eventDao().deleteRows(rows)
                            }
                        }
                    }
                    PendingOpVerdict.RETRYABLE -> {
                        val attempts = head.attempts + 1
                        queueMutex.withLock {
                            storeQueueLocked(key, loadQueue(key).map {
                                if (it.id == head.id) it.copy(
                                    attempts = attempts,
                                    nextRetryAtMs = System.currentTimeMillis() +
                                        PendingOpBackoff.delayMs(attempts),
                                ) else it
                            })
                        }
                        break
                    }
                    PendingOpVerdict.ATTENTION -> {
                        queueMutex.withLock {
                            storeQueueLocked(key, loadQueue(key).map {
                                if (it.id == head.id) it.copy(
                                    state = PendingOpState.ATTENTION,
                                    errorCode = outcome.errorCode,
                                    errorMessage = outcome.errorMessage,
                                ) else it
                            })
                        }
                        // 继续推下一条：这条是被服务端明确拒绝的，
                        // 挡住后面不相干的条目没有道理。
                    }
                    PendingOpVerdict.AUTH_BLOCKED -> break
                }
            }
        } finally {
            replayMutex.unlock()
        }
    }

    private data class ExecOutcome(
        val verdict: PendingOpVerdict,
        val serverDto: EventDTO? = null,
        val errorCode: String? = null,
        val errorMessage: String? = null,
    )

    private suspend fun execute(client: ApiClient, op: PendingOp): ExecOutcome {
        return try {
            when (op.kind) {
                PendingOpKind.CREATE -> {
                    val input = json.decodeFromString(
                        EventCreateInput.serializer(),
                        requireNotNull(op.payloadJson),
                    )
                    ExecOutcome(PendingOpVerdict.DONE, serverDto = client.api.createEvent(input))
                }
                PendingOpKind.UPDATE -> {
                    val input = json.decodeFromString(
                        EventUpdateInput.serializer(),
                        requireNotNull(op.payloadJson),
                    )
                    client.api.updateEvent(op.eventId, input)
                    ExecOutcome(PendingOpVerdict.DONE)
                }
                PendingOpKind.DELETE -> {
                    client.api.deleteEvent(op.eventId, op.scope, op.recurrenceId)
                    ExecOutcome(PendingOpVerdict.DONE)
                }
            }
        } catch (e: retrofit2.HttpException) {
            val body = runCatching { e.response()?.errorBody()?.string() }.getOrNull()
            val code = body?.let {
                runCatching { json.parseToJsonElement(it).jsonObject["code"]?.jsonPrimitive?.content }
                    .getOrNull()
            }
            ExecOutcome(
                verdict = PendingOpErrors.classify(op.kind, e.code(), networkError = false),
                errorCode = code,
                errorMessage = serverErrorMessage(e),
            )
        } catch (e: IOException) {
            ExecOutcome(PendingOpErrors.classify(op.kind, null, networkError = true))
        } catch (e: Exception) {
            // 解码失败、请求体损坏等一律按可重试处理：宁可多试几次，
            // 也不能把用户的改动误判成被拒绝而停进待处理。
            ExecOutcome(PendingOpErrors.classify(op.kind, null, networkError = true))
        }
    }

    // ---- 窗口拉取合并 ----

    /**
     * 把服务端窗口行与未同步条目合并成最终展示集：
     *   · 待删的服务端行剔除（整事件 / 作用域按 ConfirmedEventDeletion 语义）；
     *   · 待改的把请求体套到服务端行上（非时间字段套每一行，时间字段
     *     只套编辑时对着的那一行，见 PendingOp.baseStartsAt）；
     *   · 待建的本地行从旧缓存里捞出来追加（服务端还没有它）。
     * 纯函数（不读库），fetchAndCache 和单元测试都用它。
     */
    fun mergeServerEvents(
        server: List<EventDTO>,
        ops: List<PendingOp>,
        previousLocal: List<EventDTO>,
    ): List<EventDTO> {
        var out = server
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
        val createIds = ops.filter { it.kind == PendingOpKind.CREATE }.map { it.eventId }.toSet()
        if (createIds.isNotEmpty()) {
            out = out + previousLocal.filter { it.id in createIds }
        }
        return out
    }

    /** 把一条 PATCH 请求体套到 DTO 上。null 字段 = 这次没改，保持原值
     *  （客户端的线格式 explicitNulls=false，没改的字段根本不发）。
     *  extra 按服务端的浅合并语义在 JSON 层合并一层。 */
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
        input.extra?.let { extra ->
            val oldObj = out.extra?.let {
                json.encodeToJsonElement(
                    cn.bywave.calendar.data.model.EventExtraDTO.serializer(), it,
                ).jsonObject
            } ?: JsonObject(emptyMap())
            val newObj = json.encodeToJsonElement(
                cn.bywave.calendar.data.model.EventExtra.serializer(), extra,
            ).jsonObject
            val merged = JsonObject(oldObj + newObj)
            out = out.copy(
                extra = runCatching {
                    json.decodeFromJsonElement(
                        cn.bywave.calendar.data.model.EventExtraDTO.serializer(), merged,
                    )
                }.getOrNull(),
            )
        }
        return out
    }

    // ---- 内部小工具 ----

    /** 一条 UPDATE 真正命中的本地行：作用域写只打那一次发生，
     *  其余打这个 id 的全部行（主行 + 展开行都带着同一份字段）。 */
    private fun targetRows(rows: List<EventEntity>, input: EventUpdateInput): List<EventEntity> {
        if (rows.isEmpty()) return rows
        return if (input.scope != null && input.recurrenceId != null) {
            rows.filter { it.startsAt == input.recurrenceId }.ifEmpty { rows }
        } else {
            rows
        }
    }

    /** 离线新建在本地先立起来的那一行 DTO：把 CREATE 请求体的 JSON
     *  补上临时 id 后按 EventDTO 解码（多出来的 clientUid 等键会被
     *  ignoreUnknownKeys 吃掉），保证本地行和服务端将来返回的行
     *  形状一致。 */
    private fun localDtoForCreate(tempId: String, input: EventCreateInput): EventDTO {
        val obj = json.encodeToJsonElement(EventCreateInput.serializer(), input).jsonObject
        val withId = JsonObject(obj + ("id" to JsonPrimitive(tempId)))
        return json.decodeFromJsonElement(EventDTO.serializer(), withId)
    }

    companion object {
        /** 本地临时行是否还在（给 fetchAndCache 判断哪些旧行要保留）。 */
        fun isLocalRow(dto: EventDTO): Boolean = isLocalEventId(dto.id)
    }
}
