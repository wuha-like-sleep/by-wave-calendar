package cn.bywave.calendar.ui.setup

import cn.bywave.calendar.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 登录页的报错要说人话。App 请求的全是 /api/v1，错误先被服务端包成
 * `{ok:false, error:{code, message}}`，再被 EnvelopeInterceptor 拆成 `{code, message}`；
 * 以前只认 e.localizedMessage，于是输错密码只看到「HTTP 401」。
 *
 * 但服务端的话也不能什么都往屏幕上端：5xx 的话是给开发者看的（可能带数据库地址），
 * 429 的话是服务端的语言（老版本写死中文），不是本 API 写法的错误码说明那个 body
 * 不是本 API 发的。规矩和桌面端 ApiErrorBody.kt 一致。
 */
class LoginErrorsTest {
    /** 账号密码登录那一步。 */
    private fun pw(status: Int?, body: String?) = loginErrorText(status, body, isNetwork = false, step = LoginStep.Password)

    /** 一张表每一行都跑完再报：红的时候一眼看出是哪几行，而不是只看到第一行。 */
    private fun table(vararg rows: Triple<String, LoginErrorText, LoginErrorText>) {
        val bad = rows.filter { (_, expected, actual) -> expected != actual }
            .map { (name, expected, actual) -> "$name：期望 $expected，实际 $actual" }
        assertTrue(bad.joinToString("\n"), bad.isEmpty())
    }

    @Test
    fun `拆过信封的形状认得出错误码`() {
        val t = pw(401, """{"code":"invalid_credentials","message":"invalid_credentials"}""")
        assertEquals(LoginErrorText.Res(R.string.setupvm_err_invalid_credentials), t)
    }

    @Test
    fun `没拆的信封也认得出`() {
        val t = pw(429, """{"ok":false,"error":{"code":"account_locked","message":"登录失败次数过多，请稍后再试"}}""")
        assertEquals(LoginErrorText.Res(R.string.setupvm_err_account_locked), t)
    }

    @Test
    fun `老接口的扁平形状也认得出`() {
        val t = pw(403, """{"error":"apps_disabled","message":"管理员已停用"}""")
        assertEquals(LoginErrorText.Res(R.string.setupvm_err_apps_disabled), t)
    }

    @Test
    fun `验证码相关的码`() {
        assertEquals(
            LoginErrorText.Res(R.string.setupvm_mfa_code_error),
            loginErrorText(401, """{"code":"invalid_code","message":"验证码错误"}""", isNetwork = false, step = LoginStep.Mfa),
        )
        assertEquals(
            LoginErrorText.Res(R.string.setupvm_err_mfa_expired),
            loginErrorText(401, """{"code":"mfa_token_expired","message":"x"}""", isNetwork = false, step = LoginStep.Mfa),
        )
    }

    @Test
    fun `不认识的码用服务端的人话，但错误码顶上来的不算人话`() {
        table(
            Triple(
                "人话（去掉首尾空白）",
                LoginErrorText.Server("站长已关闭注册"),
                pw(403, """{"code":"signup_closed","message":"  站长已关闭注册 "}"""),
            ),
            Triple("码顶上来的", LoginErrorText.Status(404), pw(404, """{"code":"not_found","message":"not_found"}""")),
        )
    }

    @Test
    fun `5xx 一律用本地文案，服务端的话不上屏`() {
        val server = LoginErrorText.Res(R.string.setupvm_err_server)
        table(
            // 以前这条是原样透传「服务器正在维护」：5xx 的话按定义不是写给用户的。
            Triple("503 维护", server, pw(503, """{"code":"maintenance","message":"服务器正在维护"}""")),
            // 自建服务端没开 production 时会把异常原文回过来。
            Triple(
                "500 异常原文",
                server,
                pw(500, """{"error":"internal_error","message":"connect ECONNREFUSED 10.0.3.14:5432"}"""),
            ),
            Triple("500 只有码", server, pw(500, """{"code":"device_create_failed","message":"device_create_failed"}""")),
            Triple("502 反代页", server, pw(502, "<html>Bad Gateway</html>")),
        )
    }

    @Test
    fun `429 用本地文案，不转发服务端那句`() {
        val limited = LoginErrorText.Res(R.string.setupvm_err_rate_limited)
        table(
            // 限流器的真实形状（src/server.ts 的 errorResponseBuilder）；老版本服务端这句写死中文。
            Triple(
                "限流器",
                limited,
                pw(429, """{"statusCode":429,"error":"too_many_requests","message":"请求过于频繁，请 42 秒后再试"}"""),
            ),
            Triple("空 body", limited, pw(429, null)),
        )
    }

    @Test
    fun `错误码不是本 API 的写法时，整个 body 不算数`() {
        table(
            // Fastify 默认处理器：error 是 "Bad Request"，message 是开发向英文。
            Triple(
                "Fastify 默认",
                LoginErrorText.Status(400),
                pw(400, """{"statusCode":400,"error":"Bad Request","message":"body/email must match format \"email\""}"""),
            ),
            Triple(
                "反代",
                LoginErrorText.Status(403),
                pw(403, """{"code":"Forbidden","message":"Access denied by upstream proxy"}"""),
            ),
            Triple(
                "嵌套信封里的怪码",
                LoginErrorText.Status(409),
                pw(409, """{"error":{"code":"Email-Taken","message":"duplicate key value violates unique constraint"}}"""),
            ),
            // 大小写不对也不是本 API 的码，它带的话同样不上屏。
            Triple(
                "大写的码",
                LoginErrorText.Status(401),
                pw(401, """{"code":"Invalid_Credentials","message":"bcrypt compare failed for user 42"}"""),
            ),
        )
    }

    @Test
    fun `bad_request 只在账号密码登录里说是格式不对`() {
        val body = """{"error":"bad_request"}"""
        table(
            Triple("账号密码", LoginErrorText.Res(R.string.setupvm_err_bad_format), pw(400, body)),
            // 扫码、验证码两步的 bad_request 跟邮箱密码无关，交给各自的兜底文案。
            Triple("扫码", LoginErrorText.Unknown, loginErrorText(400, body, isNetwork = false, step = LoginStep.Pair)),
            Triple("验证码", LoginErrorText.Unknown, loginErrorText(400, body, isNetwork = false, step = LoginStep.Mfa)),
        )
    }

    @Test
    fun `body 读不出来时报状态码，断网时报连不上`() {
        table(
            Triple("非 JSON", LoginErrorText.Status(404), pw(404, "<html>Not Found</html>")),
            Triple(
                "断网",
                LoginErrorText.Res(R.string.setupvm_err_network),
                loginErrorText(null, null, isNetwork = true, step = LoginStep.Pair),
            ),
            Triple("不是 HTTP 错误", LoginErrorText.Unknown, pw(null, null)),
        )
    }
}
