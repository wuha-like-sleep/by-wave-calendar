package cn.bywave.calendar

import cn.bywave.calendar.data.auth.SignInPrefill
import cn.bywave.calendar.data.auth.SignInPrefillSlot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 登录成功之后按返回键，要退出 App，而不是退到一个一模一样的日历页。
 *
 * 出事的形状：起始页写成 `if (loggedIn) "calendar" else "setup"`。首次登录成功那一刻，
 * 起始页一变整张导航图重建，栈变成 [calendar]；同一帧里登录页的 onSignedIn 又 navigate
 * 了一次 calendar（它要 popUpTo 的 setup 已经不在栈里，被静默忽略）—— 栈里压着两个日历页。
 *
 * 修法是登录成功只留一条跳转路径。起始页定死之后，「一个账号都不剩回登录页」不会再顺带
 * 发生，要显式做 —— 那条规矩（[AuthRouting.mustResetToSetup]）在这里按行为测；
 * MainActivity 的接线要真机才跑得起来，照 BootReceiverManifestTest 的做法盯源码。
 */
class AuthRoutingTest {

    // ---- 规矩本身 ----

    @Test
    fun `进App时有账号从日历页起步_没有从登录页起步`() {
        assertEquals(AuthRouting.CALENDAR, AuthRouting.startRoute(signedIn = true))
        assertEquals(AuthRouting.SETUP, AuthRouting.startRoute(signedIn = false))
    }

    @Test
    fun `账号全没了而栈里还压着要账号的页面_清栈回登录页`() {
        assertTrue(AuthRouting.mustResetToSetup(signedIn = false, stack = listOf("calendar")))
        assertTrue(AuthRouting.mustResetToSetup(signedIn = false, stack = listOf("calendar", "settings")))
        assertTrue(AuthRouting.mustResetToSetup(signedIn = false, stack = listOf("calendar", "event_edit/{id}")))
        // 正在「添加另一个账号」时最后一个账号被登出：登录页底下那个日历页已经没有账号了，
        // 不清的话，用户在登录页按返回会回到一个空壳日历页。
        assertTrue(AuthRouting.mustResetToSetup(signedIn = false, stack = listOf("calendar", "setup")))
    }

    @Test
    fun `已经只剩登录页_不动_免得冲掉正在填的表单`() {
        assertFalse(AuthRouting.mustResetToSetup(signedIn = false, stack = listOf("setup")))
        assertFalse(AuthRouting.mustResetToSetup(signedIn = false, stack = listOf("setup", "scanner")))
        assertFalse(AuthRouting.mustResetToSetup(signedIn = false, stack = emptyList()))
    }

    @Test
    fun `还登着就从不清栈`() {
        assertFalse(AuthRouting.mustResetToSetup(signedIn = true, stack = listOf("calendar", "settings")))
        assertFalse(AuthRouting.mustResetToSetup(signedIn = true, stack = listOf("calendar", "setup")))
    }

    @Test
    fun `重新登录_从日历页点才去登录页_登录页已经在栈顶就不去`() {
        assertTrue("日历页上点「重新登录」要去登录页", AuthRouting.signInAgainOpensSetup(AuthRouting.CALENDAR))
        assertFalse("连点的第二下：第一下已经进了登录页", AuthRouting.signInAgainOpensSetup(AuthRouting.SETUP))
        assertFalse("登录页上面压着扫码页，也是已经在登录流程里了", AuthRouting.signInAgainOpensSetup(AuthRouting.SCANNER))
    }

    @Test
    fun `连点两下重新登录_格子里不留没人取的预填`() {
        // 照 MainActivity 里 onSignInAgain 的样子走一遍（接线在 SignInWiringTest 里盯）：
        // 过闸 → 放预填 → 进登录页（launchSingleTop）；登录页一建出来就取走。
        val slot = SignInPrefillSlot()
        val stack = mutableListOf(AuthRouting.CALENDAR)
        val bob = SignInPrefill(serverUrl = "https://cal.example.com", email = "bob@example.com")
        fun tapSignInAgain() {
            if (AuthRouting.signInAgainOpensSetup(stack.last())) {
                slot.put(bob)
                if (stack.last() != AuthRouting.SETUP) stack += AuthRouting.SETUP
            }
        }

        tapSignInAgain()
        assertEquals("登录页建出来时该取到预填", bob, slot.take())
        // 第二下落在日历页的退场动画上 —— 导航是同步的，栈顶已经是登录页。
        tapSignInAgain()
        assertNull("第二下放的预填没人取：以后清栈回登录页时会把 bob 填在空白登录页上", slot.take())
    }

    // ---- MainActivity 的接线 ----

    private val main: String by lazy {
        val rel = "cn/bywave/calendar/MainActivity.kt"
        // 单元测试的工作目录是 app/
        val f = listOf(File("src/main/kotlin/$rel"), File("app/src/main/kotlin/$rel")).first { it.exists() }
        // 去掉行注释：注释里写到了不等于代码里做到了。
        f.readLines().joinToString("\n") { it.replace(Regex("//.*$"), "") }
    }

    /** 从 [marker] 之后第一个 `{` 起，取到和它配对的 `}`。 */
    private fun block(marker: String): String {
        val start = main.indexOf(marker)
        assertTrue("没找到 `$marker` —— 判据瞎了", start >= 0)
        val open = main.indexOf('{', start)
        var depth = 0
        for (i in open until main.length) {
            when (main[i]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return main.substring(open, i + 1)
            }
        }
        throw AssertionError("`$marker` 的花括号不配对")
    }

    @Test
    fun `起始页只定一次_不跟着登录态变`() {
        val m = Regex("""startDestination\s*=\s*([^,\n]+)""").find(main)
        assertTrue("NavHost 的 startDestination 没找到 —— 判据瞎了", m != null)
        val expr = m!!.groupValues[1].trim()
        assertFalse(
            "startDestination = $expr 直接跟着登录态变：一登录整张图重建，再叠上 onSignedIn 的跳转，栈里压两个日历页",
            expr.contains("loggedIn") || expr.contains("activeId") || expr.contains("if"),
        )
        assertTrue(
            "startDestination 引用的 `$expr` 必须是进 App 时 remember 一次（不带 key）定下来的",
            Regex("""val\s+${Regex.escape(expr)}\s*=\s*remember\s*\{""").containsMatchIn(main),
        )
    }

    @Test
    fun `登录成功只有一条跳转_弹掉登录页并复用日历页`() {
        val b = block("onSignedIn = ")
        assertEquals("onSignedIn 里只该有一次 navigate", 1, Regex("""\.navigate\(""").findAll(b).count())
        assertTrue("要跳到日历页", b.contains("navigate(AuthRouting.CALENDAR)"))
        assertTrue(
            "要把登录页连同它上面的页面一起弹掉",
            Regex("""popUpTo\(AuthRouting\.SETUP\)\s*\{\s*inclusive\s*=\s*true\s*}""").containsMatchIn(b),
        )
        assertTrue(
            "「添加另一个账号」时日历页已经在栈里，要原地复用，不能再压一个",
            Regex("""launchSingleTop\s*=\s*true""").containsMatchIn(b),
        )
        assertFalse("别再分两条路走（popBackStack 一条、navigate 一条）", b.contains("popBackStack"))
    }

    @Test
    fun `账号全没了要显式回登录页`() {
        val b = block("LaunchedEffect(loggedIn)")
        assertTrue("没按 AuthRouting.mustResetToSetup 判断", b.contains("AuthRouting.mustResetToSetup("))
        assertTrue("没跳回登录页", b.contains("navigate(AuthRouting.SETUP)"))
        assertTrue(
            "回登录页要清空整个返回栈，不然按返回会回到没有账号的页面",
            Regex("""popUpTo\(nav\.graph\.id\)\s*\{\s*inclusive\s*=\s*true\s*}""").containsMatchIn(b),
        )
    }
}
