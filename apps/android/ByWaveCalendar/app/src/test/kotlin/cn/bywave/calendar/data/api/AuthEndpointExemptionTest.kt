package cn.bywave.calendar.data.api

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 哪些请求不带登录令牌，哪些请求收到 401 之后不去刷新。
 *
 * ── 这是两件事，以前合成了一个开关 ──────────────────────────────────
 *
 * · 不带令牌：还没有令牌的引导接口（登录、刷新、扫码配对）。
 * · 收到 401 不刷新：上面那些，**再加上改密码** —— 它的 401 意思是
 *   「你输的当前密码不对」，不是「会话没了」。
 *
 * 合成一个开关之后，改密码那条请求连令牌都不带了：服务端当然回 401，
 * 而这条路又被豁免了刷新，于是**安卓上永远改不了密码**，
 * 输对输错都提示「当前密码错误」。
 */
class AuthEndpointExemptionTest {

    @Test
    fun `改密码必须带令牌`() {
        assertFalse(
            "改密码请求不带登录令牌 —— 服务端会回 401，用户在安卓上永远改不了密码",
            isBootstrapPath("/api/v1/account/password"),
        )
    }

    @Test
    fun `改密码的 401 不触发刷新`() {
        assertTrue(
            "输错一次当前密码会先刷新再重发，一次错误吃两次限流配额，试三次就被告知太频繁",
            skipRefreshOn401Path("/api/v1/account/password"),
        )
    }

    @Test
    fun `引导接口不带令牌`() {
        for (p in listOf(
            "/api/v1/auth/login-password",
            "/api/v1/auth/login-mfa-verify",
            "/api/v1/auth/refresh",
            "/api/v1/devices/pair-claim",
        )) {
            assertTrue("$p 是引导接口，那会儿还没有令牌", isBootstrapPath(p))
            assertTrue("$p 的 401 是真的凭据不对，不该去刷新", skipRefreshOn401Path(p))
        }
    }

    @Test
    fun `普通接口两样都要`() {
        // 少了这条，「全都返回 true」的实现也会让上面几条绿。
        for (p in listOf("/api/v1/events", "/api/v1/calendars", "/api/v1/devices/me/push-token")) {
            assertFalse("$p 不带令牌的话根本调不通", isBootstrapPath(p))
            assertFalse("$p 收到 401 应该去刷新令牌再重试一次", skipRefreshOn401Path(p))
        }
    }
}
