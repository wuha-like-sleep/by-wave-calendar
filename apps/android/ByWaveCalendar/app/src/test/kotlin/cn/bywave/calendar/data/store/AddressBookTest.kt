// 本地地址簿纯逻辑（data/store/AddressBook.kt）：与网页端
// bwcAddressBook / 桌面端同口径——归一化、记使用、播种只加不覆盖、
// 匹配排序。
package cn.bywave.calendar.data.store

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AddressBookTest {

    @Test
    fun normalizeCollapsesWhitespace() {
        assertEquals("7 Kitchen Rd", AddressBook.normalize("  7  Kitchen   Rd "))
        assertEquals("", AddressBook.normalize(null))
        assertEquals("", AddressBook.normalize("   "))
    }

    @Test
    fun upsertAddsNewAndCountsExisting() {
        val one = AddressBook.upsert(emptyList(), "A St", 100)
        assertEquals(listOf(AddressEntry("A St", 1, 100)), one)
        val two = AddressBook.upsert(listOf(AddressEntry("a  st", 2, 50)), "A St", 200)
        assertEquals(listOf(AddressEntry("A St", 3, 200)), two)
        assertEquals(emptyList(), AddressBook.upsert(emptyList(), "  ", 1))
    }

    @Test
    fun seedOnlyAddsAndCountsOccurrences() {
        val before = listOf(AddressEntry("Home", 7, 999))
        val out = AddressBook.seed(before, listOf("home", "Office", "Office"))
        assertTrue(out.contains(AddressEntry("Home", 7, 999)))
        assertTrue(out.contains(AddressEntry("Office", 2, 0)))
        assertEquals(
            listOf(AddressEntry("X", 2, 0)),
            AddressBook.seed(emptyList(), listOf("X", "x")),
        )
    }

    @Test
    fun matchRanksHeadThenCountThenRecency() {
        val entries = listOf(
            AddressEntry("Melbourne Central", 1, 10),
            AddressEntry("Central Station, Sydney", 9, 20),
            AddressEntry("Melbourne Zoo", 3, 30),
        )
        assertEquals(
            listOf("Central Station, Sydney", "Melbourne Central"),
            AddressBook.match(entries, "central"),
        )
        assertEquals(
            listOf("Melbourne Zoo", "Melbourne Central"),
            AddressBook.match(entries, "melbourne"),
        )
        assertEquals(
            listOf("Central Station, Sydney", "Melbourne Zoo"),
            AddressBook.match(entries, "", limit = 2),
        )
        assertEquals(emptyList(), AddressBook.match(entries, "perth"))
    }
}
