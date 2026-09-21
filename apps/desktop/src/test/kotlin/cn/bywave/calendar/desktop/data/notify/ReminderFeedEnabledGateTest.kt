package cn.bywave.calendar.desktop.data.notify

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 守「提醒关掉之后就真的不再打服务器」。
 *
 * 这条不会报任何错：循环照跑、请求照发、界面上一点迹象都没有。
 * 之前 run() 从头到尾不看开关，用户关掉「事件提醒」之后仍然每 2 分钟拉一次，
 * 笔记本挂一天 720 次；而 macOS 上点 X 只是隐藏窗口、进程还在，
 * 所以「关掉了自然就不跑了」并不成立。
 *
 * 注意 kotlin.test 的 message 是**最后**一个参数，不是第一个。
 */
class ReminderFeedEnabledGateTest {

    /** 远到一定会触发抓取的时刻（nextAttemptAtMs 初值是 0）。 */
    private val dueNow = Long.MAX_VALUE / 2

    @Test
    fun `关着就不抓`() {
        assertEquals(
            ReminderFeed.Step.IDLE,
            ReminderFeed.stepFor(enabled = false, wasEnabled = false, nowMs = dueNow),
            "开关关着、上一跳也是关着时，不许再打服务器",
        )
    }

    @Test
    fun `刚被关掉要把手上那份丢掉`() {
        assertEquals(
            ReminderFeed.Step.STOP_AND_CLEAR,
            ReminderFeed.stepFor(enabled = false, wasEnabled = true, nowMs = dueNow),
            "从开切到关的那一跳要停手并清空 —— 不清的话调度器会拿着旧列表继续弹",
        )
    }

    @Test
    fun `刚打开要立刻抓一次`() {
        assertEquals(
            ReminderFeed.Step.FETCH,
            ReminderFeed.stepFor(enabled = true, wasEnabled = false, nowMs = 0L),
            "从关切到开时不能等下一个间隔，否则开完两分钟内没有提醒可排",
        )
    }

    @Test
    fun `开着且到点了就抓`() {
        assertEquals(
            ReminderFeed.Step.FETCH,
            ReminderFeed.stepFor(enabled = true, wasEnabled = true, nowMs = dueNow),
        )
    }

    /**
     * 这条守的是「别把节流也一起绕过去」：开着、上一跳也开着、但还没到点，
     * 就该什么都不做。少了它，把 stepFor 写成「开着就 FETCH」也能让上面几条全绿，
     * 而那样等于每 15 秒打一次服务器。
     */
    @Test
    fun `开着但没到点就不抓`() {
        ReminderFeed.reset()
        ReminderFeed.noteFetchedForTest(nowMs = 1_000_000L)
        assertEquals(
            ReminderFeed.Step.IDLE,
            ReminderFeed.stepFor(enabled = true, wasEnabled = true, nowMs = 1_000_000L + 1),
            "开着也要遵守刷新间隔，不能每一跳都打",
        )
        ReminderFeed.reset()
    }
}
