// 8 种语言是硬要求：默认语言（简体中文）里有的 key，其余 7 门一个都不许少。
//
// 少一条不会编译失败、不会崩，只会让那门语言的用户在一句中文旁边继续用。
// 这条门禁就是拦这个的。

package cn.bywave.calendar

import org.junit.Assert.assertTrue
import org.junit.Test

class StringResourceParityTest {

    @Test
    fun `每门语言的字符串key和默认语言完全一致`() {
        val tags = ResLocales.localeTags()
        val defaultDir = tags.entries.first { it.value == "zh-Hans" }.key
        val reference = ResLocales.strings(defaultDir).keys
        assertTrue("默认资源里一条字符串都没有，路径大概找错了：${ResLocales.resDir}", reference.isNotEmpty())

        val failures = mutableListOf<String>()
        for ((dir, tag) in tags) {
            if (dir == defaultDir) continue
            val keys = ResLocales.strings(dir).keys
            val missing = (reference - keys).sorted()
            val extra = (keys - reference).sorted()
            if (missing.isNotEmpty()) failures += "$dir($tag) 缺 ${missing.size} 条：$missing"
            if (extra.isNotEmpty()) failures += "$dir($tag) 多出 ${extra.size} 条（默认语言里没有）：$extra"
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    /** 空串等于没翻。 */
    @Test
    fun `没有空的字符串`() {
        val failures = mutableListOf<String>()
        for ((dir, tag) in ResLocales.localeTags()) {
            for ((key, value) in ResLocales.strings(dir)) {
                if (value.isBlank()) failures += "$dir($tag) 的 $key 是空的"
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }
}
