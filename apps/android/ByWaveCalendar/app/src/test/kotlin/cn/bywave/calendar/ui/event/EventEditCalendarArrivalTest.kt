// 门禁六：冷启动头两秒点「+」，日历列表到了以后要能接上。
//
// 出事的形状：bootstrap 里 `calendars.firstOrNull()?.id` 取到空串，而
// canSubmit 要求 calendarId 非空 —— 保存按钮从此一直是灰的。而 bootstrap
// 那个 LaunchedEffect 的 key 里不含 calendars，日历后到也不会重新 bootstrap。
// 离线首启（缓存空 + 同步失败）时这是**永久**状态：用户把一整条事件填完，
// 点保存没反应，也没有任何一句话告诉他为什么。

package cn.bywave.calendar.ui.event

import cn.bywave.calendar.data.model.CalendarMeta
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EventEditCalendarArrivalTest {

    private val work = CalendarMeta(id = "cal-1", name = "工作", color = "#6640E9")
    private val home = CalendarMeta(id = "cal-2", name = "家", color = "#22AA55")

    /** 冷启动的那一刻：列表是空的，事件填得再完整也存不下去。 */
    @Test
    fun `没有日历时保存按钮本来就该是灰的`() {
        val s = EventEditUiState(summary = "牙医", calendars = emptyList(), calendarId = "")
        assertFalse(s.canSubmit)
    }

    @Test
    fun `日历后到就能接上并且能保存了`() {
        val before = EventEditUiState(summary = "牙医", calendars = emptyList(), calendarId = "")
        val after = before.withCalendars(listOf(work, home))
        assertEquals(listOf(work, home), after.calendars)
        assertEquals("cal-1", after.calendarId)
        assertTrue("日历到了之后还是存不下去", after.canSubmit)
    }

    /** 用户填了一半的内容一个字都不许丢。 */
    @Test
    fun `接上日历不会冲掉用户填过的东西`() {
        val before = EventEditUiState(
            summary = "牙医",
            location = "中山路 3 号",
            description = "带片子",
            allDay = true,
        )
        val after = before.withCalendars(listOf(work))
        assertEquals("牙医", after.summary)
        assertEquals("中山路 3 号", after.location)
        assertEquals("带片子", after.description)
        assertTrue(after.allDay)
        assertEquals(before.start, after.start)
        assertEquals(before.end, after.end)
    }

    /** 用户已经自己挑过日历了，就别把他挑的换掉。 */
    @Test
    fun `已经选过的日历不会被改回第一个`() {
        val before = EventEditUiState(summary = "牙医", calendarId = "cal-2")
        val after = before.withCalendars(listOf(work, home))
        assertEquals("cal-2", after.calendarId)
    }

    /**
     * 「日历后到」是 APP 自己做的事，不是用户改的。基准指纹要跟着挪，
     * 否则用户什么都没动、一按返回却被问「放弃修改？」。
     */
    @Test
    fun `用户没动过表单时不会凭空变成有未保存改动`() {
        val fresh = EventEditUiState(summary = "").let { it.copy(pristine = it.fingerprint) }
        assertFalse(fresh.hasUnsavedChanges)
        val after = fresh.withCalendars(listOf(work))
        assertFalse("日历后到被当成了用户的改动", after.hasUnsavedChanges)
    }

    /** 用户动过了，那就还是「动过」，别把他的改动标记成干净的。 */
    @Test
    fun `用户改过之后未保存标记还在`() {
        val fresh = EventEditUiState(summary = "").let { it.copy(pristine = it.fingerprint) }
        val edited = fresh.copy(summary = "牙医")
        assertTrue(edited.hasUnsavedChanges)
        val after = edited.withCalendars(listOf(work))
        assertTrue("用户的改动被抹掉了", after.hasUnsavedChanges)
    }

    /** 同一份列表再来一次不产生新对象，省得白白触发重组。 */
    @Test
    fun `同样的列表不会造出新状态`() {
        val s = EventEditUiState(calendars = listOf(work), calendarId = "cal-1")
        assertTrue(s === s.withCalendars(listOf(work)))
    }
}
