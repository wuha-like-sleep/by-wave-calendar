// 提醒的数据源：断言「提醒看得见的那一段」不跟着界面视图变窄。
//
// 这批断言对着的是一个具体的线上行为：设置里提醒开关写着「开」，可是
// 切到「日」视图之后，今天之后的会全都不响；翻到下个月去看排期再去干别的，
// 连今天的会也不响。根因是调度器直接读界面那一份事件，而界面那一份的窗口
// 就是「当前视图正好要画的那一段」。
//
// 这里不连网。假服务端按 (from, to) 半开区间过滤，和真服务端同一套约定，
// 所以被验的是**窗口**，不是网络。

package cn.bywave.calendar.desktop.data.notify

import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.ui.calendar.CalendarState
import cn.bywave.calendar.desktop.ui.calendar.ViewMode
import kotlinx.coroutines.test.runTest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private val ZONE: ZoneId = ZoneId.systemDefault()
private val ISO: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT

/** 测试用的「现在」：固定成今天本地时间 09:00，免得测试在午夜前后自己变红。 */
private val NOW: Instant = LocalDate.now(ZONE).atTime(9, 0).atZone(ZONE).toInstant()
private val NOW_MS: Long = NOW.toEpochMilli()

private fun event(
    id: String,
    startsAt: Instant,
    minutes: Long = 60,
    allDay: Boolean = false,
    summary: String = id,
) = EventDTO(
    id = id,
    calendarId = "cal-1",
    summary = summary,
    startsAt = startsAt.atZone(ZONE).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
    endsAt = startsAt.plusSeconds(minutes * 60).atZone(ZONE).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
    allDay = allDay,
)

/** 假服务端：返回和 [from, to) 有重叠的事件。和真服务端一样前闭后开。 */
private fun fakeServer(all: List<EventDTO>): EventFetcher = { fromIso, toIso ->
    val from = Instant.parse(fromIso)
    val to = Instant.parse(toIso)
    all.filter { ev ->
        val s = java.time.OffsetDateTime.parse(ev.startsAt).toInstant()
        val e = java.time.OffsetDateTime.parse(ev.endsAt).toInstant()
        s.isBefore(to) && e.isAfter(from)
    }
}

// 今天 10:00 的会（今天之内）和后天 10:00 的会（日视图窗口之外）。
private val TODAY_MEETING = event("today-10", NOW.plusSeconds(3600))
private val DAY_AFTER_TOMORROW = event("d+2", NOW.plusSeconds(2 * 24 * 3600 + 3600))
private val ALL = listOf(TODAY_MEETING, DAY_AFTER_TOMORROW)

class ReminderSourceTest {

    @BeforeTest
    fun clean() {
        ReminderFeed.reset()
        ReminderScheduler.reset()
    }

    @AfterTest
    fun cleanAfter() {
        ReminderFeed.reset()
        ReminderScheduler.reset()
    }

    /**
     * 这是本轮要求的那一条。
     *
     * 前提（下一条断言单独钉住）：日视图拉的是当天 24 小时，看不到后天的会。
     * 要求：把视图切到「日」之后，调度器仍然能看到今天之后若干天的事件。
     *
     * 断言读的是 ReminderScheduler.currentSource() —— run() 每一跳读的也是它，
     * 是同一个调用点。谁把提醒接回界面那一份，就必须先改 currentSource()，
     * 这条会当场红。
     */
    @Test
    fun `切到日视图后 调度器仍然看得见后天的会`() = runTest {
        // 界面切到「日」。视图自己那一份只覆盖今天。
        val dayWindow = CalendarState.windowFor(ViewMode.Day, LocalDate.now(ZONE), ZONE)
        val whatTheViewSees = fakeServer(ALL)(ISO.format(dayWindow.first), ISO.format(dayWindow.second))
        assertFalse(
            whatTheViewSees.any { it.id == DAY_AFTER_TOMORROW.id },
            "前提不成立了：日视图窗口居然覆盖到了后天。这条测试的意义没了，先去看 CalendarState.windowFor。",
        )

        // 提醒自己拉一份。
        ReminderFeed.fetchOnce(fakeServer(ALL), NOW_MS)

        val seenByScheduler = ReminderScheduler.currentSource()
        assertTrue(
            seenByScheduler.any { it.id == DAY_AFTER_TOMORROW.id },
            "调度器看不到后天的会：提醒又被接回界面当前视图那一份了。实际看到的是 ${seenByScheduler.map { it.id }}",
        )
        assertTrue(
            seenByScheduler.any { it.id == TODAY_MEETING.id },
            "调度器连今天的会都看不到。实际看到的是 ${seenByScheduler.map { it.id }}",
        )
    }

    /** 前提本身也钉住：界面那一份的窗口确实是按视图收窄的。 */
    @Test
    fun `视图窗口按视图收窄 日视图只有当天`() {
        val today = LocalDate.now(ZONE)
        val (dFrom, dTo) = CalendarState.windowFor(ViewMode.Day, today, ZONE)
        assertEquals(
            24 * 3600L,
            java.time.Duration.between(dFrom, dTo).seconds,
            "日视图窗口不是 24 小时",
        )

        val (wFrom, wTo) = CalendarState.windowFor(ViewMode.Week, today, ZONE)
        assertEquals(
            7 * 24 * 3600L,
            java.time.Duration.between(wFrom, wTo).seconds,
            "周视图窗口不是 7 天",
        )
    }

    /** 提醒的窗口：起点要往回留一段，终点要覆盖到今天之后 HORIZON_DAYS 天。 */
    @Test
    fun `提醒窗口 往回留一小时 往后覆盖三天`() {
        val (from, to) = ReminderFeed.windowFor(NOW_MS, ZONE)
        // 这里故意**不**拿 ReminderFeed.LOOKBACK_MS 当期望值。
        // 第一版就是那么写的：`assertEquals(LOOKBACK_MS, now - from)`，把常数
        // 改成 0 它照样绿——两边同时变，等于什么都没断言。写死一个下限才有意义。
        val lookedBackMs = NOW_MS - from.toEpochMilli()
        assertTrue(
            lookedBackMs >= 10 * 60_000L,
            "提醒窗口的起点只往回留了 ${lookedBackMs}ms：一个刚开始的会会在跨跳时从列表里消失，" +
                "「提醒我在开始时」那一档就永远差一口气",
        )
        assertTrue(
            lookedBackMs <= 6 * 3600_000L,
            "提醒窗口往回留了 ${lookedBackMs}ms，太长了：每次返回体里塞一堆早就开完的会",
        )
        val expectedTo = LocalDate.now(ZONE).plusDays(ReminderFeed.HORIZON_DAYS).atStartOfDay(ZONE).toInstant()
        assertEquals(expectedTo, to, "提醒窗口的终点不对")
        assertTrue(
            to.toEpochMilli() - NOW_MS >= 24L * 3600 * 1000,
            "提醒窗口不足 24 小时：提前量上限（1440 分钟）就永远够不着了",
        )
    }

    /** 同一天里反复拉取，to 参数必须稳定——否则每次都打穿服务端/本地缓存。 */
    @Test
    fun `同一天内多次拉取 终点参数不变`() {
        val a = ReminderFeed.windowFor(NOW_MS, ZONE).second
        val b = ReminderFeed.windowFor(NOW_MS + 61_000, ZONE).second
        assertEquals(a, b, "同一天里两次拉取的 to 不一样，缓存键每分钟都在变")
    }

    /** 取数失败要保留上一份。提醒宁可用旧数据响，也不要因为一次网络抖动整段哑掉。 */
    @Test
    fun `取数失败时保留上一次成功的列表`() = runTest {
        ReminderFeed.fetchOnce(fakeServer(ALL), NOW_MS)
        assertEquals(2, ReminderFeed.events.value.size)

        val boom: EventFetcher = { _, _ -> throw java.io.IOException("connection reset") }
        ReminderFeed.fetchOnce(boom, NOW_MS + 1000)

        assertEquals(
            2,
            ReminderFeed.events.value.size,
            "一次取数失败就把提醒列表清空了：接下来这段时间一个会都不会响",
        )
    }

    /** 失败之后要退避，不要每 15 秒对着一台连不上的服务器猛打。 */
    @Test
    fun `失败后按退避安排下一次 成功后回到正常间隔`() {
        assertEquals(
            ReminderFeed.REFRESH_INTERVAL_MS,
            ReminderFeed.nextDelayMs(0),
            "成功之后的间隔不是 REFRESH_INTERVAL_MS",
        )
        assertTrue(
            ReminderFeed.nextDelayMs(1) >= ReminderFeed.RETRY_BASE_MS,
            "第一次失败之后立刻重试了（间隔 ${ReminderFeed.nextDelayMs(1)}ms）",
        )
        assertTrue(
            ReminderFeed.nextDelayMs(2) > ReminderFeed.nextDelayMs(1),
            "连续失败没有退避：第 2 次和第 1 次的间隔一样",
        )
        assertTrue(
            ReminderFeed.nextDelayMs(20) <= ReminderFeed.REFRESH_INTERVAL_MS,
            "退避没有封顶：失败久了之后要等 ${ReminderFeed.nextDelayMs(20)}ms 才重试",
        )
    }

    /** 本机刚增删改过，下一跳要立刻重拉，不等间隔。 */
    @Test
    fun `requestRefresh 之后立刻该拉`() = runTest {
        ReminderFeed.fetchOnce(fakeServer(ALL), NOW_MS)
        assertFalse(
            ReminderFeed.shouldFetch(NOW_MS + 1000),
            "刚拉完一秒就又要拉：间隔没生效",
        )
        ReminderFeed.requestRefresh()
        assertTrue(
            ReminderFeed.shouldFetch(NOW_MS + 1000),
            "本机刚建完会，下一跳却还在等间隔：新建一个十分钟后的会可能不响",
        )
    }

    /** 合盖三小时再打开：醒来第一跳就该重拉，不是先用三小时前的旧列表。 */
    @Test
    fun `休眠很久之后醒来该立刻重拉`() = runTest {
        ReminderFeed.fetchOnce(fakeServer(ALL), NOW_MS)
        assertTrue(
            ReminderFeed.shouldFetch(NOW_MS + 3 * 3600 * 1000),
            "睡了三小时醒来还不拉：拿着三小时前的列表在提醒",
        )
    }

    /** 切账号要清干净，别用上一个账号的事件继续弹通知。 */
    @Test
    fun `reset 之后列表清空且立刻该拉`() = runTest {
        ReminderFeed.fetchOnce(fakeServer(ALL), NOW_MS)
        assertEquals(2, ReminderFeed.events.value.size)
        ReminderFeed.reset()
        assertEquals(0, ReminderFeed.events.value.size, "切账号后上一个账号的事件还留着")
        assertTrue(ReminderFeed.shouldFetch(NOW_MS), "切账号后不会立刻去拉新账号的事件")
    }
}

class ReminderTickTest {

    @BeforeTest
    fun clean() {
        ReminderFeed.reset()
        ReminderScheduler.reset()
    }

    @AfterTest
    fun cleanAfter() {
        ReminderFeed.reset()
        ReminderScheduler.reset()
    }

    private fun collect(
        events: List<EventDTO>,
        nowMs: Long,
        enabled: Boolean = true,
        lead: Int = 10,
    ): MutableList<Pair<String, String>> {
        val got = mutableListOf<Pair<String, String>>()
        ReminderScheduler.tick(
            events = events,
            nowMs = nowMs,
            enabled = enabled,
            leadMinutes = lead,
            notify = { t, b -> got.add(t to b) },
        )
        return got
    }

    /** 提前 10 分钟：到点要响。 */
    @Test
    fun `进入提前量窗口时弹通知`() {
        val start = NOW.plusSeconds(9 * 60)   // 9 分钟后开始 → 已进入 10 分钟窗口
        val got = collect(listOf(event("e1", start, summary = "站会")), NOW_MS)
        assertEquals(1, got.size, "该响没响")
        assertEquals("站会", got[0].first)
    }

    /** 还没进窗口就不能响。 */
    @Test
    fun `还没到提前量时不弹`() {
        val start = NOW.plusSeconds(40 * 60)  // 40 分钟后
        assertEquals(0, collect(listOf(event("e1", start)), NOW_MS).size, "提前太多就响了")
    }

    /** 早就开始完的会不能补响 —— 否则刚启动时会一次性弹一堆。 */
    @Test
    fun `早就过去的会不补响`() {
        val start = NOW.minusSeconds(3 * 3600)
        assertEquals(0, collect(listOf(event("e1", start)), NOW_MS).size, "几小时前的会被补响了")
    }

    /** 开关关掉就一条都不许响。 */
    @Test
    fun `关掉提醒开关后一条都不响`() {
        val start = NOW.plusSeconds(9 * 60)
        assertEquals(
            0,
            collect(listOf(event("e1", start)), NOW_MS, enabled = false).size,
            "提醒开关关着还在响",
        )
    }

    /** 同一场会只响一次，哪怕列表每 30 秒重读一遍。 */
    @Test
    fun `同一场会只响一次`() {
        val start = NOW.plusSeconds(9 * 60)
        val ev = listOf(event("e1", start))
        assertEquals(1, collect(ev, NOW_MS).size)
        assertEquals(0, collect(ev, NOW_MS + 30_000).size, "同一场会响了第二次")
        assertEquals(0, collect(ev, NOW_MS + 60_000).size, "同一场会响了第三次")
    }

    /** 全天事件不参与「提前多少分钟」这条路（否则半夜 0 点刷屏）。 */
    @Test
    fun `全天事件不走提前量提醒`() {
        val start = NOW.plusSeconds(9 * 60)
        assertEquals(
            0,
            collect(listOf(event("e1", start, allDay = true)), NOW_MS).size,
            "全天事件也按提前量弹了",
        )
    }

    /** 提前量选「事件开始时」（0 分钟）：开始那一刻和随后一小段都要能响。 */
    @Test
    fun `提前量为零时在开始那一刻响`() {
        val start = NOW
        assertEquals(1, collect(listOf(event("e1", start)), NOW_MS, lead = 0).size, "选了「开始时」却没响")
    }

    /** 调度器读的就是 ReminderFeed 那一份。 */
    @Test
    fun `调度器的数据源就是 ReminderFeed`() {
        ReminderFeed.seedForTest(listOf(TODAY_MEETING, DAY_AFTER_TOMORROW))
        assertEquals(
            listOf(TODAY_MEETING.id, DAY_AFTER_TOMORROW.id),
            ReminderScheduler.currentSource().map { it.id },
            "调度器读的不是 ReminderFeed",
        )
    }
}
