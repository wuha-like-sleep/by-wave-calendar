// 门禁三：非中文用户必须能删掉自己的账号。
//
// 出事的形状：8 个 locale 的 delete_account_confirm_phrase 全是同一串中文
// 「删除我的账号」，而删除按钮要求一字不差地输入它。德语用户手机上没有
// 中文输入法 —— 按钮永远是灰的，账号永远删不掉，界面上也不会有任何一句话
// 告诉他为什么。
//
// 这条门禁盯三件事：
//   1. 每门语言都有这串短语；
//   2. 它必须是服务端真的会接受的那几串之一（服务端认一整张表，不是一个
//      literal，见 src/routes/devices.ts 的 /account/delete）；
//   3. 非中文语言的那串必须不用中文输入法就能打出来。
// 第 3 条才是这次真正要拦的东西：前两条都满足、第 3 条不满足，就是修之前
// 的那个状态。

package cn.bywave.calendar.ui.settings

import cn.bywave.calendar.ResLocales
import org.junit.Assert.assertTrue
import org.junit.Test

class DeleteAccountPhraseTest {

    /**
     * 服务端接受的确认短语全集。
     * 来源：src/lib/i18n/locales/<lang>.ts 的
     * settings.account.deleteConfirmFieldPlaceholder，加上为老数据保留的
     * 中文 literal。服务端那边改了这张表，这里也要跟着改 —— 改漏了，
     * 用户会在一个看起来完全正确的输入框上被服务端判 bad_confirmation。
     */
    private val serverAccepts = setOf(
        "删除我的账号",        // zh-CN，也是服务端的 back-compat literal
        "刪除我的帳號",        // zh-TW
        "delete my account",  // en / ja / ko / fr / de（服务端这四门还没翻）
        "eliminar mi cuenta", // es
    )

    /** 打得出中文的那两门语言。其余语言不许用汉字当确认短语。 */
    private val chineseTags = setOf("zh-Hans", "zh-TW")

    @Test
    fun `每门语言都有确认短语且是服务端认的那几串之一`() {
        val failures = mutableListOf<String>()
        for ((dir, tag) in ResLocales.localeTags()) {
            val phrase = ResLocales.strings(dir)[KEY]
            if (phrase.isNullOrBlank()) {
                failures += "$dir($tag) 缺 $KEY"
                continue
            }
            if (phrase !in serverAccepts) {
                failures += "$dir($tag) 的确认短语 [$phrase] 不在服务端接受的集合里 $serverAccepts"
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun `非中文语言的确认短语不需要中文输入法就能打出来`() {
        val failures = mutableListOf<String>()
        for ((dir, tag) in ResLocales.localeTags()) {
            if (tag in chineseTags) continue
            val phrase = ResLocales.strings(dir)[KEY] ?: continue
            val cjk = phrase.filter { it.code in 0x2E80..0x9FFF || it.code in 0xF900..0xFAFF }
            if (cjk.isNotEmpty()) {
                failures += "$dir($tag) 要求用户输入汉字 [$cjk]（整串：$phrase）—— 这门语言的用户删不掉账号"
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    /**
     * 提示文案里那串短语必须是占位符填进去的，不能各写一份。
     * 各写一份的话，改了 phrase 而忘了改提示，用户看到的和要求输入的就是
     * 两串不同的字 —— 一样是删不掉，而且更难猜。
     */
    @Test
    fun `提示文案用占位符引用短语而不是自己再抄一遍`() {
        val failures = mutableListOf<String>()
        for ((dir, tag) in ResLocales.localeTags()) {
            val strings = ResLocales.strings(dir)
            for (key in listOf("delete_account_confirm_label", "delete_account_confirm_mismatch")) {
                val v = strings[key]
                if (v == null) {
                    failures += "$dir($tag) 缺 $key"
                    continue
                }
                if (!v.contains("%1\$s")) failures += "$dir($tag) 的 $key 没有用占位符：$v"
                for (known in serverAccepts) {
                    if (v.contains(known)) failures += "$dir($tag) 的 $key 里又抄了一遍短语 [$known]：$v"
                }
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    private companion object {
        const val KEY = "delete_account_confirm_phrase"
    }
}
