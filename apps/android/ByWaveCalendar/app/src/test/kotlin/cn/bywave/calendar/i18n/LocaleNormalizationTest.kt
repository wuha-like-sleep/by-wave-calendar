package cn.bywave.calendar.i18n

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 守「平台回给我们的语言标签，归一到设置页那一行显示哪一项」。
 *
 * 这条判断错了不报任何错：用户的语言被静默改成另一门，设置页显示的和实际生效的
 * 对不上，而且点回去还没反应。之前正是这样 —— zh-Hans 把 zh-TW 吃掉了，
 * 而当时 35 条门禁里没有一条碰过 LocaleHelper。
 *
 * 纯 JVM，不需要模拟器：normalizeToKnown 只用 java.util.Locale。
 */
class LocaleNormalizationTest {

    /** 这些是**平台真的会回给我们的写法**，不是编出来的：
     *  setLocale 写进平台的就是 languages 里的 tag（zh-TW），
     *  用户从系统设置那条路选的则来自 locales_config.xml（也是 zh-TW）；
     *  系统语言本身还可能是 zh-Hant-TW / zh-Hans-CN / zh-CN。 */
    @Test
    fun `中文按地区和文字分繁简`() {
        // 这一条是当初真正踩的那个：没有 script、country=TW
        assertEquals("繁体的 zh-TW 不能被归一成简体", "zh-TW", LocaleHelper.normalizeToKnown("zh-TW"))
        assertEquals("zh-Hant-TW", "zh-TW", LocaleHelper.normalizeToKnown("zh-Hant-TW"))
        assertEquals("zh-Hant", "zh-TW", LocaleHelper.normalizeToKnown("zh-Hant"))
        assertEquals("香港用繁体", "zh-TW", LocaleHelper.normalizeToKnown("zh-HK"))
        assertEquals("澳门用繁体", "zh-TW", LocaleHelper.normalizeToKnown("zh-MO"))

        assertEquals("zh-CN", "zh-Hans", LocaleHelper.normalizeToKnown("zh-CN"))
        assertEquals("zh-Hans-CN", "zh-Hans", LocaleHelper.normalizeToKnown("zh-Hans-CN"))
        assertEquals("新加坡用简体", "zh-Hans", LocaleHelper.normalizeToKnown("zh-SG"))
        assertEquals("光一个 zh 按简体", "zh-Hans", LocaleHelper.normalizeToKnown("zh"))
    }

    @Test
    fun `其余几门语言带不带地区都归到裸语言码`() {
        assertEquals("en", LocaleHelper.normalizeToKnown("en"))
        assertEquals("en", LocaleHelper.normalizeToKnown("en-US"))
        assertEquals("en", LocaleHelper.normalizeToKnown("en-GB"))
        assertEquals("de", LocaleHelper.normalizeToKnown("de-DE"))
        assertEquals("de", LocaleHelper.normalizeToKnown("de-AT"))
        assertEquals("fr", LocaleHelper.normalizeToKnown("fr-CA"))
        assertEquals("es", LocaleHelper.normalizeToKnown("es-MX"))
        assertEquals("ja", LocaleHelper.normalizeToKnown("ja-JP"))
        assertEquals("ko", LocaleHelper.normalizeToKnown("ko-KR"))
    }

    @Test
    fun `不支持的语言原样返回，不许被随便归到某一门`() {
        assertEquals("pt-BR", LocaleHelper.normalizeToKnown("pt-BR"))
        assertEquals("ru", LocaleHelper.normalizeToKnown("ru"))
    }

    /** 归一必须是幂等的：列表里的每个 tag 喂回去都得是它自己。
     *  不幂等的话，每次冷启动都会把偏好改写一次，用户永远稳不下来。 */
    @Test
    fun `列表里的每一项喂回去都是它自己`() {
        for ((tag, label) in LocaleHelper.languages) {
            assertEquals("$tag（$label）归一后变了", tag, LocaleHelper.normalizeToKnown(tag))
        }
    }
}
