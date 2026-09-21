// 门禁一：8 种语言 × 12/24 小时 × CalendarFormats 的每一个 formatter，
// 用**真的 CLDR 数据**跑一遍，任何一个抛异常或者产出空串就红。
//
// 这条门禁守的是「把 ICU pattern 当 java.time pattern 用」这个缺陷类：
// CalendarFormats 的五个 formatter 都是构造时求值的 val，任意一个 of()
// 抛出来，顶栏所在的每一个界面（日/周/月视图、搜索、事件编辑）当场崩。
//
// 纯 JVM，不需要模拟器：pattern 从 icu4j 取（和设备上那套 ICU 是同一个
// DateTimePatternGenerator），Android 那个 DateFormat 桩根本不参与。

package cn.bywave.calendar.ui.calendar

import cn.bywave.calendar.ResLocales
import com.ibm.icu.text.DateTimePatternGenerator
import com.ibm.icu.util.ULocale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

class CalendarFormatsLocaleTest {

    private val icu: BestPatternProvider = { locale, skeleton ->
        DateTimePatternGenerator.getInstance(ULocale.forLocale(locale)).getBestPattern(skeleton)
    }

    /** 随便一个确定的时刻，只要能格式化出非空文字就行。 */
    private val moment: Instant = Instant.parse("2026-09-21T15:04:05Z")

    /** formatter 名字 → 取它用的 skeleton。和 CalendarFormats 里一一对应。 */
    private fun skeletons(use24Hour: Boolean) = listOf(
        "time" to if (use24Hour) "Hm" else "hm",
        "dayHeader" to "yMMMMdEEEE",
        "monthDay" to "MMMd",
        "monthHeader" to "yMMMM",
        "monthDayYear" to "yMMMd",
    )

    private fun formatters(f: CalendarFormats) = listOf(
        "time" to f.time,
        "dayHeader" to f.dayHeader,
        "monthDay" to f.monthDay,
        "monthHeader" to f.monthHeader,
        "monthDayYear" to f.monthDayYear,
    )

    /** 资源目录里的语言必须盖满这 8 种，少一门直接红 —— 不然下面那条
     *  遍历门禁会在「少了一门语言」的情况下照样绿。 */
    @Test
    fun `八种语言一个都不少`() {
        val tags = ResLocales.localeTags().values.toSet()
        for (required in ResLocales.REQUIRED_TAGS) {
            assertTrue("res 里缺语言：$required（现有 $tags）", required in tags)
        }
    }

    @Test
    fun `八种语言乘以12和24小时制每个formatter都能格式化`() {
        val failures = mutableListOf<String>()
        for ((dir, tag) in ResLocales.localeTags()) {
            val locale = Locale.forLanguageTag(tag)
            for (use24 in listOf(true, false)) {
                val formats = CalendarFormats(locale, use24, icu)
                for ((name, formatter) in formatters(formats)) {
                    val out = try {
                        formatter.format(moment)
                    } catch (e: Exception) {
                        failures += "$dir($tag) 24h=$use24 $name 抛了 ${e.javaClass.simpleName}: ${e.message}"
                        continue
                    }
                    if (out.isBlank()) failures += "$dir($tag) 24h=$use24 $name 产出空串"
                }
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    /**
     * 上面那条只能证明「用户看到了东西」，看不出这东西是不是兜底回落出来的
     * —— 只要 of() 的 runCatching 接住了，坏的 pattern 也会绿。
     *
     * 所以这里再断言一次：每个 formatter 的产出必须**等于**「把 ICU 的
     * pattern 降级之后直接构造」的产出。一旦降级那一步漏了什么、
     * 真的走了固定 pattern 的兜底，两边就不相等。
     */
    @Test
    fun `没有一个formatter是靠兜底回落撑住的`() {
        val zone = ZoneId.systemDefault()
        val failures = mutableListOf<String>()
        for ((dir, tag) in ResLocales.localeTags()) {
            val locale = Locale.forLanguageTag(tag)
            for (use24 in listOf(true, false)) {
                val formats = CalendarFormats(locale, use24, icu)
                val actual = formatters(formats).toMap()
                for ((name, skeleton) in skeletons(use24)) {
                    val cldr = icu(locale, skeleton)
                    val safe = toJavaTimePattern(cldr)
                    val bad = javaTimeUnsupportedChars(safe)
                    if (bad.isNotEmpty()) {
                        failures += "$dir($tag) $skeleton 降级后仍有 java.time 不认识的字符 $bad：[$cldr] -> [$safe]"
                        continue
                    }
                    val expected = DateTimeFormatter.ofPattern(safe, locale).withZone(zone).format(moment)
                    val got = actual.getValue(name).format(moment)
                    if (expected != got) {
                        failures += "$dir($tag) 24h=$use24 $name 走了兜底：期望 [$expected]（pattern [$safe]），实际 [$got]"
                    }
                }
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    /**
     * 上面三条都是按「五个 formatter」写死的。以后有人加第六个，门禁不会
     * 报错，只会不管它 —— 而那正是这次出事的形状（构造时求值的 val）。
     * 数一下真实的 formatter 个数，对不上就红。
     */
    @Test
    fun `CalendarFormats里只有这五个formatter`() {
        val getters = CalendarFormats::class.java.methods
            .filter { it.returnType == DateTimeFormatter::class.java && it.parameterCount == 0 }
            .map { it.name }
            .toSortedSet()
        assertEquals(
            "CalendarFormats 的 formatter 变了，这个文件里的三条遍历门禁要同步",
            sortedSetOf("getDayHeader", "getMonthDay", "getMonthDayYear", "getMonthHeader", "getTime"),
            getters,
        )
    }
}
