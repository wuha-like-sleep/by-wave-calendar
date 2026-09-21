// 出错响应 body → 用户看到的那句话。
//
// 这里守的是一个「不报错、就是不响」的失效：errorFrom() 原先第一句是
// `obj["error"]?.jsonObject`，而服务端大量出错响应是扁平的
// { "error":"码", "message":"人话" }，error 是字符串。.jsonObject 在字符串上
// 抛异常 → runCatching 回 null → 服务端那句已经本地化、写明了下一步怎么办的
// 话被整条丢掉 → 用户永远只看到「出错了，请稍后再试」。
// 没有任何日志、没有任何红色，桌面端和服务端各自都「正常」。
//
// 两条边都要守：
//   · 服务端给了人话 —— 不许吞。
//   · 服务端只给了机器码 —— 不许摆给用户。
// 只写前者，把逻辑改成「无脑显示 error 字段」也能全绿，而那会把
// not_found / bad_request 端到用户脸上。

package cn.bywave.calendar.desktop.data.api

import cn.bywave.calendar.desktop.i18n.I18n
import cn.bywave.calendar.desktop.util.userFacingError
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ApiErrorBodyTest {

    // ---- 服务端真的会发的人话，一句都不许丢 ----

    /** 形状 2（扁平）：src/lib/api_response.ts 的 legacy 分支、routes/devices.ts
     *  的大部分分支、429 限流器、5xx 兜底处理器全是这个形状。
     *  这一条就是这次修的那个 bug：改动前它是红的。 */
    @Test
    fun `扁平信封的 message 是服务端写给用户的那句话`() {
        val cases = mapOf(
            """{"error":"signup_closed","message":"本站暂时不开放注册新账号。"}"""
                to "本站暂时不开放注册新账号。",
            // routes/devices.ts:250 —— 这一句里写明了进后台哪个开关，丢了用户就没法自救
            """{"error":"apps_disabled","message":"管理员已停用 APP 同步。请进入网页后台 → 管理 → API & APPs → 「打开 APP 登录」开关后重试。"}"""
                to "管理员已停用 APP 同步。请进入网页后台 → 管理 → API & APPs → 「打开 APP 登录」开关后重试。",
            // server.ts 全局限流器 errorResponseBuilder
            """{"statusCode":429,"error":"too_many_requests","message":"请求过于频繁，请 37 秒后再试"}"""
                to "请求过于频繁，请 37 秒后再试",
            // routes/devices.ts:365 / :446 / :474
            """{"error":"account_locked","message":"登录失败次数过多，请稍后再试"}"""
                to "登录失败次数过多，请稍后再试",
            """{"error":"invalid_code","message":"验证码错误"}""" to "验证码错误",
            // 服务端按用户语言发，不是只有中文
            """{"error":"signup_quota_reached","message":"This site has already taken all the new accounts it accepts today. Please try again tomorrow, or ask the site administrator."}"""
                to "This site has already taken all the new accounts it accepts today. Please try again tomorrow, or ask the site administrator.",
        )
        for ((body, expected) in cases) {
            assertEquals(
                expected,
                userMessageFromErrorBody(body),
                "扁平信封里服务端那句人话被吞了，用户只会看到通用文案：$body",
            )
        }
    }

    /** 形状 1（v1 嵌套）：src/lib/api_response.ts 的 err() v1 分支。 */
    @Test
    fun `v1 嵌套信封的 message 也要留下`() {
        assertEquals(
            "本站仅限邀请注册",
            userMessageFromErrorBody("""{"ok":false,"error":{"code":"invite_required","message":"本站仅限邀请注册"}}"""),
        )
        assertEquals(
            "今日注册名额已满，请明天再试",
            userMessageFromErrorBody(
                """{"ok":false,"error":{"code":"signup_quota_reached","message":"今日注册名额已满，请明天再试","details":{"resetAt":"2026-09-22"}}}""",
            ),
        )
    }

    /** 形状：没有 error 字段、只有顶层 message。 */
    @Test
    fun `只有顶层 message 也算人话`() {
        assertEquals(
            "服务器内部错误",
            userMessageFromErrorBody("""{"ok":false,"message":"服务器内部错误"}"""),
        )
    }

    // ---- 机器码一律不许摆给用户 ----

    /** 形状 3：404 兜底 { error:"not_found" }，以及各路只发码不发话的分支。 */
    @Test
    fun `只有码没有 message 时不许把码交出去`() {
        for (body in listOf(
            """{"error":"not_found"}""",
            """{"error":"bad_request"}""",
            """{"error":"account_disabled"}""",
            """{"error":"invalid_or_expired_code"}""",
            """{"ok":false,"error":{"code":"validation_failed"}}""",
            // err() 的 v1 分支写的是 `message: message || code`：路由没给人话时
            // message 字段里装的就是那个码，不能当人话。
            """{"ok":false,"error":{"code":"validation_failed","message":"validation_failed"}}""",
        )) {
            assertNull(
                userMessageFromErrorBody(body),
                "机器码被当成人话交出去了，用户会在界面上读到内部标记：$body",
            )
        }
    }

    /** 形状 4/5：不是本 API 发的信封，它的 message 不保证本地化也不保证写给用户看。 */
    @Test
    fun `不是本 API 的信封不许拿它的 message`() {
        for (body in listOf(
            // Fastify 默认错误处理器（server.ts 把非 5xx 原样交还给它）
            """{"statusCode":400,"error":"Bad Request","message":"body must have required property 'title'"}""",
            // 后台页面的写法 { ok:false, error:"整句中文" }，没有 message 字段
            """{"ok":false,"error":"remote 名称不合法（只允许字母/数字/-/_，1-32 字符）"}""",
        )) {
            assertNull(
                userMessageFromErrorBody(body),
                "把不是本 API 的响应当成人话端给用户了：$body",
            )
        }
    }

    // ---- 什么样的 body 都不许抛 ----

    /** 畸形 / 非 JSON / 空 body / 类型不对 —— 一律返回 null，不许抛。
     *  抛出去的后果不是「报错」，是 errorFrom 外层 runCatching 吞掉之后
     *  一切照旧，没人知道。 */
    @Test
    fun `畸形响应体不许抛异常`() {
        for (body in listOf(
            "",
            "   ",
            "not json at all",
            "<html><body>502 Bad Gateway</body></html>",
            "{",
            """{"error":}""",
            "[]",
            "null",
            "42",
            """"just a string"""",
            """{"error":123,"message":"数字码不是本 API 的信封"}""",
            """{"error":true}""",
            """{"error":null,"message":"人话"}""",   // error 为 null：当作没有 error 字段
            """{"error":["not_found"],"message":"数组"}""",
            """{"ok":false,"error":{"code":123,"message":456}}""",
            """{"error":"x_y","message":""}""",
            """{"error":"x_y","message":"   "}""",
            """{"error":"","message":"人话"}""",
        )) {
            // 不抛就算过；返回值另有断言覆盖，这里只守「不抛」。
            userMessageFromErrorBody(body)
        }
        // presence 配对：上面那堆里唯一该出人话的两条，确认它真的出了 ——
        // 否则把函数改成 `return null` 也能让上面全绿。
        assertEquals("人话", userMessageFromErrorBody("""{"error":null,"message":"人话"}"""))
        assertEquals("人话", userMessageFromErrorBody("""{"error":"","message":"人话"}"""))
        assertNull(userMessageFromErrorBody(""))
        assertNull(userMessageFromErrorBody("not json at all"))
    }

    // ---- 端到端：一直走到用户眼前那一句 ----

    /**
     * 解析对了还不够 —— util/UserFacingError.kt 是最后一道，它会把「内部标记」
     * 换成通用文案。这几条走完整条链，断言用户**实际看到的**那一句。
     */
    @Test
    fun `一直走到用户眼前`() {
        val key = "error.loadFailed"
        val generic = I18n.t(key)

        // 有人话 → 用户看到服务端那句
        for ((body, expected) in mapOf(
            """{"error":"signup_closed","message":"本站暂时不开放注册新账号。"}"""
                to "本站暂时不开放注册新账号。",
            """{"ok":false,"error":{"code":"invite_required","message":"本站仅限邀请注册"}}"""
                to "本站仅限邀请注册",
            """{"statusCode":429,"error":"too_many_requests","message":"请求过于频繁，请 37 秒后再试"}"""
                to "请求过于频繁，请 37 秒后再试",
        )) {
            val msg = userMessageFromErrorBody(body) ?: "HTTP 403"
            assertEquals(
                expected,
                userFacingError(ApiException(403, msg), key),
                "服务端已经写清楚了原因，用户却看到通用文案：$body",
            )
        }

        // 只有码 / 畸形 → 用户看到通用文案，且**不是**那个码
        for (body in listOf(
            """{"error":"not_found"}""",
            """{"error":"account_disabled"}""",
            """{"statusCode":400,"error":"Bad Request","message":"body must have required property 'title'"}""",
            "<html>502</html>",
            "",
        )) {
            val msg = userMessageFromErrorBody(body) ?: "HTTP 403"
            assertEquals(
                generic,
                userFacingError(ApiException(403, msg), key),
                "内部标记 / 非本 API 的文本漏到用户界面上了：$body",
            )
        }
    }
}

/**
 * 源码层门禁：ApiClient 里不许再对 `obj["error"]` 直接取 .jsonObject。
 *
 * 为什么要这条：上面那些断言测的是 ApiErrorBody.kt 这个纯函数，而这次的 bug
 * 长在**调用点**上 —— 哪天有人为了「顺手拿个 code」在 errorFrom 里重新写一句
 * `obj["error"]?.jsonObject`，纯函数的测试照样全绿，用户又只剩通用文案。
 * 这是纯语法层就能判死的事。
 */
class ApiClientEnvelopeShapeGateTest {

    private fun apiClientSource(): String {
        val rel = "src/main/kotlin/cn/bywave/calendar/desktop/data/api/ApiClient.kt"
        val f = listOf(File(rel), File("apps/desktop/$rel")).firstOrNull { it.isFile }
            ?: error("找不到 ApiClient.kt，当前工作目录是 ${File(".").absolutePath}")
        return stripComments(f.readText())
    }

    /** 扫的是代码，不是注释 —— ApiClient 里就有几行注释在讲那句坏写法长什么样，
     *  不剥注释的话门禁会当场误报，而误报和漏报一样会让人把门禁关掉。
     *
     *  行注释必须先剥：ApiClient 里有一行 `//` 注释，里面写了 `/api/v1` 后面
     *  紧跟一个星号。先剥块注释的话，那个 `/` 加 `*` 会被当成块注释的开头，
     *  一路吃到下一个 KDoc 的结尾，把中间的真代码一起吃掉 —— 门禁就成了
     *  对着空字符串跑的空门禁，永远绿。
     *
     *  （同理，这段注释里也不能把 `/` 和 `*` 写在一起：Kotlin 的块注释是
     *  可嵌套的，写了就会当场把下面几行代码吃掉。第一版就是这么挂的。） */
    private fun stripComments(src: String): String = src
        .replace(Regex("""(?m)//.*$"""), " ")
        .replace(Regex("""/\*[\s\S]*?\*/"""), " ")

    // ["error"] 后面直接跟 .jsonObject / !!.jsonObject —— 在扁平信封上会抛。
    private val badShape = Regex("""\["error"](\?|!!)?\.jsonObject""")

    /** 断言自检：先证明这条正则真的抓得住那句坏写法、剥注释真的在剥，
     *  再拿它去扫真文件。（否则门禁会「绿着而洞开着」。） */
    @Test
    fun `门禁自检 —— 正则抓得住坏写法且剥得掉注释`() {
        for (bad in listOf(
            """val err = obj["error"]?.jsonObject""",
            """val err = obj["error"].jsonObject""",
            """val err = obj["error"]!!.jsonObject""",
        )) {
            assertTrue(badShape.containsMatchIn(bad), "门禁正则抓不住这句坏写法，等于没有门禁：$bad")
            // 剥注释不许把真代码一起剥掉
            assertTrue(badShape.containsMatchIn(stripComments(bad)), "剥注释把真代码剥没了：$bad")
        }
        assertTrue(
            !badShape.containsMatchIn("""val message = userMessageFromErrorBody(raw)"""),
            "门禁正则误伤了正确写法",
        )
        // 注释里提到坏写法不算数
        for (comment in listOf(
            """    // 这里原先是 obj["error"]?.jsonObject，在扁平信封上会抛""",
            """    /** 原先是 obj["error"]?.jsonObject */""",
        )) {
            assertTrue(!badShape.containsMatchIn(stripComments(comment)), "注释被当成代码判死了：$comment")
        }
        // 剥完之后真代码还得在。剥过头（比如块注释吃掉半个文件）会让下面两条
        // 门禁变成对着空字符串跑，永远绿。
        val stripped = apiClientSource()
        for (marker in listOf(
            "private suspend fun errorFrom(",
            "private suspend fun <T> unwrap(",
            "throw ApiException(resp.status.value, message)",
        )) {
            assertTrue(stripped.contains(marker), "剥注释把真代码剥没了，门禁在对空字符串跑：找不到 `$marker`")
        }
    }

    @Test
    fun `ApiClient 不许对 error 字段直接取 jsonObject`() {
        val hits = badShape.findAll(apiClientSource()).map { it.value }.toList()
        assertTrue(
            hits.isEmpty(),
            "服务端的扁平信封 {\"error\":\"码\",\"message\":\"人话\"} 里 error 是字符串，" +
                ".jsonObject 会抛 —— 结果是服务端那句人话被整条丢掉，用户只看到通用文案。" +
                "改成 userMessageFromErrorBody(raw)：\n" + hits.joinToString("\n"),
        )
    }

    /** presence 配对：光有上面那条 absence，把 errorFrom / unwrap 整个删空也全绿。 */
    @Test
    fun `errorFrom 和 unwrap 都必须走同一个解析器`() {
        val n = Regex("""userMessageFromErrorBody\(""").findAll(apiClientSource()).count()
        assertTrue(
            n >= 2,
            "ApiClient 里只找到 $n 处 userMessageFromErrorBody(，应当至少 2 处" +
                "（unwrap 的 ok=false 分支 + errorFrom）。有分支在自己解析 body。",
        )
    }
}
