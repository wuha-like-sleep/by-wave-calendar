package cn.bywave.calendar.data.api

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * 刷新令牌失败时，什么才算「服务端不认这张票了」。
 *
 * ── 为什么要钉住这一条 ──────────────────────────────────────────────
 *
 * 判成「不认」的后果是**把整个账号从这台设备上删掉**，用户要重新扫码配对。
 * 以前这里不分：`runCatching { ... }.getOrNull()` 拿到 null 就当吊销，
 * 于是地铁里、飞机上、或者服务器抖一下，打开 App 就发现账号没了 ——
 * 而他的账号什么事都没有，服务端从头到尾没说过一句话。
 *
 * 只有 HTTP 401 是服务端**明确**说这张票作废（改密码 / 重置密码 /
 * 后台移除设备）。其余一律只说明「这次没问到」。
 */
class RefreshRevocationTest {

    private fun httpError(code: Int) =
        HttpException(Response.error<Any>(code, "".toResponseBody("application/json".toMediaType())))

    @Test
    fun `401 才算被吊销`() {
        assertTrue("服务端明确回 401，这就是吊销", isRefreshRevocation(httpError(401)))
    }

    @Test
    fun `断网不算被吊销`() {
        // 这一条是核心：判错了就在断网时把用户的账号删掉。
        assertFalse("连不上服务器被当成了「账号被吊销」，用户的账号会被删掉",
            isRefreshRevocation(UnknownHostException("no dns")))
        assertFalse("超时被当成了「账号被吊销」",
            isRefreshRevocation(SocketTimeoutException("timeout")))
        assertFalse("IO 错误被当成了「账号被吊销」",
            isRefreshRevocation(IOException("connection reset")))
    }

    @Test
    fun `服务端出错不算被吊销`() {
        for (code in intArrayOf(500, 502, 503, 504)) {
            assertFalse("HTTP $code 被当成了「账号被吊销」——服务器抖一下就把用户踢了",
                isRefreshRevocation(httpError(code)))
        }
    }

    @Test
    fun `其它 4xx 也不算`() {
        // 403 在这个仓库里的意思是「这次没验过」，不是「会话没了」。
        for (code in intArrayOf(400, 403, 404, 429)) {
            assertFalse("HTTP $code 被当成了「账号被吊销」", isRefreshRevocation(httpError(code)))
        }
    }

    @Test
    fun `没有异常时不算`() {
        assertFalse(isRefreshRevocation(null))
    }
}
