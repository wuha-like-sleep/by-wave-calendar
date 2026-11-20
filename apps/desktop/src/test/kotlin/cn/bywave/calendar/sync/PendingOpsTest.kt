package cn.bywave.calendar.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 离线写队列核心逻辑（shared/PendingOps.kt）的纯逻辑测试：
 * 合并规则、请求体合并、退避、错误分流。本机无 JDK，
 * 这份测试随代码提交、在有工具链的环境跑（Android 端有一份同
 * 内容副本，两端共用同一份 shared 源码，改规则时两份要一起改）。
 */
class PendingOpsTest {

    private fun op(
        kind: PendingOpKind,
        eventId: String,
        seq: Long,
        payload: String? = null,
        scope: String? = null,
        recurrenceId: String? = null,
        state: PendingOpState = PendingOpState.PENDING,
    ) = PendingOp(
        id = "op-$seq",
        seq = seq,
        accountKey = "https://example.test|a@b.c",
        kind = kind,
        eventId = eventId,
        payloadJson = payload,
        scope = scope,
        recurrenceId = recurrenceId,
        summary = "s$seq",
        createdAtMs = seq,
        state = state,
    )

    // ---- 合并规则 ----

    @Test fun createThenUnscopedUpdateFoldsIntoCreate() {
        val create = op(PendingOpKind.CREATE, "local:u1", 1, payload = """{"summary":"A","startsAt":"t1"}""")
        val update = op(PendingOpKind.UPDATE, "local:u1", 2, payload = """{"summary":"B"}""")
        val out = PendingOpMerger.enqueue(listOf(create), update)
        assertEquals(1, out.size)
        assertEquals(PendingOpKind.CREATE, out[0].kind)
        assertTrue(out[0].payloadJson!!.contains("\"summary\":\"B\""))
        assertTrue(out[0].payloadJson!!.contains("\"startsAt\":\"t1\""))
    }

    @Test fun scopedUpdateAfterCreateStaysSeparate() {
        val create = op(PendingOpKind.CREATE, "local:u1", 1, payload = """{"summary":"A"}""")
        val scoped = op(
            PendingOpKind.UPDATE, "local:u1", 2,
            payload = """{"summary":"B"}""", scope = "instance", recurrenceId = "t1",
        )
        val out = PendingOpMerger.enqueue(listOf(create), scoped)
        assertEquals(2, out.size)
    }

    @Test fun createThenSeriesDeleteCancelsBoth() {
        val create = op(PendingOpKind.CREATE, "local:u1", 1)
        val delete = op(PendingOpKind.DELETE, "local:u1", 2)
        val out = PendingOpMerger.enqueue(listOf(create), delete)
        assertTrue(out.isEmpty())
    }

    @Test fun sameKeyUpdatesMergePayloads() {
        val first = op(PendingOpKind.UPDATE, "e1", 1, payload = """{"summary":"A","location":"L1"}""")
        val second = op(PendingOpKind.UPDATE, "e1", 2, payload = """{"location":"L2"}""")
        val out = PendingOpMerger.enqueue(listOf(first), second)
        assertEquals(1, out.size)
        assertTrue(out[0].payloadJson!!.contains("\"summary\":\"A\""))
        assertTrue(out[0].payloadJson!!.contains("\"location\":\"L2\""))
    }

    @Test fun seriesDeleteDropsQueuedUpdates() {
        val update = op(PendingOpKind.UPDATE, "e1", 1)
        val delete = op(PendingOpKind.DELETE, "e1", 2)
        val out = PendingOpMerger.enqueue(listOf(update), delete)
        assertEquals(1, out.size)
        assertEquals(PendingOpKind.DELETE, out[0].kind)
    }

    @Test fun updateAfterSeriesDeleteIsDropped() {
        val delete = op(PendingOpKind.DELETE, "e1", 1)
        val update = op(PendingOpKind.UPDATE, "e1", 2)
        val out = PendingOpMerger.enqueue(listOf(delete), update)
        assertEquals(1, out.size)
        assertEquals(PendingOpKind.DELETE, out[0].kind)
    }

    @Test fun duplicateDeleteKeepsOne() {
        val first = op(PendingOpKind.DELETE, "e1", 1, scope = "instance", recurrenceId = "t1")
        val second = op(PendingOpKind.DELETE, "e1", 2, scope = "instance", recurrenceId = "t1")
        val out = PendingOpMerger.enqueue(listOf(first), second)
        assertEquals(1, out.size)
    }

    @Test fun attentionOpsAreNeverMergedAway() {
        val stuck = op(
            PendingOpKind.UPDATE, "e1", 1,
            payload = """{"summary":"A"}""", state = PendingOpState.ATTENTION,
        )
        val delete = op(PendingOpKind.DELETE, "e1", 2)
        val out = PendingOpMerger.enqueue(listOf(stuck), delete)
        // 待处理条目原样保留；删除照常入队排在它后面。
        assertEquals(2, out.size)
        assertEquals(PendingOpState.ATTENTION, out.first { it.kind == PendingOpKind.UPDATE }.state)
    }

    // ---- 请求体合并 ----

    @Test fun payloadMergeKeepsUntouchedFieldsAndMergesExtraOneLevel() {
        val merged = PendingOpMerger.mergePayloadJson(
            """{"summary":"A","extra":{"color":"red","url":"https://x.test"}}""",
            """{"location":"L","extra":{"color":"blue"}}""",
        )!!
        assertTrue(merged.contains("\"summary\":\"A\""))
        assertTrue(merged.contains("\"location\":\"L\""))
        assertTrue(merged.contains("\"color\":\"blue\""))
        assertTrue(merged.contains("\"url\":\"https://x.test\""))
    }

    @Test fun payloadMergeNullPatchFieldsDoNotErase() {
        val merged = PendingOpMerger.mergePayloadJson(
            """{"summary":"A"}""",
            """{"summary":null,"location":"L"}""",
        )!!
        assertTrue(merged.contains("\"summary\":\"A\""))
        assertTrue(merged.contains("\"location\":\"L\""))
    }

    @Test fun payloadMergeHandlesNullSides() {
        assertEquals("""{"a":1}""", PendingOpMerger.mergePayloadJson(null, """{"a":1}"""))
        assertEquals("""{"a":1}""", PendingOpMerger.mergePayloadJson("""{"a":1}""", null))
        assertNull(PendingOpMerger.mergePayloadJson(null, null))
    }

    // ---- 退避 ----

    @Test fun backoffDoublesFromThirtySecondsAndCapsAtThirtyMinutes() {
        assertEquals(30_000L, PendingOpBackoff.delayMs(1))
        assertEquals(60_000L, PendingOpBackoff.delayMs(2))
        assertEquals(120_000L, PendingOpBackoff.delayMs(3))
        assertEquals(30L * 60_000L, PendingOpBackoff.delayMs(20))
    }

    // ---- 错误分流 ----

    @Test fun classifySplitsByKindAndStatus() {
        assertEquals(PendingOpVerdict.DONE, PendingOpErrors.classify(PendingOpKind.CREATE, 201, false))
        assertEquals(PendingOpVerdict.DONE, PendingOpErrors.classify(PendingOpKind.DELETE, 404, false))
        assertEquals(PendingOpVerdict.GONE, PendingOpErrors.classify(PendingOpKind.UPDATE, 404, false))
        assertEquals(PendingOpVerdict.ATTENTION, PendingOpErrors.classify(PendingOpKind.UPDATE, 409, false))
        assertEquals(PendingOpVerdict.ATTENTION, PendingOpErrors.classify(PendingOpKind.CREATE, 400, false))
        assertEquals(PendingOpVerdict.ATTENTION, PendingOpErrors.classify(PendingOpKind.UPDATE, 403, false))
        assertEquals(PendingOpVerdict.RETRYABLE, PendingOpErrors.classify(PendingOpKind.UPDATE, 503, false))
        assertEquals(PendingOpVerdict.RETRYABLE, PendingOpErrors.classify(PendingOpKind.DELETE, null, true))
        assertEquals(PendingOpVerdict.AUTH_BLOCKED, PendingOpErrors.classify(PendingOpKind.UPDATE, 401, false))
    }

    // ---- 本地临时 id ----

    @Test fun localIdsRoundTrip() {
        val id = localEventId("abc@bywave")
        assertEquals("local:abc@bywave", id)
        assertTrue(isLocalEventId(id))
    }
}
