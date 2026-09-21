package cn.bywave.calendar.desktop.data.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * 守「哪些状态码的服务端文案能给用户看」。
 *
 * 这条是修 errorFrom 时**自己打开的**一条路：以前解析有 bug，服务端 5xx 里的
 * err.message 被一起吞了；bug 修好之后它就能上屏了。而自建服务端在
 * NODE_ENV 没设成 production 时（默认值恰恰不是 production）回的正是
 * PG 报错原文 —— 内网 IP、数据库端口、服务器绝对路径。
 *
 * 429 是另一种：服务端那句是硬编码中文，转发过去德语用户会看到中文。
 */
class ApiErrorBodyStatusTest {

    private val leaky = """{"error":"internal_error","message":"connect ECONNREFUSED 10.0.3.14:5432"}"""
    private val leakyPath = """{"error":"internal_error","message":"ENOENT: no such file or directory, open '/home/bywave/app/src/lib/x.ts'"}"""
    private val rateLimited = """{"error":"rate_limited","message":"请求过于频繁，请 42 秒后再试"}"""
    private val realAdvice = """{"error":"signup_closed","message":"本站暂时不开放注册新账号。"}"""

    @Test
    fun `5xx 的文案一律不给用户看`() {
        assertNull(userMessageFromErrorBody(leaky, 500), "内网地址和端口上屏了")
        assertNull(userMessageFromErrorBody(leakyPath, 500), "服务器绝对路径上屏了")
        assertNull(userMessageFromErrorBody(leaky, 502))
        assertNull(userMessageFromErrorBody(leaky, 503))
    }

    @Test
    fun `429 不转发服务端那句中文`() {
        assertNull(
            userMessageFromErrorBody(rateLimited, 429),
            "服务端那句限流提示是硬编码中文，转发过去非中文用户会突然看到中文",
        )
    }

    @Test
    fun `4xx 里真正写给用户的说明照常显示`() {
        // presence 侧：少了这条，把判据写成「一律返回 null」也能让上面两条全绿，
        // 而那样服务端所有能照着做的说明又全被吞掉了 —— 正是这次要修的原 bug。
        assertEquals(
            "本站暂时不开放注册新账号。",
            userMessageFromErrorBody(realAdvice, 403),
            "服务端给的、已经本地化的说明被吞掉了",
        )
        assertEquals("本站暂时不开放注册新账号。", userMessageFromErrorBody(realAdvice, 409))
    }

    @Test
    fun `不带状态码的重载仍然按原样工作`() {
        // 它留给还拿不到状态码的调用点，行为不变。
        assertEquals("本站暂时不开放注册新账号。", userMessageFromErrorBody(realAdvice))
    }
}
