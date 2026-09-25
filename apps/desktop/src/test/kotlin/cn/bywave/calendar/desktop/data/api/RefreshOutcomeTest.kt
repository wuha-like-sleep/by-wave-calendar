package cn.bywave.calendar.desktop.data.api

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 刷新登录令牌失败时，什么才算「服务端不认这张票了」。
 *
 * 判成「不认」的后果是把账号从这台机器上清掉，用户要重新扫码配对。
 * 以前这里只有 true/false：任何失败都当吊销，于是断网或者服务器抖一下，
 * 打开桌面端就发现账号没了 —— 而他的账号什么事都没有。
 */
class RefreshOutcomeTest {

    @Test
    fun `401 才算被吊销`() {
        assertEquals(RefreshOutcome.REVOKED, refreshOutcomeForStatus(401))
    }

    @Test
    fun `服务端出错不算被吊销`() {
        for (code in listOf(500, 502, 503, 504)) {
            assertEquals(
                RefreshOutcome.UNREACHABLE, refreshOutcomeForStatus(code),
                "HTTP $code 被当成了「账号被吊销」—— 服务器抖一下就把用户的账号删了",
            )
        }
    }

    @Test
    fun `其它 4xx 也不算`() {
        // 403 在这个仓库里的意思是「这次没验过」，不是「会话没了」。
        for (code in listOf(400, 403, 404, 429)) {
            assertEquals(
                RefreshOutcome.UNREACHABLE, refreshOutcomeForStatus(code),
                "HTTP $code 被当成了「账号被吊销」",
            )
        }
    }

    @Test
    fun `2xx 是成功`() {
        // 少了这条，「全都返回 UNREACHABLE」的实现也会让上面几条绿。
        for (code in listOf(200, 201, 204)) {
            assertEquals(RefreshOutcome.OK, refreshOutcomeForStatus(code))
        }
    }
}
