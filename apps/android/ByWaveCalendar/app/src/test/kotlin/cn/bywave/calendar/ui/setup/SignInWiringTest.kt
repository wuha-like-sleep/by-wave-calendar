package cn.bywave.calendar.ui.setup

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SignInFormTest 测的是规矩本身；这里盯「接线」：规矩写对了但登录那条路没用上，
 * 用户照样撞 400、照样进空白登录页。SetupViewModel 要 BywaveApp.instance，
 * MainActivity / CalendarScreen 是 Compose，纯 JVM 里都跑不起来（本模块没有
 * Robolectric），所以和 SignedOutNoticeWiringTest 一样读源码。
 */
class SignInWiringTest {

    private fun src(rel: String): String {
        // 单元测试的工作目录是 app/
        val f = listOf(File("src/main/kotlin/$rel"), File("app/src/main/kotlin/$rel")).first { it.exists() }
        // 去掉行注释：注释里写到了不等于代码里做到了。
        return f.readLines().joinToString("\n") { it.replace(Regex("//.*$"), "") }
    }

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

    /** 函数体：跳过参数表，取到和函数体 `{` 配对的 `}`。 */
    private fun funBody(text: String, signature: String): String {
        require(signature.endsWith("("))
        val start = text.indexOf(signature)
        assertTrue("没找到 `$signature` —— 判据瞎了", start >= 0)
        val paramsClose = matching(text, start + signature.length - 1, '(', ')')
        val bodyOpen = text.indexOf('{', paramsClose)
        return text.substring(bodyOpen, matching(text, bodyOpen, '{', '}') + 1)
    }

    /** 一次调用的整个参数表（第一处）。 */
    private fun callArgs(text: String, callee: String): String {
        require(callee.endsWith("("))
        val start = text.indexOf(callee)
        assertTrue("没找到 `$callee` —— 判据瞎了", start >= 0)
        val open = start + callee.length - 1
        return text.substring(open, matching(text, open, '(', ')') + 1)
    }

    /** 具名参数传进去的那个 lambda：`name = { ... }`。 */
    private fun lambdaArg(args: String, name: String): String {
        val m = Regex("""\b$name\s*=\s*\{""").find(args)
        assertTrue("没找到参数 `$name = {` —— 判据瞎了", m != null)
        val open = m!!.range.last
        return args.substring(open, matching(args, open, '{', '}') + 1)
    }

    /** 每一条都查完再报：红的时候看得出是哪几条接线断了，而不是只看到第一条。 */
    private fun allOf(vararg checks: Pair<String, Boolean>) {
        val bad = checks.filterNot { it.second }.map { it.first }
        assertTrue(bad.joinToString("\n"), bad.isEmpty())
    }

    private val vm by lazy { src("cn/bywave/calendar/ui/setup/SetupViewModel.kt") }
    private val calendarScreen by lazy { src("cn/bywave/calendar/ui/calendar/CalendarScreen.kt") }
    private val mainActivity by lazy { src("cn/bywave/calendar/MainActivity.kt") }

    @Test
    fun `账号密码登录发的和存的都是去掉空格的邮箱`() {
        val b = funBody(vm, "fun signIn(")
        val req = callArgs(b, "LoginRequest(")
        val save = callArgs(b, "completeLogin(")
        allOf(
            "signIn 没取去掉空格的邮箱" to Regex("""val\s+email\s*=\s*s\.signInEmail\b""").containsMatchIn(b),
            "发给服务端的不是去掉空格的那一份" to Regex("""(^|[^.\w])email\s*=\s*email\b""").containsMatchIn(req),
            "LoginRequest 里又用回了原样的输入" to !req.contains("s.email"),
            "存进账号列表的不是去掉空格的那一份" to Regex("""^\(\s*server\s*,\s*email\s*,""").containsMatchIn(save),
        )
    }

    @Test
    fun `两步验证完成后存的也是去掉空格的邮箱`() {
        val save = callArgs(funBody(vm, "fun verifyMfa("), "completeLogin(")
        assertTrue("verifyMfa 存的邮箱没去空格", save.contains("_state.value.signInEmail"))
    }

    @Test
    fun `三步各自报自己那一步的错`() {
        allOf(
            "账号密码登录没按 Password 报错" to callArgs(funBody(vm, "fun signIn("), "describe(").contains("LoginStep.Password"),
            "两步验证没按 Mfa 报错" to callArgs(funBody(vm, "fun verifyMfa("), "describe(").contains("LoginStep.Mfa"),
            "扫码登录没按 Pair 报错" to callArgs(funBody(vm, "fun onScanned("), "describe(").contains("LoginStep.Pair"),
        )
    }

    @Test
    fun `登录页建出来时取走预填`() {
        assertTrue(
            "SetupViewModel 的初始状态没读预填 —— 从提示条进来还是空白页",
            Regex("""MutableStateFlow\(\s*SetupUiState\.initial\(\s*profiles\.takeSignInPrefill\(\)\s*\)\s*\)""").containsMatchIn(vm),
        )
    }

    @Test
    fun `提示条上的重新登录带着被登出的那个账号`() {
        val banner = callArgs(funBody(calendarScreen, "fun CalendarScreen("), "SignedOutBanner(")
        val again = lambdaArg(banner, "onSignInAgain")
        allOf(
            "提示条的「重新登录」没把这条提示交出去" to Regex("""onSignInAgain\(\s*notice\s*\)""").containsMatchIn(again),
            "提示条的「重新登录」又接回了「添加账号」—— 进去是空白登录页" to !banner.contains("onAddAccount"),
        )
    }

    @Test
    fun `进登录页之前放好预填`() {
        val args = callArgs(mainActivity, "CalendarScreen(")

        val again = lambdaArg(args, "onSignInAgain")
        val put = Regex(
            """prefillNextSignIn\(\s*SignInPrefill\(\s*serverUrl\s*=\s*notice\.serverUrl\s*,\s*email\s*=\s*notice\.email\s*\)\s*\)""",
        ).find(again)
        val go = again.indexOf("nav.navigate(AuthRouting.SETUP")

        val add = lambdaArg(args, "onAddAccount")
        val clear = Regex("""prefillNextSignIn\(\s*null\s*\)""").find(add)
        val addGo = add.indexOf("nav.navigate(AuthRouting.SETUP")

        allOf(
            "「重新登录」没放预填" to (put != null),
            "「重新登录」没进登录页" to (go >= 0),
            "「重新登录」要先放预填再进登录页，登录页的 ViewModel 一建出来就取" to
                (put != null && go >= 0 && put.range.first < go),
            "普通「添加账号」没清预填，进去可能是上一个没取走的旧账号" to (clear != null),
            "普通「添加账号」要先清预填再进登录页" to (clear != null && addGo >= 0 && clear.range.first < addGo),
        )
    }

    @Test
    fun `连点两下重新登录_只进一张登录页_第二下不放预填`() {
        // 第一下点完，返回栈顶当场就是登录页，日历页还在退场动画里、按钮还点得到。
        // 第二下要是照样放预填：launchSingleTop 不会再建登录页，没人来取，那份预填
        // 一直留在格子里，到「最后一个账号也没了、清栈回登录页」时把已登出的账号填出来。
        val again = lambdaArg(callArgs(mainActivity, "CalendarScreen("), "onSignInAgain")
        val gate = Regex(
            """if\s*\(\s*AuthRouting\.signInAgainOpensSetup\(\s*nav\.currentDestination\?\.route\s*\)\s*\)\s*\{""",
        ).find(again)
        val gated = gate?.let { again.substring(it.range.last, matching(again, it.range.last, '{', '}') + 1) }
        val outside = if (gate == null || gated == null) again else again.replace(gated, "")
        allOf(
            "「重新登录」没按 AuthRouting.signInAgainOpensSetup(栈顶那一页) 把关：连点的第二下会放一份没人取的预填" to
                (gate != null),
            "放预填要在那道闸里面" to (gated?.contains("prefillNextSignIn(") == true),
            "进登录页要在那道闸里面" to (gated?.contains("nav.navigate(AuthRouting.SETUP") == true),
            "闸外面不许再放预填或跳页" to (!outside.contains("prefillNextSignIn(") && !outside.contains(".navigate(")),
            "「重新登录」进登录页没带 launchSingleTop：闸万一漏了，连点会压两张登录页" to
                Regex("""nav\.navigate\(AuthRouting\.SETUP\)\s*\{\s*launchSingleTop\s*=\s*true\s*\}""").containsMatchIn(again),
        )
    }

    @Test
    fun `往登录页跳的每一处都先定好预填`() {
        // 现在一共三处：添加账号（清空）、重新登录（放那个账号）、一个账号都不剩时清栈（清空）。
        // 前两处的先后在上面那条测试里查，这里查第三处，并且数着总数：以后多出一处往登录页跳的
        // 地方，这里先红 —— 新的那处也得先 prefillNextSignIn(...)，再把它加进来。
        val navs = Regex("""\.navigate\(\s*(AuthRouting\.SETUP|"setup")""").findAll(mainActivity).count()
        val effect = Regex("""LaunchedEffect\(\s*loggedIn\s*\)\s*\{""").find(mainActivity)
        assertTrue("没找到 `LaunchedEffect(loggedIn) {` —— 判据瞎了", effect != null)
        val reset = mainActivity.substring(effect!!.range.last, matching(mainActivity, effect.range.last, '{', '}') + 1)
        val clear = Regex("""prefillNextSignIn\(\s*null\s*\)""").find(reset)
        val go = reset.indexOf("nav.navigate(AuthRouting.SETUP")
        allOf(
            "往登录页跳的地方不再是 3 处（现在 $navs 处）：新的那处要先 prefillNextSignIn(...)，再更新这条测试" to
                (navs == 3),
            "清栈回登录页之前没清预填：格子里没人取的那一份会被填在这张本该空白的登录页上" to (clear != null),
            "清栈回登录页要先清预填再跳" to (clear != null && go >= 0 && clear.range.first < go),
        )
    }
}
