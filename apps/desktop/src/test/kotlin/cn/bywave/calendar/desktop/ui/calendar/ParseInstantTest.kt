// 时间串解析的容错。
//
// 这条测试守的不是「解析对不对」，而是「解析不出来的后果有多大」：
// parseInstant 的调用方全是 `?: return` / `continue` / `mapNotNull`，
// 返回 null 的表现不是报错，是那条事件在月视图、日程、周视图里**凭空消失**，
// 界面上一句提示都没有。

package cn.bywave.calendar.desktop.ui.calendar

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull

class ParseInstantTest {

    /** 服务端现在发的就是这一种（JS Date → JSON，永远带 Z）。 */
    @Test
    fun `带 Z 的 UTC 写法`() {
        assertEquals(
            Instant.parse("2026-09-21T10:00:00Z"),
            parseInstant("2026-09-21T10:00:00.000Z"),
        )
    }

    /** 带时区偏移的写法——桌面端自己 PATCH 出去的就是这种格式。
     *  （JDK 21 的 Instant.parse 本来就收，这条钉的是行为不许退回去。） */
    @Test
    fun `带偏移量的写法也要认`() {
        assertEquals(
            Instant.parse("2026-09-21T10:00:00Z"),
            parseInstant("2026-09-21T18:00:00+08:00"),
            "带 +08:00 的时间解析不出来：这条事件会从月视图/日程/周视图里直接消失，还不报错",
        )
    }

    /** 完全不带时区的写法，按本机时区兜住，总好过整条事件不见。 */
    @Test
    fun `不带时区的写法按本机时区兜住`() {
        assertNotNull(
            parseInstant("2026-09-21T18:00:00"),
            "不带时区的时间解析不出来：这条事件会从界面上消失",
        )
    }

    /** 真的是垃圾就返回 null，别硬编一个时间出来。 */
    @Test
    fun `真解析不了时返回 null`() {
        assertNull(parseInstant("not a date"))
        assertNull(parseInstant(""))
        assertNull(parseInstant(null))
    }
}
