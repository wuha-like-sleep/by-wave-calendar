package cn.bywave.calendar.data.auth

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 被服务端踢掉的账号，本机的东西也要清干净。
 *
 * 用户自己点「退出登录」时，CalendarViewModel 会做完整清理：取消排好的提醒、
 * 删掉系统「日历」App 里的镜像、清本地缓存。而被服务端吊销（改密码 / 重置密码 /
 * 后台移除设备）走的是 ProfileStore.markSignedOut，以前只把账号从列表里摘掉 ——
 * 提醒照样按时响（通知里带着日程标题），系统日历里的日程永久留着，而 App 里已经
 * 查无此账号，用户关不掉也删不掉。
 *
 * ProfileStore 用的是加密 SharedPreferences，纯 JVM 测试里建不出来（本模块没有
 * Robolectric），所以这里和 BootReceiverManifestTest 一样，盯住「接线」本身：
 * 踢掉时要调钩子，钩子要接到完整清理上。
 */
class PassiveSignOutWipeTest {

    private fun src(rel: String): String {
        // 单元测试的工作目录是 app/
        val f = listOf(File("src/main/kotlin/$rel"), File("app/src/main/kotlin/$rel")).first { it.exists() }
        return f.readText()
    }

    /** 取出某个函数的函数体（到下一个同缩进的 fun / 属性为止）。 */
    private fun body(text: String, signature: String): String {
        val start = text.indexOf(signature)
        assertTrue("没找到 `$signature` —— 判据瞎了", start >= 0)
        val rest = text.substring(start + signature.length)
        val end = Regex("\\n {4}(fun |@Volatile|val |var |private )").find(rest)?.range?.first ?: rest.length
        return rest.substring(0, end)
    }

    @Test
    fun `被踢掉时调用清理钩子`() {
        val b = body(src("cn/bywave/calendar/data/auth/ProfileStore.kt"), "fun markSignedOut(")
        assertTrue(
            "markSignedOut 没有调用 onPassiveRemoval —— 被服务端踢掉的账号，" +
                "提醒会继续响、系统日历里的日程永久留着，用户删不掉",
            b.contains("onPassiveRemoval?.invoke("),
        )
        // 必须在 remove 之前拿住账号：删掉之后就找不到它了。
        val grab = b.indexOf("firstOrNull")
        val rm = b.indexOf("remove(")
        assertTrue("要先拿住这个账号再删除，否则清理时已经查不到它", grab in 0 until rm)
    }

    @Test
    fun `钩子接到了完整清理上`() {
        val app = src("cn/bywave/calendar/BywaveApp.kt")
        val i = app.indexOf("onPassiveRemoval =")
        assertTrue("BywaveApp 没有接上 onPassiveRemoval —— 钩子形同虚设", i >= 0)
        val wiring = app.substring(i, minOf(app.length, i + 300))
        assertTrue(
            "钩子没有接到 wipeProfileFully 上 —— 只清本地缓存不够，提醒和系统日历镜像都要清",
            wiring.contains("wipeProfileFully("),
        )
    }
}
