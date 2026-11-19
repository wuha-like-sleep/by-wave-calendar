// 事件编辑器的时区口径：事件自己的时区 → 日历时区 → 设备时区。
//
// 以前 Android 编辑器根本没有时区这一项：事件自带的时区只能被原样
// 保留、看不见也改不了，新建事件则一律盖设备时区 —— 在网页上给
// 外地日历建的「每周一 9:30」到了手机上改个标题，时区还是那个时区，
// 但用户全程不知道它存在。这里钉住解析顺序和「跟随日历」的边界：
// 继承来的时区跟着日历走，事件自带的和用户手挑的绝不许被换日历
// 静默改掉。

package cn.bywave.calendar.ui.event

import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventExtraDTO
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EventEditZoneTest {

    private val device = ZoneId.of("Asia/Shanghai")
    private val work = CalendarMeta(id = "cal-1", name = "工作", color = "#6640E9", timezone = "Australia/Melbourne")
    private val home = CalendarMeta(id = "cal-2", name = "家", color = "#22AA55", timezone = "America/New_York")
    private val noZone = CalendarMeta(id = "cal-3", name = "杂", color = "#888888", timezone = null)

    @Test
    fun `解析顺序是事件自带优先于日历优先于设备`() {
        assertEquals("Europe/Paris", resolveEventZoneId("Europe/Paris", "Australia/Melbourne", device))
        assertEquals("Australia/Melbourne", resolveEventZoneId(null, "Australia/Melbourne", device))
        assertEquals("Asia/Shanghai", resolveEventZoneId(null, null, device))
        assertEquals("Asia/Shanghai", resolveEventZoneId("", "  ", device))
    }

    @Test
    fun `存量脏时区串跳过而不是崩掉`() {
        // 别的客户端 / 老版本写进来的时区串不可信。
        assertEquals("Australia/Melbourne", resolveEventZoneId("上海", "Australia/Melbourne", device))
        assertEquals("Asia/Shanghai", resolveEventZoneId("+08:00", "Mars/Olympus", device))
    }

    @Test
    fun `保存时表单选的时区压过存量时区`() {
        val state = EventEditUiState(
            isEdit = true, calendarId = "cal-1", summary = "会",
            zoneId = "Europe/Paris",
            sourceExtra = EventExtraDTO(timezone = "Australia/Melbourne"),
        )
        assertEquals("Europe/Paris", state.buildExtra(device).timezone)
    }

    @Test
    fun `全天事件不接管时区沿用存量`() {
        val state = EventEditUiState(
            isEdit = true, calendarId = "cal-1", summary = "年假", allDay = true,
            zoneId = "Europe/Paris",
            sourceExtra = EventExtraDTO(timezone = "Australia/Melbourne"),
        )
        assertEquals("Australia/Melbourne", state.buildExtra(device).timezone)
    }

    @Test
    fun `zoneId 空着时保持旧口径`() {
        // 手工构造的状态（以及旧测试）没有 zoneId：编辑保留存量、
        // 新建盖设备时区，和加选择器之前一模一样。
        val edit = EventEditUiState(
            isEdit = true, calendarId = "cal-1", summary = "会",
            sourceExtra = EventExtraDTO(timezone = "Australia/Melbourne"),
        )
        assertEquals("Australia/Melbourne", edit.buildExtra(device).timezone)
        val create = EventEditUiState(isEdit = false, calendarId = "cal-1", summary = "会")
        assertEquals("Asia/Shanghai", create.buildExtra(device).timezone)
    }

    @Test
    fun `换日历时继承来的时区跟着走`() {
        val state = EventEditUiState(
            isEdit = false, calendarId = "cal-1", summary = "会",
            calendars = listOf(work, home), zoneId = "Australia/Melbourne",
        )
        val moved = state.withCalendarSelection("cal-2")
        assertEquals("cal-2", moved.calendarId)
        assertEquals("America/New_York", moved.zoneId)
    }

    @Test
    fun `换日历时事件自带的时区不许动`() {
        val state = EventEditUiState(
            isEdit = true, calendarId = "cal-1", summary = "会",
            calendars = listOf(work, home), zoneId = "Europe/Paris",
            sourceExtra = EventExtraDTO(timezone = "Europe/Paris"),
        )
        assertEquals("Europe/Paris", state.withCalendarSelection("cal-2").zoneId)
    }

    @Test
    fun `换日历时用户手挑的时区不许动`() {
        val state = EventEditUiState(
            isEdit = false, calendarId = "cal-1", summary = "会",
            calendars = listOf(work, home), zoneId = "Europe/Paris", zoneTouched = true,
        )
        assertEquals("Europe/Paris", state.withCalendarSelection("cal-2").zoneId)
    }

    @Test
    fun `日历后到时继承时区跟着定下来`() {
        // 冷启动：bootstrap 时列表是空的，时区只能先占位成设备时区。
        val before = EventEditUiState(
            isEdit = false, calendarId = "", summary = "会",
            calendars = emptyList(), zoneId = "Asia/Shanghai",
        )
        val after = before.withCalendars(listOf(work, home))
        assertEquals("cal-1", after.calendarId)
        assertEquals("Australia/Melbourne", after.zoneId)
    }

    @Test
    fun `日历后到时手挑的时区不被覆盖`() {
        val before = EventEditUiState(
            isEdit = false, calendarId = "", summary = "会",
            calendars = emptyList(), zoneId = "Europe/Paris", zoneTouched = true,
        )
        assertEquals("Europe/Paris", before.withCalendars(listOf(work, home)).zoneId)
    }

    @Test
    fun `手挑时区会置位 touched 并进入指纹`() {
        val state = EventEditUiState(isEdit = false, calendarId = "cal-1", summary = "会", zoneId = "Asia/Shanghai")
        val picked = state.withZoneSelection("Europe/Paris")
        assertTrue(picked.zoneTouched)
        assertFalse("改时区必须算未保存改动", picked.fingerprint == state.fingerprint)
    }

    @Test
    fun `目标日历没有时区时回到设备时区`() {
        val state = EventEditUiState(
            isEdit = false, calendarId = "cal-1", summary = "会",
            calendars = listOf(work, noZone), zoneId = "Australia/Melbourne",
        )
        // 设备时区在测试机上不可控，只断言它不再是继承来的那个。
        assertEquals(ZoneId.systemDefault().id, state.withCalendarSelection("cal-3").zoneId)
    }
}
