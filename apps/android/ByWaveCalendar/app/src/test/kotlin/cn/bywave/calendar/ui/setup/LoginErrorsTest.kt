package cn.bywave.calendar.ui.setup

import cn.bywave.calendar.R
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 登录页的报错要说人话。App 请求的全是 /api/v1，错误先被服务端包成
 * `{ok:false, error:{code, message}}`，再被 EnvelopeInterceptor 拆成 `{code, message}`；
 * 以前只认 e.localizedMessage，于是输错密码只看到「HTTP 401」。
 */
class LoginErrorsTest {
    @Test
    fun `拆过信封的形状认得出错误码`() {
        val t = loginErrorText(401, """{"code":"invalid_credentials","message":"invalid_credentials"}""", isNetwork = false)
        assertEquals(LoginErrorText.Res(R.string.setupvm_err_invalid_credentials), t)
    }

    @Test
    fun `没拆的信封也认得出`() {
        val t = loginErrorText(429, """{"ok":false,"error":{"code":"account_locked","message":"登录失败次数过多，请稍后再试"}}""", isNetwork = false)
        assertEquals(LoginErrorText.Res(R.string.setupvm_err_account_locked), t)
    }

    @Test
    fun `老接口的扁平形状也认得出`() {
        val t = loginErrorText(403, """{"error":"apps_disabled","message":"管理员已停用"}""", isNetwork = false)
        assertEquals(LoginErrorText.Res(R.string.setupvm_err_apps_disabled), t)
    }

    @Test
    fun `验证码相关的码`() {
        assertEquals(
            LoginErrorText.Res(R.string.setupvm_mfa_code_error),
            loginErrorText(401, """{"code":"invalid_code","message":"验证码错误"}""", isNetwork = false),
        )
        assertEquals(
            LoginErrorText.Res(R.string.setupvm_err_mfa_expired),
            loginErrorText(401, """{"code":"mfa_token_expired","message":"x"}""", isNetwork = false),
        )
    }

    @Test
    fun `不认识的码用服务端的人话，但错误码顶上来的不算人话`() {
        assertEquals(
            LoginErrorText.Server("服务器正在维护"),
            loginErrorText(503, """{"code":"maintenance","message":"服务器正在维护"}""", isNetwork = false),
        )
        assertEquals(
            LoginErrorText.Status(500),
            loginErrorText(500, """{"code":"device_create_failed","message":"device_create_failed"}""", isNetwork = false),
        )
    }

    @Test
    fun `body 读不出来时报状态码，断网时报连不上`() {
        assertEquals(LoginErrorText.Status(502), loginErrorText(502, "<html>Bad Gateway</html>", isNetwork = false))
        assertEquals(LoginErrorText.Res(R.string.setupvm_err_network), loginErrorText(null, null, isNetwork = true))
        assertEquals(LoginErrorText.Unknown, loginErrorText(null, null, isNetwork = false))
    }
}
