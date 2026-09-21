// 门禁一（下半）：拿 CLDR 里真实存在、而 Android 那套 java.time 吃不下的
// pattern 打 CalendarFormats。
//
// 为什么要单独一条：上面那条按 8 种语言遍历，用的是这 8 种语言当下的 CLDR
// 数据 —— 今天它们恰好都落在两套语法的交集里。但交集之外的写法在 CLDR 里
// 是真实存在的，而且 CLDR 每年都在动：
//
//   - "Bh:mm"：zh-Hant 的标准短时间格式（JDK 自己的 CLDR 数据就是这个）。
//     B = flexible day period，JDK 16 才进 java.time；本仓没开
//     coreLibraryDesugaring、minSdk 26，设备上那份 java.time 不认识它。
//   - "#HH:mm" / "'sike' #y ) #M ) #d"：tok（托克劳语）在 icu4j 77.1 /
//     CLDR 47 里的 Hm 和 yMMMd。# 是 java.time 的保留字符，直接抛
//     IllegalArgumentException: Pattern includes reserved character: '#'。
//
// 这条门禁在修之前是红的：那时候 of() 是
//   DateTimeFormatter.ofPattern(getBestDateTimePattern(...), locale)
// 一行，没有降级也没有兜底。

package cn.bywave.calendar.ui.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Locale

class DateTimePatternCompatTest {

    private val moment: Instant = Instant.parse("2026-09-21T15:04:05Z")

    /** CLDR 里真实出现过、Android 的 java.time 吃不下的 pattern。 */
    private val hostile = listOf(
        "Bh:mm" to "zh-Hant 标准短时间格式",
        "BBBBh:mm" to "B 的长写法",
        "b h:mm" to "b（固定时段：正午/午夜）",
        "#HH:mm" to "tok/Hm（icu4j 77.1）",
        "'sike' #y ) #M ) #d" to "tok/yMMMd（icu4j 77.1）",
        "y {M} d" to "花括号也是 java.time 的保留字符",
    )

    @Test
    fun `这些pattern确实是Android那套javatime吃不下的`() {
        // 门禁自己的前提也要能验：如果哪天这些字符变成合法的，这条会红，
        // 提醒人回来重新挑样本，而不是让整个文件变成一堆恒真断言。
        assertEquals(setOf('B'), javaTimeUnsupportedChars("Bh:mm"))
        assertEquals(setOf('b'), javaTimeUnsupportedChars("b h:mm"))
        assertEquals(setOf('#'), javaTimeUnsupportedChars("#HH:mm"))
        assertEquals(setOf('{', '}'), javaTimeUnsupportedChars("y {M} d"))
    }

    @Test
    fun `降级之后pattern里没有javatime不认识的字符`() {
        for ((pattern, why) in hostile) {
            val safe = toJavaTimePattern(pattern)
            assertTrue("$why：[$pattern] 降级后成了空串", safe.isNotBlank())
            assertEquals("$why：[$pattern] -> [$safe] 还留着不认识的字符", emptySet<Char>(), javaTimeUnsupportedChars(safe))
            val out = DateTimeFormatter.ofPattern(safe, Locale.ENGLISH).withZone(java.time.ZoneId.of("UTC")).format(moment)
            assertTrue("$why：[$safe] 格式化出空串", out.isNotBlank())
        }
    }

    @Test
    fun `CalendarFormats拿到这些pattern也不会崩`() {
        for ((pattern, why) in hostile) {
            val formats = CalendarFormats(Locale.forLanguageTag("zh-TW"), use24Hour = false) { _, _ -> pattern }
            for ((name, formatter) in listOf(
                "time" to formats.time,
                "dayHeader" to formats.dayHeader,
                "monthDay" to formats.monthDay,
                "monthHeader" to formats.monthHeader,
                "monthDayYear" to formats.monthDayYear,
            )) {
                val out = formatter.format(moment)
                assertTrue("$why：$name 产出空串", out.isNotBlank())
            }
        }
    }

    /** 连 getBestDateTimePattern 自己抛了，也不能让界面跟着崩。 */
    @Test
    fun `取pattern那一步抛了也要有东西可显示`() {
        val formats = CalendarFormats(Locale.GERMAN, use24Hour = true) { _, _ -> throw IllegalStateException("boom") }
        assertTrue(formats.time.format(moment).isNotBlank())
        assertTrue(formats.dayHeader.format(moment).isNotBlank())
        assertTrue(formats.monthDay.format(moment).isNotBlank())
        assertTrue(formats.monthHeader.format(moment).isNotBlank())
        assertTrue(formats.monthDayYear.format(moment).isNotBlank())
    }

    @Test
    fun `引号里的字面量原样保留`() {
        // es 的 yMMMMdEEEE 就是这个形状，'de' 是西班牙语的「的」，不是字段。
        val safe = toJavaTimePattern("EEEE, d 'de' MMMM 'de' y")
        assertEquals("EEEE, d 'de' MMMM 'de' y", safe)
        val out = DateTimeFormatter.ofPattern(safe, Locale.forLanguageTag("es"))
            .withZone(java.time.ZoneId.of("UTC")).format(moment)
        assertTrue(out.contains(" de "))
    }

    @Test
    fun `引号没闭合也不许抛`() {
        // nnh（CLDR 里真实存在）的 yMMMd 引号就是不配对的。补齐而不是抛。
        val safe = toJavaTimePattern("'lyɛ̌ʼ d 'na' MMMM, y")
        DateTimeFormatter.ofPattern(safe, Locale.ENGLISH)   // 不抛即通过
        assertEquals(0, safe.count { it == '\'' } % 2)
    }

    @Test
    fun `字段里的非ASCII字符是字面量不是字段`() {
        // ja / ko 的 yMMMd 里有 年 月 日 / 년 일。java.time 把非 ASCII 字母
        // 当字面量，所以这些必须原样留下 —— 顺手丢掉就等于把日期格式改坏。
        assertEquals("y年M月d日", toJavaTimePattern("y年M月d日"))
        assertEquals("y년 MMM d일", toJavaTimePattern("y년 MMM d일"))
    }
}
