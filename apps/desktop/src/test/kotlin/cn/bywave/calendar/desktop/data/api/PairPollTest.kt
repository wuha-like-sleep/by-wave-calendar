package cn.bywave.calendar.desktop.data.api

import cn.bywave.calendar.desktop.testutil.FakeServer
import cn.bywave.calendar.desktop.testutil.FakeServer.Reply
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 扫码登录轮询碰到预期外的状态码时怎么办。
 *
 * 以前：任何没想到的状态码都变成 `"HTTP 502"` 这种字符串，原样拼进「网络异常，
 * 正在重试… (HTTP 502)」摆给用户，而且每 2 秒一次、永不停止 —— 网关挂着就永远转圈。
 *
 * 现在：网关类错误（5xx、限流、超时）有限次退避重试；服务端明确拒绝（400 之类）
 * 直接停下说人话；拒绝 / 过期这些终态照旧停。
 */
class PairPollTest {

    @Test
    fun `网关类错误要重试`() {
        for (code in listOf(500, 502, 503, 504, 429, 408)) {
            assertEquals(PairPollKind.RETRY, pairPollKindForStatus(code), "HTTP $code 只说明这次没问成，应该退避再问")
        }
    }

    @Test
    fun `服务端约定的几个状态照旧`() {
        assertEquals(PairPollKind.APPROVED, pairPollKindForStatus(200))
        assertEquals(PairPollKind.PENDING, pairPollKindForStatus(202))
        assertEquals(PairPollKind.DENIED, pairPollKindForStatus(410))
        assertEquals(PairPollKind.EXPIRED, pairPollKindForStatus(404))
    }

    @Test
    fun `服务端明确拒绝的不重试`() {
        for (code in listOf(400, 401, 403, 405)) {
            assertEquals(PairPollKind.FAIL, pairPollKindForStatus(code), "HTTP $code 再问一百次也一样，不该一直转圈")
        }
    }

    @Test
    fun `重试有上限，而且越等越久`() {
        var prev = 0L
        var total = 0L
        for (n in 1..PAIR_POLL_MAX_FAILURES) {
            val d = assertNotNull(pairPollRetryDelayMs(n), "第 $n 次还没到上限，应该继续等")
            assertTrue(d >= prev, "退避不能越等越短：第 $n 次 $d < $prev")
            assertTrue(d <= 30_000L, "单次等待不该超过 30 秒：$d")
            prev = d
            total += d
        }
        assertNull(pairPollRetryDelayMs(PAIR_POLL_MAX_FAILURES + 1), "超过上限必须停，不许无限重试")
        assertTrue(total < 5 * 60_000L, "二维码只有 5 分钟有效期，等到它过期才放弃就没意义了：合计 ${total}ms")
    }

    @Test
    fun `502 不再把内部标记摆给用户`(): Unit = runBlocking {
        FakeServer().use { s ->
            s.handler = { Reply(502, "<html>Bad Gateway</html>") }
            val c = ApiClient(s.url)
            try {
                assertIs<ApiClient.PairStatus.Unreachable>(c.desktopPairStatus("ABCD"))
            } finally {
                c.close()
            }
        }
    }

    @Test
    fun `被拒绝时给的是人话，不是 HTTP 400 或者机器码`(): Unit = runBlocking {
        FakeServer().use { s ->
            s.handler = { Reply(400, """{"error":"missing_code"}""") }
            val c = ApiClient(s.url)
            try {
                val st = assertIs<ApiClient.PairStatus.Failed>(c.desktopPairStatus("ABCD"))
                assertTrue(!st.message.contains("HTTP"), "不许把状态码标记给用户看：${st.message}")
                assertTrue(st.message != "missing_code", "不许把机器码给用户看：${st.message}")
                assertTrue(st.message.isNotBlank())
            } finally {
                c.close()
            }
        }
    }

    @Test
    fun `服务端给了人话就用服务端的`(): Unit = runBlocking {
        FakeServer().use { s ->
            s.handler = { Reply(403, """{"error":"apps_disabled","message":"管理员已停用 APP 同步。"}""") }
            val c = ApiClient(s.url)
            try {
                val st = assertIs<ApiClient.PairStatus.Failed>(c.desktopPairStatus("ABCD"))
                assertEquals("管理员已停用 APP 同步。", st.message)
            } finally {
                c.close()
            }
        }
    }

    @Test
    fun `连不上服务器算这次没问成`(): Unit = runBlocking {
        // 起一台再马上关掉，拿到一个肯定没人监听的端口。
        val deadUrl = FakeServer().use { it.url }
        val c = ApiClient(deadUrl)
        try {
            assertIs<ApiClient.PairStatus.Unreachable>(c.desktopPairStatus("ABCD"))
        } finally {
            c.close()
        }
    }
}
