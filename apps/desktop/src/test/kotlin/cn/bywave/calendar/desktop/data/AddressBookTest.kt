// 本地地址簿 v2 纯逻辑（data/AddressBook.kt）：与网页端 bwcAddressBook
// 同口径——规范化（缩写归一）、记使用（来源/关键词）、播种、编辑
// 学习、带打分的匹配（词元任意序 / 模糊 / 拼音首字母 / 上下文）。
package cn.bywave.calendar.desktop.data

import cn.bywave.calendar.desktop.data.model.GeoSuggestion
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AddressBookTest {

    private fun mk(address: String, useCount: Int = 1, lastUsedAt: Long = 0, keywords: Map<String, Int> = emptyMap()) =
        AddressEntry(
            address = address,
            normalized = AddressBook.canonicalize(address),
            useCount = useCount,
            lastUsedAt = lastUsedAt,
            firstSeenAt = lastUsedAt,
            source = "typed",
            keywords = keywords,
        )

    @Test
    fun canonicalizeMergesVariants() {
        assertEquals(AddressBook.canonicalize("7 Kitchen Rd"), AddressBook.canonicalize("7 Kitchen Road"))
        assertEquals("melbourne central", AddressBook.canonicalize("  MELBOURNE  Central, "))
        assertEquals(AddressBook.canonicalize("1 Smith St."), AddressBook.canonicalize("1 Smith Street"))
    }

    @Test
    fun pinyinAndDistance() {
        assertEquals("bjz", AddressBook.pinyinInitials("北京站"))
        assertEquals(1, AddressBook.editDistance("melbourne", "melborne", 2))
        assertTrue(AddressBook.editDistance("abc", "xyz", 1) > 1)
    }

    @Test
    fun upsertCountsAndLearnsKeywords() {
        var entries = AddressBook.upsert(emptyList(), "7 Kitchen Rd", 1000, "typed", "BBQ night")
        assertEquals(1, entries.size)
        assertEquals(1, entries[0].keywords["bbq"])
        entries = AddressBook.upsert(entries, "7 Kitchen Road", 2000)
        assertEquals(1, entries.size)
        assertEquals(2, entries[0].useCount)
        assertEquals("7 Kitchen Road", entries[0].address)
    }

    @Test
    fun upsertOnlineKeepsComponents() {
        val geo = GeoSuggestion(label = "Melbourne Central", street = "La Trobe Street", city = "Melbourne", lat = -37.8, lon = 144.9)
        val entries = AddressBook.upsert(emptyList(), "Melbourne Central", 1000, "online", null, geo)
        assertEquals("online", entries[0].source)
        assertEquals("La Trobe Street", entries[0].street)
        assertEquals(-37.8, entries[0].lat)
    }

    @Test
    fun seedOnlyAdds() {
        val before = listOf(mk("Home", 7, 999))
        val out = AddressBook.seed(before, listOf("home", "Office", "Office"), 5000)
        assertEquals(7, out.first { it.address == "Home" }.useCount)
        assertEquals(2, out.first { it.address == "Office" }.useCount)
        assertEquals("seed", out.first { it.address == "Office" }.source)
    }

    @Test
    fun learnFromSaveEditsInPlace() {
        val before = listOf(mk("Melbourne Central", 3, 500))
        val out = AddressBook.learnFromSave(before, "Melbourne Central", "Melbourne Central, La Trobe Street", 9000)
        assertEquals(1, out.size)
        assertEquals("Melbourne Central, La Trobe Street", out[0].address)
        assertEquals(4, out[0].useCount)
        assertEquals(500, out[0].firstSeenAt)
        val split = AddressBook.learnFromSave(before, "Melbourne Central", "Sydney Opera House", 9000)
        assertEquals(2, split.size)
    }

    @Test
    fun matchTokenFuzzyPinyinContext() {
        val now = 1_800_000_000_000L
        val entries = listOf(
            mk("Melbourne Central", 1, 10),
            mk("Central Station, Sydney", 9, 20),
            mk("Melbourne Zoo", 3, 30),
            mk("北京站", 2, 40),
        )
        assertTrue(AddressBook.match(entries, "central melbourne", now = now).contains("Melbourne Central"))
        assertTrue(AddressBook.match(entries, "melborne central", now = now).contains("Melbourne Central"))
        assertEquals(listOf("北京站"), AddressBook.match(entries, "bjz", now = now))
        assertTrue(AddressBook.match(entries, "perth airport", now = now).isEmpty())

        val pair = listOf(
            mk("Office Park", 2, 10, mapOf("dentist" to 4)),
            mk("Office Park North", 2, 10),
        )
        assertEquals("Office Park", AddressBook.match(pair, "office park", title = "Dentist appointment", now = now).first())
    }
}
