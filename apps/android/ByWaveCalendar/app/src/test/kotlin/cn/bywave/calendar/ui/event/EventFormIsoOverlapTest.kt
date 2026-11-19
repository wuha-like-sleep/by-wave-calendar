// 保存时墙上时间 → 瞬间的偏移口径，专盯 DST 回拨重叠区。
//
// 重叠区里同一墙上时间有两个合法偏移（纽约 2026-11-01 的 01:00–02:00
// 先以 -04:00 走一遍、再以 -05:00 走一遍）。桌面端 draftInstant 的口径
// 是「偏移取原事件的偏移」：原事件在第二遍那一小时里，把时间改到重叠
// 区内的另一个分钟，仍留在第二遍。Android 保存走共享 eventFormIso，
// 以前直接 atZone(zone) —— java.time 对重叠区恒取较早偏移，于是在
// 第二遍里的事件改个分钟就被悄悄挪前一小时，与桌面端选出的瞬间差
// 一小时。这里把对齐后的口径钉死：两端共用 eventFormIso 的这条规则。
//
// 本机无 Android 工具链，这些用例是纯 JVM 单元测试，随 Android 测试
// 源集在有工具链的环境运行；逻辑只依赖 java.time 语义。

package cn.bywave.calendar.ui.event

import cn.bywave.calendar.event.EventFormInstant
import cn.bywave.calendar.event.eventFormIso
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class EventFormIsoOverlapTest {

    private val newYork = ZoneId.of("America/New_York")
    private val melbourne = ZoneId.of("Australia/Melbourne")

    private fun ldt(y: Int, mo: Int, d: Int, h: Int, mi: Int) = LocalDateTime.of(y, mo, d, h, mi)

    @Test
    fun `原事件在重叠区第二遍时改到区内另一分钟仍取第二遍偏移`() {
        // 2026-11-01 纽约回拨：01:30 第二遍是 -05:00（EST）。
        val original = EventFormInstant("2026-11-01T01:30:00-05:00", ldt(2026, 11, 1, 1, 30))
        assertEquals(
            "2026-11-01T01:15:00-05:00",
            eventFormIso(ldt(2026, 11, 1, 1, 15), false, true, newYork, original),
        )
    }

    @Test
    fun `原事件在重叠区第一遍时改到区内另一分钟仍取第一遍偏移`() {
        val original = EventFormInstant("2026-11-01T01:30:00-04:00", ldt(2026, 11, 1, 1, 30))
        assertEquals(
            "2026-11-01T01:45:00-04:00",
            eventFormIso(ldt(2026, 11, 1, 1, 45), false, true, newYork, original),
        )
    }

    @Test
    fun `墙上时间没动时原样返回存量 iso`() {
        val original = EventFormInstant("2026-11-01T06:30:00Z", ldt(2026, 11, 1, 1, 30))
        assertEquals(
            "2026-11-01T06:30:00Z",
            eventFormIso(ldt(2026, 11, 1, 1, 30), false, true, newYork, original),
        )
    }

    @Test
    fun `新建没有原事件时重叠区取较早偏移与桌面端新建口径一致`() {
        assertEquals(
            "2026-11-01T01:30:00-04:00",
            eventFormIso(ldt(2026, 11, 1, 1, 30), false, true, newYork),
        )
    }

    @Test
    fun `改出重叠区后原偏移不合法就不用它`() {
        val original = EventFormInstant("2026-11-01T01:30:00-05:00", ldt(2026, 11, 1, 1, 30))
        // 03:30 只有 -05:00 合法；00:30 只有 -04:00 合法（preferred 的
        // -05:00 在那里不成立，ofLocal 忽略它）。
        assertEquals(
            "2026-11-01T03:30:00-05:00",
            eventFormIso(ldt(2026, 11, 1, 3, 30), false, true, newYork, original),
        )
        assertEquals(
            "2026-11-01T00:30:00-04:00",
            eventFormIso(ldt(2026, 11, 1, 0, 30), false, true, newYork, original),
        )
    }

    @Test
    fun `墨尔本回拨重叠区同样按原偏移对齐`() {
        // 2026-04-05 墨尔本回拨：02:00–03:00 先 +11:00 再 +10:00。
        val second = EventFormInstant("2026-04-05T02:30:00+10:00", ldt(2026, 4, 5, 2, 30))
        assertEquals(
            "2026-04-05T02:15:00+10:00",
            eventFormIso(ldt(2026, 4, 5, 2, 15), false, true, melbourne, second),
        )
        val first = EventFormInstant("2026-04-05T02:30:00+11:00", ldt(2026, 4, 5, 2, 30))
        assertEquals(
            "2026-04-05T02:45:00+11:00",
            eventFormIso(ldt(2026, 4, 5, 2, 45), false, true, melbourne, first),
        )
    }

    @Test
    fun `春季前拨缺口里的墙上时间仍按 java time 惯例顺延`() {
        // 2026-03-08 纽约前拨：02:30 不存在 → 顺延到 03:30 -04:00，
        // 与改动前 atZone 的行为一致，这条路没有变。
        assertEquals(
            "2026-03-08T03:30:00-04:00",
            eventFormIso(ldt(2026, 3, 8, 2, 30), false, true, newYork),
        )
    }
}
