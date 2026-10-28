package cn.bywave.calendar.data.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 被服务端登出、而本机还登着别的账号时，不许静默切走。
 *
 * 规矩本身（谁接班、说明放哪）在 AccountRulesTest 里按行为测。ProfileStore 绑着加密
 * SharedPreferences，纯 JVM 里建不出来（本模块没有 Robolectric），所以这里和
 * PassiveSignOutWipeTest 一样盯「接线」：规矩写对了但没人调用，用户照样被静默切走。
 */
class SignedOutNoticeWiringTest {

    private fun src(rel: String): String {
        // 单元测试的工作目录是 app/
        val f = listOf(File("src/main/kotlin/$rel"), File("app/src/main/kotlin/$rel")).first { it.exists() }
        // 去掉行注释：注释里写到了不等于代码里做到了。
        return f.readLines().joinToString("\n") { it.replace(Regex("//.*$"), "") }
    }

    /** 从 [openIdx] 处的开括号起，找到和它配对的闭括号的位置。 */
    private fun matching(text: String, openIdx: Int, open: Char, close: Char): Int {
        var depth = 0
        for (i in openIdx until text.length) {
            when (text[i]) {
                open -> depth++
                close -> if (--depth == 0) return i
            }
        }
        throw AssertionError("括号不配对：从第 $openIdx 个字符起")
    }

    /** 函数体：跳过参数表（参数默认值里可能有 `{}`），取到和函数体 `{` 配对的 `}`。 */
    private fun funBody(text: String, signature: String): String {
        require(signature.endsWith("("))
        val start = text.indexOf(signature)
        assertTrue("没找到 `$signature` —— 判据瞎了", start >= 0)
        val paramsClose = matching(text, start + signature.length - 1, '(', ')')
        val bodyOpen = text.indexOf('{', paramsClose)
        return text.substring(bodyOpen, matching(text, bodyOpen, '{', '}') + 1)
    }

    /** 一次调用的整个参数表。 */
    private fun callArgs(text: String, callee: String): String {
        require(callee.endsWith("("))
        val start = text.indexOf(callee)
        assertTrue("没找到 `$callee` —— 判据瞎了", start >= 0)
        val open = start + callee.length - 1
        return text.substring(open, matching(text, open, '(', ')') + 1)
    }

    private val store by lazy { src("cn/bywave/calendar/data/auth/ProfileStore.kt") }
    private val calendarScreen by lazy { src("cn/bywave/calendar/ui/calendar/CalendarScreen.kt") }

    @Test
    fun `被登出时用删之前拿住的账号记下提示`() {
        val b = funBody(store, "fun markSignedOut(")
        val grab = b.indexOf("firstOrNull")
        val tell = b.indexOf("AccountRules.tellAfterPassiveSignOut(")
        val rm = b.indexOf("remove(")
        assertTrue("markSignedOut 没有走 AccountRules.tellAfterPassiveSignOut —— 又成了静默切走", tell >= 0)
        assertTrue("要先拿住账号、记下提示，再删除；删掉之后就查不到它的邮箱了", grab in 0 until tell && tell < rm)
        assertTrue(
            "算出来的提示队列没有写回 _signedOutNotices —— 日历页什么也看不到",
            Regex("""_signedOutNotices\.value\s*=\s*tell\.notices""").containsMatchIn(b),
        )
    }

    @Test
    fun `登录页的原因只在一个账号都不剩时记`() {
        val b = funBody(store, "fun markSignedOut(")
        val writes = Regex("""_signedOutReason\.value\s*=""").findAll(b).toList()
        assertEquals("markSignedOut 里只该有一处写登录页原因", 1, writes.size)
        assertTrue(
            "登录页原因必须由 reasonOnSetupPage 把关：还登着别的账号时记了，它会挂到用户下次点「添加另一个账号」",
            Regex("""if\s*\(\s*tell\.reasonOnSetupPage\s*\)\s*_signedOutReason\.value\s*=""").containsMatchIn(b),
        )
    }

    @Test
    fun `删账号走同一套接班规矩`() {
        val b = funBody(store, "fun remove(")
        assertTrue("remove 没有走 AccountRules.remove —— 接班规矩测的不是线上那份", b.contains("AccountRules.remove("))
    }

    @Test
    fun `重新登录那个账号_提示跟着消失`() {
        val b = funBody(store, "fun upsertAndActivate(")
        assertTrue(b.contains("AccountRules.noticesAfterSignIn("))
    }

    @Test
    fun `提示落盘_切完那一刻进程被杀也不会变成静默切走`() {
        assertTrue("persist 没写提示", funBody(store, "private fun persist(").contains("KEY_SIGNED_OUT_NOTICES"))
        assertTrue("loadFromDisk 没读提示", funBody(store, "private fun loadFromDisk(").contains("KEY_SIGNED_OUT_NOTICES"))
    }

    @Test
    fun `日历页显示提示并能关掉`() {
        val screen = funBody(calendarScreen, "fun CalendarScreen(")
        assertTrue("日历页没有订阅 signedOutNotices", screen.contains("profiles.signedOutNotices.collectAsState()"))
        val banner = callArgs(screen, "SignedOutBanner(")
        assertTrue("提示条要能关掉", banner.contains("dismissSignedOutNotice("))
        assertTrue("提示条要说明现在显示的是哪个账号", banner.contains("currentEmail = active?.email"))
        assertTrue("日历页没有把提示条交给 CalendarBody", Regex("""topNotice\s*=""").containsMatchIn(screen))
        assertTrue(
            "CalendarBody 收了 topNotice 却没画出来",
            funBody(calendarScreen, "private fun CalendarBody(").contains("topNotice()"),
        )
    }
}
