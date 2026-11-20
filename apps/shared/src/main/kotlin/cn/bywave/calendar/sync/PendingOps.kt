// PendingOps — 离线写队列的纯逻辑层（Android 与桌面共用，iOS 在
// OfflineSync.swift 里有一份逐条对应的实现，三端语义必须一致）。
//
// 背景：三端的事件写（建 / 改 / 删）以前全部直连服务端，断网即失败、
// 改动丢失。这里定义队列条目的形状、入队合并规则、重试退避和错误
// 分流——全是纯函数，不碰网络、不碰存储，存储与重放引擎在各端各自
// 落地（Android 用 Room、桌面用磁盘 JSON），但「什么情况下合并、
// 什么错误停下来等用户裁决」只在这里定一份。
//
// 统一语义（与网页端 outbox 对齐）：
//   · 保存先落本地 + 入队，界面立刻反映改动并标注待同步；
//   · 重放严格按 seq 保序；
//   · 4xx 业务拒绝（409 冲突、校验失败等）→ 该条停进 ATTENTION 等
//     用户裁决，其余条目继续；
//   · 5xx / 网络错误 → 指数退避重试，本轮重放停在这里（服务端多半
//     不可达，后面的条目大概率同样失败，不如省下请求）；
//   · 401 → 整个队列暂停（凭据问题不是单条的问题），等重新登录或
//     令牌刷新恢复后由下一次触发继续；
//   · DELETE 收到 404 = 目标已经不存在，删除的目的已达到，算成功；
//   · UPDATE 收到 404 = 事件在服务端已被删，本地这条改动无处可去，
//     条目丢弃、本地乐观行一并清掉（下一次窗口拉取也不会再有它）。

package cn.bywave.calendar.sync

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

enum class PendingOpKind { CREATE, UPDATE, DELETE }

enum class PendingOpState { PENDING, ATTENTION }

@Serializable
data class PendingOp(
    /** 条目自身 id（UUID），裁决、取消时按它认。 */
    val id: String,
    /** 入队顺序，全队列单调递增，重放按它保序。 */
    val seq: Long,
    /** 归属账号键（serverUrl|email）。按账号键而不是本地 profile id
     *  存：退出登录再重新配对时本地 profile id 会换，账号键不变，
     *  队列才能被重新认领续传；不同账号的条目永不串扰。 */
    val accountKey: String,
    val kind: PendingOpKind,
    /** 目标事件 id。CREATE 时是本地临时 id（见 [localEventId]），
     *  创建在服务端落定后，引擎把后续条目里的临时 id 改写为真实 id。 */
    val eventId: String,
    /** CREATE 的幂等键。重放、裁决「保留我的修改」都复用同一个值，
     *  服务端按 uid 去重，重发不会建出第二条。 */
    val clientUid: String? = null,
    /** CREATE / UPDATE 的请求体 JSON（各端自己的 wire 模型序列化）。
     *  DELETE 没有请求体，为 null。 */
    val payloadJson: String? = null,
    /** 重复事件的作用域（instance / future / series），普通写为 null。 */
    val scope: String? = null,
    /** 作用域写针对的那一次发生的 startsAt（ISO）。 */
    val recurrenceId: String? = null,
    /** 这次改动是针对哪一次发生编辑的（源事件那一行的 startsAt）。
     *  无作用域的 UPDATE 也要带：窗口拉取合并时，非时间字段可以套到
     *  该事件的每一行上，时间字段只能套到这一行——不然重复事件的
     *  每次发生会被同一个新时间压成同一行。 */
    val baseStartsAt: String? = null,
    /** 改动落下去之前的本地行 DTO JSON 列表（UPDATE / DELETE 用）。
     *  撤销一次还没同步的删除、或裁决「采用服务端版本 / 放弃」时，
     *  靠它把本地行先原样放回去，界面不必等下一次窗口拉取。 */
    val snapshotJson: String? = null,
    /** 列表里给用户看的标题，进队列那一刻的事件标题。 */
    val summary: String = "",
    val createdAtMs: Long,
    /** 已重试次数（退避用）。裁决「保留我的修改」会把它清零。 */
    val attempts: Int = 0,
    /** 下一次允许重试的时刻（epoch ms）。0 = 立刻可重试。 */
    val nextRetryAtMs: Long = 0,
    val state: PendingOpState = PendingOpState.PENDING,
    /** ATTENTION 时服务端给的错误码（如 event_changed），裁决界面用。 */
    val errorCode: String? = null,
    val errorMessage: String? = null,
) {
    /** 同一事件同一作用域的键：合并只在同键之间发生。作用域不同的
     *  两条 UPDATE 打的是不同发生（occurrence），绝不能并成一条。 */
    val mergeKey: String get() = "$eventId|${scope ?: ""}|${recurrenceId ?: ""}"
}

/** 离线新建事件在本地的临时 id。前缀保证它永远不会和服务端 id 撞，
 *  显示合并、队列改写都按这个前缀认。 */
fun localEventId(clientUid: String): String = "local:$clientUid"

fun isLocalEventId(id: String): Boolean = id.startsWith("local:")

/** 入队合并。规则（与 iOS 实现逐条对应，改一处必须同步另一处）：
 *
 *  1. CREATE 之后同事件的无作用域 UPDATE → 字段折进 CREATE 的请求体
 *     （事件还没上服务端，不存在单独 PATCH 它的说法）。带作用域的
 *     UPDATE 不折（它打的是某一次发生），排在 CREATE 后面，CREATE
 *     落定后由引擎把它的 eventId 从临时 id 改写成真实 id。
 *  2. CREATE 之后 DELETE（整事件）→ 两条一起消失：事件从未存在于
 *     服务端，什么都不用发。
 *  3. 同键 UPDATE 之后 UPDATE → 请求体浅合并，后写的非空字段赢。
 *  4. UPDATE 之后整事件 DELETE → UPDATE 全部丢弃，只留 DELETE；
 *     作用域 DELETE 只丢同键 UPDATE。DELETE 之后再来的 UPDATE 直接
 *     丢弃（事件都要删了，改它没有意义）。
 *  5. 同键 DELETE 重复入队 → 只留一条（删一次和删两次没区别）。
 *  6. 其余情况按 seq 追加，保序不变。
 *
 *  合并只动 PENDING 状态的条目：已经停进 ATTENTION 的条目是等用户
 *  裁决的事实，不许被后来的入队悄悄改掉。 */
object PendingOpMerger {

    fun enqueue(queue: List<PendingOp>, op: PendingOp): List<PendingOp> {
        val pending = queue.filter { it.state == PendingOpState.PENDING }
        val attention = queue.filter { it.state == PendingOpState.ATTENTION }
        val merged = enqueueIntoPending(pending, op)
        // ATTENTION 条目永远排在前面展示，但重放顺序只看 seq；这里
        // 保持「原队列相对顺序 + 新条目按合并结果」即可，存储层按
        // seq 排序读取，列表拼装顺序不影响重放。
        return (attention + merged).sortedBy { it.seq }
    }

    private fun enqueueIntoPending(queue: List<PendingOp>, op: PendingOp): List<PendingOp> {
        val out = queue.toMutableList()
        when (op.kind) {
            PendingOpKind.CREATE -> out += op

            PendingOpKind.UPDATE -> {
                // 规则 4 后半：整事件已排了删除 → 这次修改丢弃。
                val seriesDelete = out.any {
                    it.kind == PendingOpKind.DELETE && it.eventId == op.eventId && it.scope == null
                }
                if (seriesDelete) return out
                // 规则 1：折进还没落定的 CREATE（仅无作用域的修改）。
                val createIdx = out.indexOfFirst {
                    it.kind == PendingOpKind.CREATE && it.eventId == op.eventId
                }
                if (createIdx >= 0 && op.scope == null) {
                    val create = out[createIdx]
                    out[createIdx] = create.copy(
                        payloadJson = mergePayloadJson(create.payloadJson, op.payloadJson),
                        summary = op.summary.ifBlank { create.summary },
                    )
                    return out
                }
                // 规则 3：同键 UPDATE 合并。
                val updateIdx = out.indexOfFirst {
                    it.kind == PendingOpKind.UPDATE && it.mergeKey == op.mergeKey
                }
                if (updateIdx >= 0) {
                    val prev = out[updateIdx]
                    out[updateIdx] = prev.copy(
                        payloadJson = mergePayloadJson(prev.payloadJson, op.payloadJson),
                        summary = op.summary.ifBlank { prev.summary },
                    )
                    return out
                }
                out += op
            }

            PendingOpKind.DELETE -> {
                if (op.scope == null) {
                    // 规则 2：事件还没上服务端就删了 → 全部抵消。
                    val hasCreate = out.any {
                        it.kind == PendingOpKind.CREATE && it.eventId == op.eventId
                    }
                    out.removeAll { it.eventId == op.eventId }
                    if (!hasCreate) out += op
                    return out
                }
                // 作用域删除：丢同键 UPDATE，同键 DELETE 只留一条。
                out.removeAll {
                    it.eventId == op.eventId && it.mergeKey == op.mergeKey &&
                        (it.kind == PendingOpKind.UPDATE || it.kind == PendingOpKind.DELETE)
                }
                out += op
            }
        }
        return out
    }

    /** 两个请求体的浅合并：patch 的非空字段覆盖 base；两边都有
     *  extra 对象时，extra 内部再浅合并一层（服务端的 extra 本来就是
     *  浅合并语义，客户端合并必须同口径，否则后一次保存里没动的
     *  extra 字段会被前一条的旧值顶掉或被整段替换丢掉）。 */
    fun mergePayloadJson(base: String?, patch: String?): String? {
        if (base == null) return patch
        if (patch == null) return base
        val baseObj = parseObject(base) ?: return patch
        val patchObj = parseObject(patch) ?: return base
        val merged = baseObj.toMutableMap()
        for ((key, value) in patchObj) {
            val existing = merged[key]
            if (key == "extra" && existing is JsonObject && value is JsonObject) {
                val extraMerged = existing.toMutableMap()
                for ((ek, ev) in value) extraMerged[ek] = ev
                merged[key] = JsonObject(extraMerged)
            } else if (value !is JsonNull) {
                merged[key] = value
            }
        }
        return JsonObject(merged).toString()
    }

    private val json = Json { ignoreUnknownKeys = true }

    private fun parseObject(text: String): JsonObject? =
        runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
}

/** 重试退避：30 秒起，指数翻倍，30 分钟封顶。移动端惯例量级
 *  （WorkManager 的默认退避也是 30 秒起步）。attempts 是已经失败过
 *  的次数，第一次失败后等 30 秒，之后 1 分、2 分、4 分…… */
object PendingOpBackoff {
    const val BASE_MS = 30_000L
    const val MAX_MS = 30L * 60_000L

    fun delayMs(attempts: Int): Long {
        if (attempts <= 0) return BASE_MS
        var delay = BASE_MS
        repeat((attempts - 1).coerceAtMost(10)) {
            delay = (delay * 2).coerceAtMost(MAX_MS)
        }
        return delay
    }
}

/** 一次重放尝试的错误分流结果。 */
enum class PendingOpVerdict {
    /** 成功（DELETE 的 404 也算：目标已经没了）。 */
    DONE,
    /** UPDATE 的 404：事件在服务端已删，条目丢弃、本地行清掉。 */
    GONE,
    /** 5xx / 网络错误：退避后重试。 */
    RETRYABLE,
    /** 其他 4xx：停进待处理，等用户裁决。 */
    ATTENTION,
    /** 401：暂停整个队列，等凭据恢复。 */
    AUTH_BLOCKED,
}

object PendingOpErrors {
    fun classify(kind: PendingOpKind, status: Int?, networkError: Boolean): PendingOpVerdict {
        if (networkError || status == null) return PendingOpVerdict.RETRYABLE
        return when {
            status in 200..299 -> PendingOpVerdict.DONE
            status == 401 -> PendingOpVerdict.AUTH_BLOCKED
            status == 404 && kind == PendingOpKind.DELETE -> PendingOpVerdict.DONE
            status == 404 && kind == PendingOpKind.UPDATE -> PendingOpVerdict.GONE
            status in 500..599 -> PendingOpVerdict.RETRYABLE
            // 其余 4xx（含 409 event_changed、400 校验、403 无权）
            // 都是「服务端明确拒绝了这条改动」，重试不会变，
            // 停下来让用户裁决。
            else -> PendingOpVerdict.ATTENTION
        }
    }
}
