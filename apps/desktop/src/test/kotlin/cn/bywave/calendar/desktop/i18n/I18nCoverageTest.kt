// 8 种语言的文案齐不齐，由这里钉住。
//
// I18n.t() 缺键时会静默回落到英文，不报错 —— 于是「新增文案漏翻了一门」
// 这件事在开发机上永远看不出来，只有那门语言的用户会在一堆中文里看到一句英文。
// 这个文件把「齐」变成一条会红的断言。

package cn.bywave.calendar.desktop.i18n

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class I18nCoverageTest {

    private val locales = I18n.Locale.entries.toList()

    /** 8 种语言一个都不能少。 */
    @Test
    fun `八种语言都有字典`() {
        assertEquals(8, locales.size, "语言列表变了：${locales.map { it.code }}")
        for (loc in locales) {
            assertTrue(
                I18n.DICTIONARIES[loc]?.isNotEmpty() == true,
                "${loc.code} 没有字典",
            )
        }
    }

    /** 每门语言的键集合必须和英文完全一致 —— 少一个就是那门语言的用户会看到英文。 */
    @Test
    fun `每门语言的键和英文完全一致`() {
        val en = I18n.DICTIONARIES[I18n.Locale.EN] ?: error("英文字典没了")
        for (loc in locales) {
            if (loc == I18n.Locale.EN) continue
            val dict = I18n.DICTIONARIES[loc] ?: error("${loc.code} 没有字典")
            val missing = (en.keys - dict.keys).sorted()
            val extra = (dict.keys - en.keys).sorted()
            assertTrue(
                missing.isEmpty(),
                "${loc.code} 少了 ${missing.size} 个键，这些文案那门语言的用户会看到英文：$missing",
            )
            assertTrue(
                extra.isEmpty(),
                "${loc.code} 多了 ${extra.size} 个键（英文里没有，说明键名打错了，t() 永远取不到）：$extra",
            )
        }
    }

    /** 没有空值。空字符串在界面上就是一块什么都没有的地方。 */
    @Test
    fun `没有空文案`() {
        for (loc in locales) {
            val blanks = I18n.DICTIONARIES[loc]!!.filterValues { it.isBlank() }.keys.sorted()
            assertTrue(blanks.isEmpty(), "${loc.code} 有空文案：$blanks")
        }
    }

    /**
     * 占位符要跟着翻译一起搬。
     *
     * "{n} min before" 翻成 "提前 分钟" 的话不会报任何错，界面上就是少一个数字。
     */
    @Test
    fun `占位符在每门语言里都在`() {
        val placeholder = Regex("\\{([a-zA-Z]+)}")
        val en = I18n.DICTIONARIES[I18n.Locale.EN]!!
        val problems = mutableListOf<String>()
        for ((key, enValue) in en) {
            val want = placeholder.findAll(enValue).map { it.groupValues[1] }.toSortedSet()
            if (want.isEmpty()) continue
            for (loc in locales) {
                if (loc == I18n.Locale.EN) continue
                val v = I18n.DICTIONARIES[loc]?.get(key) ?: continue
                val got = placeholder.findAll(v).map { it.groupValues[1] }.toSortedSet()
                if (got != want) problems.add("${loc.code} / $key：要 $want，实际 $got（原文：$v）")
            }
        }
        assertTrue(problems.isEmpty(), "占位符对不上，界面上会缺一段：\n" + problems.joinToString("\n"))
    }

    /** 本轮新增的这两条（一句话录入失败的提示）八门语言都要有，且不许直接照抄英文。 */
    @Test
    fun `一句话录入的失败提示八门语言齐全`() {
        val keys = listOf("event.edit.quickadd.failed", "event.edit.quickadd.unsupported")
        val en = I18n.DICTIONARIES[I18n.Locale.EN]!!
        for (key in keys) {
            assertTrue(en.containsKey(key), "英文里没有 $key")
            for (loc in locales) {
                val v = I18n.DICTIONARIES[loc]?.get(key)
                assertTrue(!v.isNullOrBlank(), "${loc.code} 缺 $key")
                if (loc != I18n.Locale.EN) {
                    assertTrue(v != en[key], "${loc.code} 的 $key 是英文原文，没翻")
                }
            }
        }
    }
}
