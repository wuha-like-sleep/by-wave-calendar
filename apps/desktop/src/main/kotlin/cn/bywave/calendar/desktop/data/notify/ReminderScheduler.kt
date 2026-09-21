// 桌面端事件提醒。每 30 秒看一眼「即将开始」的事件，到点用系统通知弹一下。
//
// 数据从哪来：ReminderFeed —— 提醒自己的那一份，窗口只跟「现在」有关。
// 这里**不能**再去读 CalendarState.ui.events：那是「当前视图正好要画的那一段」，
// 日视图只有 24 小时、月视图只有当月那 6 周格子，接过来就等于「提醒只对你此刻
// 正在看的那几天生效」。详见 ReminderFeed 文件头。
//
// 为什么是轮询（30 秒一跳）而不是给每个事件挂一个定时器：事件会因为刷新 /
// 切账号 / 增删改不断整份换掉，那样就要不停地取消再重排 N 个定时器。一个协程
// 每跳重读一次当前列表简单得多，而 30 秒的粒度对「人开会」这件事绰绰有余。
//
// 「只响一次」：key = "eventId|startsAt"（startsAt 用来区分同一个 id 下重复
// 事件的不同场次），响过就进 fired。进程重启后这个集合清空，但已经过去的
// 事件落在触发区间之外（now 已经越过 开始时间 + 宽限），不会补响——只有还没
// 到的才可能响，这正是想要的。

package cn.bywave.calendar.desktop.data.notify

import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.i18n.I18n
import cn.bywave.calendar.desktop.util.DebugLog
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import java.time.OffsetDateTime
import kotlin.coroutines.coroutineContext

object ReminderScheduler {
    private const val TICK_MS = 30_000L

    // 开始之后还能补响的宽限。留着是为了「提醒我在开始时」这一档（提前量 0）
    // 不会因为正好卡在两跳之间而整个丢掉；同时又不至于在刚启动时把几小时前
    // 就开始了的会全部补弹一遍。
    private const val POST_START_GRACE_MS = 60_000L

    private val fired = mutableSetOf<String>()

    /** 调度器每一跳读的就是这一份。
     *
     *  run() 和测试断言走的是同一个调用点——谁要是再把提醒接回界面当前视图
     *  那一份，就得先改这里，断言会当场变红。 */
    internal fun currentSource(): List<EventDTO> = ReminderFeed.events.value

    /** 切账号 / 被登出时清掉「响过」的记录。 */
    fun reset() {
        fired.clear()
    }

    /** 跑到调用方的协程被取消为止（MainScreen 的 LaunchedEffect，活整个会话）。 */
    suspend fun run() {
        while (coroutineContext.isActive) {
            runCatching { tick(currentSource()) }
                .onFailure { DebugLog.d("ReminderScheduler") { "tick failed: ${it.message}" } }
            delay(TICK_MS)
        }
    }

    /**
     * 一跳。参数都带默认值，正常运行时读的是真实的开关和真实的通知通道；
     * 测试里可以把「现在」「开关」「通知落点」全部换掉。
     */
    internal fun tick(
        events: List<EventDTO>,
        nowMs: Long = System.currentTimeMillis(),
        enabled: Boolean = ReminderPrefs.enabled.value,
        leadMinutes: Int = ReminderPrefs.leadMinutes.value,
        notify: (title: String, body: String) -> Unit = { t, b -> Notifier.notify(t, b) },
    ) {
        if (!enabled) return
        val leadMs = leadMinutes.toLong() * 60_000L

        for (ev in events) {
            // 全天事件没有「提前多少分钟」这回事，跳过，免得半夜 0 点刷屏。
            // （「当天早上汇总一条」是另一件事，还没做。）
            if (ev.allDay) continue
            val startMs = parseStartMs(ev.startsAt) ?: continue
            val reminderAt = startMs - leadMs
            val key = "${ev.id}|${ev.startsAt}"
            if (key in fired) continue
            // 落在 [提醒时刻, 开始时间 + 宽限) 里就响。
            if (nowMs in reminderAt until (startMs + POST_START_GRACE_MS)) {
                fired.add(key)
                notify(
                    ev.summary.ifBlank { I18n.t("reminder.untitled") },
                    I18n.t("reminder.body", mapOf("time" to formatLocalTime(startMs))),
                )
            }
        }

        // 给「响过」的集合封顶，别让长时间不关的窗口一直涨：涨到一定数量就把
        // 早已过去、再也不可能响的那些键丢掉。
        if (fired.size > 500) {
            fired.removeAll { k ->
                val sa = k.substringAfter("|", "")
                val sm = parseStartMs(sa)
                sm != null && sm < nowMs - POST_START_GRACE_MS
            }
        }
    }

    private fun parseStartMs(iso: String): Long? =
        runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()

    private fun formatLocalTime(epochMs: Long): String =
        runCatching {
            val odt = java.time.Instant.ofEpochMilli(epochMs)
                .atZone(java.time.ZoneId.systemDefault())
            java.time.format.DateTimeFormatter.ofPattern("HH:mm").format(odt)
        }.getOrDefault("")

    // ---- 仅供测试 ----

    internal fun firedCountForTest(): Int = fired.size
}
