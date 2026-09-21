// 门禁四：扫到一张登录码，**不许**直接就批准。
//
// 出事的形状：相机一识别到码就立刻 POST desktop-pair-approve，屏幕上先
// 出现的是「✓ 已批准」。别人递一张码说「扫一下看菜单」，扫完对面那台机器
// 就拿到了一整套 refresh + access token —— 等于账号，而且没有撤销的路。
//
// 两条断言：
//   1. decideAfterScan 拿到一张合法的登录码，产出的必须是「停下来问人」；
//   2. 扫码回调那个 lambda 里不许出现任何网络调用 —— 这条是直接读源码的，
//      因为「有没有副作用」这件事靠单元测试的返回值看不出来。

package cn.bywave.calendar.ui.setup

import cn.bywave.calendar.ResLocales
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DesktopPairScanDecisionTest {

    private val desktopQr = "https://cal.example.com/desktop-pair/ABCD2345"
    private val webQr = "https://cal.example.com:8443/web-pair/ABCD2345"

    @Test
    fun `扫到电脑端登录码只会停在确认页`() {
        val d = decideAfterScan(desktopQr, signedIn = true)
        assertTrue("扫码后直接做了别的事：$d", d is ScanDecision.Confirm)
        d as ScanDecision.Confirm
        assertEquals(PairKind.DESKTOP, d.parsed.kind)
        assertEquals("ABCD2345", d.parsed.code)
        assertEquals("cal.example.com", d.parsed.host)
    }

    @Test
    fun `扫到网页端登录码只会停在确认页`() {
        val d = decideAfterScan(webQr, signedIn = true)
        assertTrue("扫码后直接做了别的事：$d", d is ScanDecision.Confirm)
        d as ScanDecision.Confirm
        assertEquals(PairKind.WEB, d.parsed.kind)
        assertEquals("cal.example.com:8443", d.parsed.host)
    }

    @Test
    fun `没登录和不是登录码各走各的`() {
        assertEquals(ScanDecision.NotSignedIn, decideAfterScan(desktopQr, signedIn = false))
        assertEquals(ScanDecision.NotPair, decideAfterScan("https://example.com/menu", signedIn = true))
        assertEquals(ScanDecision.NotPair, decideAfterScan("随便一张码", signedIn = true))
    }

    /** 扫码这一步能产出的分支就这三个。多一个「自动批准」就红。 */
    @Test
    fun `扫码结果类型里没有自动批准这一支`() {
        val names = ScanDecision::class.java.declaredClasses.map { it.simpleName }.toSortedSet()
        assertEquals(sortedSetOf("Confirm", "NotPair", "NotSignedIn"), names)
    }

    @Test
    fun `扫码回调里没有任何网络调用`() {
        val src = sourceFile("app/src/main/kotlin/cn/bywave/calendar/ui/setup/DesktopPairScannerScreen.kt")
        val text = src.readText()
        val body = lambdaBody(text, "onResult = {")
        for (forbidden in listOf("client.api", "approve(", "Approve(", "ApiClient")) {
            assertTrue(
                "扫码回调里出现了 $forbidden —— 识别到码就动手，用户没有拍板的机会：\n$body",
                !body.contains(forbidden),
            )
        }
    }

    @Test
    fun `确认页该显示的东西都在`() {
        val text = sourceFile("app/src/main/kotlin/cn/bywave/calendar/ui/setup/DesktopPairScannerScreen.kt").readText()
        for (key in listOf(
            "pairscan_confirm_title",
            "pairscan_confirm_account",
            "pairscan_confirm_server",
            "pairscan_confirm_code",
            "pairscan_confirm_warning",
            "pairscan_confirm_approve",
        )) {
            assertTrue("确认页没有用到 $key", text.contains(key))
            // 8 种语言一条都不许少。
            for ((dir, tag) in ResLocales.localeTags()) {
                assertTrue("$dir($tag) 缺 $key", ResLocales.strings(dir).containsKey(key))
            }
        }
    }

    @Test
    fun `hostOf 拿得到主机名`() {
        assertEquals("cal.example.com", hostOf("https://cal.example.com"))
        assertEquals("cal.example.com:8443", hostOf("https://cal.example.com:8443/api/v1"))
        assertEquals("", hostOf(null))
        assertEquals("", hostOf("   "))
    }

    private fun sourceFile(relative: String): File {
        // ResLocales.resDir 已经把模块根定位好了：app/src/main/res -> 上溯三级 = app/
        val moduleRoot = ResLocales.resDir.parentFile.parentFile.parentFile.parentFile
        val f = File(moduleRoot, relative)
        assertTrue("找不到源码：${f.absolutePath}", f.isFile)
        return f
    }

    /** 取 `marker` 之后那一对花括号里的内容。 */
    private fun lambdaBody(text: String, marker: String): String {
        val start = text.indexOf(marker)
        assertTrue("源码里找不到 $marker", start >= 0)
        var i = text.indexOf('{', start)
        var depth = 0
        val from = i
        while (i < text.length) {
            when (text[i]) {
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return text.substring(from, i + 1)
                }
            }
            i++
        }
        throw AssertionError("$marker 的花括号没配对")
    }
}
