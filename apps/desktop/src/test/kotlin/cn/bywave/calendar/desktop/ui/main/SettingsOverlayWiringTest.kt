package cn.bywave.calendar.desktop.ui.main

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 主界面有没有真的把设置页交给 [SettingsOverlay]。
 *
 * SettingsOverlayTest 测的是那一层自己：点击不穿透、换账号整页重建、换票不重建。
 * 但那三条只在 MainScreen 真的这么用它的时候才算数 —— 设置页绕过它直接画、
 * 提示条没交进去、交进去的不是当前账号，那三条照样全绿，用户照样碰到老问题：
 * 点提示条穿透到顶栏、换了账号设置页还挂着上一个账号的列表、在设置页里被切走
 * 账号却看不到任何说明。
 *
 * MainScreen 要整套 ProfileStore / ApiClient 才跑得起来，所以和安卓的
 * SignedOutNoticeWiringTest 一样读源码判断。
 */
class SettingsOverlayWiringTest {

    /**
     * 去掉注释：注释里写到了不等于代码里做到了。
     *
     * 认字符串（普通的、三引号的）和字符字面量，免得把字符串里的 `//` 当成注释、
     * 吃掉半行代码；块注释按 Kotlin 的规矩可以嵌套。
     */
    private fun stripComments(src: String): String {
        val out = StringBuilder(src.length)
        var i = 0
        while (i < src.length) {
            when {
                src.startsWith("//", i) -> {
                    while (i < src.length && src[i] != '\n') i++
                }
                src.startsWith("/*", i) -> {
                    var depth = 0
                    while (i < src.length) {
                        when {
                            src.startsWith("/*", i) -> { depth++; i += 2 }
                            src.startsWith("*/", i) -> { depth--; i += 2; if (depth == 0) break }
                            else -> { if (src[i] == '\n') out.append('\n'); i++ }
                        }
                    }
                    out.append(' ')
                }
                src.startsWith("\"\"\"", i) -> {
                    val end = src.indexOf("\"\"\"", i + 3)
                    check(end >= 0) { "三引号字符串没收尾 —— 判据瞎了" }
                    out.append(src, i, end + 3)
                    i = end + 3
                }
                src[i] == '"' || src[i] == '\'' -> {
                    val quote = src[i]
                    val start = i++
                    while (i < src.length && src[i] != quote && src[i] != '\n') {
                        if (src[i] == '\\') i++
                        i++
                    }
                    check(i < src.length && src[i] == quote) { "第 $start 个字符起的字面量没收尾 —— 判据瞎了" }
                    i++
                    out.append(src, start, i)
                }
                else -> out.append(src[i++])
            }
        }
        return out.toString()
    }

    private fun src(rel: String): String {
        // Gradle 把测试的工作目录设在模块根（apps/desktop）。
        val f = listOf(File("src/main/kotlin/$rel"), File("apps/desktop/src/main/kotlin/$rel")).first { it.exists() }
        return stripComments(f.readText())
    }

    /** 从 [openIdx] 处的开括号起，找到和它配对的闭括号的位置。 */
    private fun matching(text: String, openIdx: Int, open: Char, close: Char): Int {
        require(text[openIdx] == open)
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
        assertTrue(start >= 0, "没找到 `$signature` —— 判据瞎了")
        val paramsClose = matching(text, start + signature.length - 1, '(', ')')
        val bodyOpen = text.indexOf('{', paramsClose)
        return text.substring(bodyOpen, matching(text, bodyOpen, '{', '}') + 1)
    }

    /** 一次调用：参数表 `( ... )`，和紧跟在后面的尾随 lambda `{ ... }`（没有就是 null）。 */
    private class Call(val args: String, val trailing: String?)

    private fun call(text: String, callee: Regex): Call {
        val m = callee.find(text)
        assertTrue(m != null, "没找到 `${callee.pattern}` 的调用 —— 判据瞎了")
        val open = m!!.range.last
        val close = matching(text, open, '(', ')')
        val after = text.substring(close + 1).trimStart()
        val trailing = if (after.startsWith("{")) {
            val lambdaOpen = text.indexOf('{', close)
            text.substring(lambdaOpen, matching(text, lambdaOpen, '{', '}') + 1)
        } else null
        return Call(text.substring(open, close + 1), trailing)
    }

    /** 每一条都查完再报：红的时候看得出是哪几条接线断了，而不是只看到第一条。 */
    private fun allOf(vararg checks: Pair<String, Boolean>) {
        val bad = checks.filterNot { it.second }.map { it.first }
        assertTrue(bad.isEmpty(), bad.joinToString("\n"))
    }

    private val mainScreenFile by lazy { src("cn/bywave/calendar/desktop/ui/main/MainScreen.kt") }
    private val mainScreen by lazy { funBody(mainScreenFile, "fun MainScreen(") }

    private val settingsScreenCall = Regex("""(?<![\w.])SettingsScreen\(""")
    private val overlayCall = Regex("""(?<![\w.])SettingsOverlay\(""")

    /** SettingsOverlay 的内容：尾随 lambda，或者写成具名参数 `content = { ... }`。 */
    private fun overlayContent(overlay: Call): String? {
        overlay.trailing?.let { return it }
        val m = Regex("""\bcontent\s*=\s*\{""").find(overlay.args) ?: return null
        val open = m.range.last
        return overlay.args.substring(open, matching(overlay.args, open, '{', '}') + 1)
    }

    @Test
    fun `设置页只经由 SettingsOverlay 画出来`() {
        val content = overlayContent(call(mainScreen, overlayCall))
        allOf(
            "MainScreen 里只该有一处 SettingsScreen(...)：多出来的那处没有经过 SettingsOverlay，点击会穿透、换账号不会重建" to
                (settingsScreenCall.findAll(mainScreen).count() == 1),
            "SettingsScreen 没放在 SettingsOverlay 的内容里：设置页不在那一层里，按账号重建和拦点击都管不到它" to
                (content != null && settingsScreenCall.containsMatchIn(content)),
            "MainScreen 里只该有一处 SettingsOverlay" to (overlayCall.findAll(mainScreen).count() == 1),
        )
    }

    @Test
    fun `设置页那一层按当前活动账号重建`() {
        // SettingsOverlay 用 key(profile.deviceId, ...) 包住内容（行为在 SettingsOverlayTest 里测），
        // 但它认的是传进来的那个 profile：传的不是「此刻的活动账号」，key 就永远不会变。
        val args = call(mainScreen, overlayCall).args
        allOf(
            "p 不是从 ProfileStore 实时收的活动账号" to
                Regex("""val\s+profile\s+by\s+ProfileStore\.profile\.collectAsState\(\)""").containsMatchIn(mainScreen),
            "p 不是直接取 profile（套了 remember 之类就成了旧账号）" to
                Regex("""val\s+p\s*=\s*profile\s*\n""").containsMatchIn(mainScreen),
            "交给 SettingsOverlay 的不是当前账号 p —— 换了账号设置页不会重建" to
                Regex("""\bprofile\s*=\s*p\s*[,)]""").containsMatchIn(args),
        )
    }

    @Test
    fun `被登出提示条只有一份_主界面和设置页都画它`() {
        val decl = Regex("""val\s+signedOutBanners\s*:\s*@Composable\s*\(\)\s*->\s*Unit\s*=\s*\{""").find(mainScreen)
        assertTrue(decl != null, "没找到 `val signedOutBanners: @Composable () -> Unit = {` —— 判据瞎了")
        val lambdaOpen = decl!!.range.last
        val lambda = mainScreen.substring(lambdaOpen, matching(mainScreen, lambdaOpen, '{', '}') + 1)
        val outsideDecl = mainScreen.removeRange(lambdaOpen, lambdaOpen + lambda.length)
        val args = call(mainScreen, overlayCall).args
        allOf(
            "signedOutBanners 里没画 SignedOutNoticeBanner" to lambda.contains("SignedOutNoticeBanner("),
            "SignedOutNoticeBanner 在 signedOutBanners 之外还有一份：两边各画各的，迟早一边漏改" to
                !outsideDecl.contains("SignedOutNoticeBanner("),
            "主界面没画 signedOutBanners()" to Regex("""(?<![\w.])signedOutBanners\(\)""").containsMatchIn(outsideDecl),
            "设置页那一层没拿到提示条：在设置页里被切走账号，页面直接换成另一个账号、没有任何说明" to
                Regex("""\bbanners\s*=\s*signedOutBanners\s*[,)]""").containsMatchIn(args),
        )
    }

    @Test
    fun `去注释本身没瞎`() {
        // 判据的判据：上面几条全靠「去掉注释后的源码」，去错了它们可能对着一堆残片判绿。
        // 整份 MainScreen 去完注释括号还是配平的：哪里吃多了半行，这里先红。
        assertEquals(mainScreenFile.count { it == '{' }, mainScreenFile.count { it == '}' }, "去注释后花括号不配平")
        assertEquals(mainScreenFile.count { it == '(' }, mainScreenFile.count { it == ')' }, "去注释后圆括号不配平")

        val sample = """
            val a = "http://x" // 尾注释 SettingsScreen(
            /* 块注释 /* 嵌套 */ SettingsOverlay( */ val b = '"'
            val c = ${"\"\"\""}raw // 不是注释${"\"\"\""}
        """.trimIndent()
        val out = stripComments(sample)
        assertEquals(
            "val a = \"http://x\"\n  val b = '\"'\nval c = \"\"\"raw // 不是注释\"\"\"",
            out.lines().joinToString("\n") { it.trimEnd() },
        )
    }
}
