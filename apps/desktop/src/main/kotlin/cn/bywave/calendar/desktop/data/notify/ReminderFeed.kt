// 提醒专用的事件数据源。
//
// 为什么要单独有这么一份 —— 它修的是一个「开关写着开、大部分时候不响」的 bug：
//
//   ReminderScheduler 以前直接读日历界面那一份（tick(uiFlow.value.events)），
//   而 CalendarState 拉的是「当前视图正好要画的那一段」：
//     · 日视图  = 当天 0 点到 24 点
//     · 周视图  = 本周 7 天
//     · 月视图  = 当月那 6 周格子
//   于是：切到「日」视图，今天之后的会全部不提醒；翻到下个月看完排期就去干
//   别的，连今天的会也不会响——因为界面上那一份里根本没有今天。不响的时候
//   界面上没有任何迹象，而设置里那句文案承诺的是「事件开始前弹出通知」。
//
// 所以提醒自己拉一份，窗口只跟「现在」有关，跟用户在看哪一天无关。
//
// 几个参数是怎么定的：
//
//   HORIZON_DAYS = 3
//     提醒真正需要的只是「即将开始」的事件。提前量上限：界面上能选到 60 分钟，
//     存盘格式允许 0..1440（24 小时）。3 天 = 24 小时提前量 + 48 小时余量，
//     余量留给断网/休眠：网断了就一直用上一次拉到的这份，3 天内的会照常响。
//     再往长拉只是白白增大每次的返回体，提醒用不上。
//
//   LOOKBACK_MS = 1 小时
//     窗口往回留一段，不是从「此刻」开始。因为提醒的触发区间是
//     [开始时间 - 提前量, 开始时间 + 60 秒)：一个刚刚开始的会必须还在列表里，
//     否则「提醒我在开始时」这一档会在跨过整点的那一跳里自己消失。
//
//   REFRESH_INTERVAL_MS = 2 分钟
//     手机上新建一个会，桌面要在它开始之前知道。最短的触发区间是
//     「提醒我在开始时」那一档（60 秒宽），2 分钟仍可能错过——所以本地这台机器
//     上的增删改走 requestRefresh() 立刻重拉，不等这个间隔。间隔只兜别的端。
//
//   POLL_STEP_MS = 15 秒 + 按墙上时间判断是否该拉
//     不用 delay(REFRESH_INTERVAL_MS) 直接睡两分钟，是为了合盖唤醒：
//     笔记本睡 3 小时之后，nextAttemptAtMs 早就过了，醒来第一跳就重拉，
//     不会先拿着三小时前的旧列表再等两分钟。

package cn.bywave.calendar.desktop.data.notify

import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.util.DebugLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.coroutineContext

/** 取一段时间内的事件。抽成函数类型只为一件事：测试里能塞一个假服务端进来，
 *  于是「窗口对不对」可以被断言，而不必真的连网。 */
internal typealias EventFetcher = suspend (fromIso: String, toIso: String) -> List<EventDTO>

object ReminderFeed {

    /** 往后拉多少天。见文件头的理由。 */
    internal const val HORIZON_DAYS = 3L

    /** 窗口往回留多久。见文件头的理由。 */
    internal const val LOOKBACK_MS = 60L * 60 * 1000

    /** 正常情况下两次拉取的间隔。 */
    internal const val REFRESH_INTERVAL_MS = 120_000L

    /** 失败之后的第一次重试间隔，此后翻倍，封顶到 REFRESH_INTERVAL_MS。 */
    internal const val RETRY_BASE_MS = 15_000L

    /** 循环的睡眠粒度。真正决定「拉不拉」的是墙上时间，不是这个值。 */
    internal const val POLL_STEP_MS = 15_000L

    private val ISO: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT

    private val _events = MutableStateFlow<List<EventDTO>>(emptyList())

    /** 调度器读的就是这一份。取数失败时保留上一次成功的内容——提醒宁可用
     *  几分钟前的数据响，也不要因为一次网络抖动整段哑掉。 */
    val events: StateFlow<List<EventDTO>> = _events.asStateFlow()

    /** 墙上时间。到点才拉。0 表示「立刻拉」。 */
    private var nextAttemptAtMs: Long = 0L

    /** 连续失败次数，用来算退避。成功一次归零。 */
    private var consecutiveFailures: Int = 0

    /** 本机刚刚增删改过事件，别等下一个间隔。 */
    private val refreshRequested = AtomicBoolean(false)

    /** 提醒要看的那一段：[现在 - LOOKBACK, 今天起 HORIZON 天的 0 点)。
     *  前闭后开，和服务端同一套约定。
     *
     *  终点对齐到本地日期的 0 点而不是「现在 + 72 小时」，是为了让同一天里
     *  每次拉取的 to 参数都一样——服务端和本地缓存都按 (from, to) 做键，
     *  每分钟换一个 to 等于每次都打穿缓存。 */
    internal fun windowFor(nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): Pair<Instant, Instant> {
        val now = Instant.ofEpochMilli(nowMs)
        val from = now.minusMillis(LOOKBACK_MS)
        val to = now.atZone(zone).toLocalDate().plusDays(HORIZON_DAYS).atStartOfDay(zone).toInstant()
        return from to to
    }

    /** 这一跳该不该去拉。 */
    internal fun shouldFetch(nowMs: Long): Boolean =
        refreshRequested.get() || nowMs >= nextAttemptAtMs

    /** 失败 n 次之后隔多久再试。n=0 表示上一次是成功的。 */
    internal fun nextDelayMs(failures: Int): Long {
        if (failures <= 0) return REFRESH_INTERVAL_MS
        // 15s → 30s → 60s → 120s 封顶。移位次数夹住，别让它溢出。
        val shifted = RETRY_BASE_MS shl (failures - 1).coerceAtMost(8)
        return shifted.coerceAtMost(REFRESH_INTERVAL_MS)
    }

    /** 只给测试用：把状态摆成「刚成功拉过一次」，好验节流那一条。 */
    internal fun noteFetchedForTest(nowMs: Long) {
        consecutiveFailures = 0
        nextAttemptAtMs = nowMs + nextDelayMs(0)
    }

    /** 本机做了增删改，下一跳立刻重拉（不等 REFRESH_INTERVAL_MS）。 */
    fun requestRefresh() {
        refreshRequested.set(true)
    }

    /** 切账号 / 被登出时清空。别让上一个账号的会继续弹通知。 */
    fun reset() {
        _events.value = emptyList()
        nextAttemptAtMs = 0L
        consecutiveFailures = 0
        refreshRequested.set(false)
    }

    /** 这一跳该做什么。 */
    internal enum class Step {
        /** 拉一次。 */
        FETCH,
        /** 什么都不做，睡到下一跳。 */
        IDLE,
        /** 刚被关掉：停手，并且把手上那份丢掉。 */
        STOP_AND_CLEAR,
    }

    /**
     * 抽成纯函数是为了能单独验。「开关关着还在打服务器」这种事**不会报任何错**，
     * 只有靠断言盯得住 —— 之前这个循环从头到尾不看开关，用户把「事件提醒」关掉之后
     * 照样每 2 分钟拉一次，笔记本挂一天就是 720 次白跑的请求；断网时还按退避一直重试。
     * 而 macOS 上点 X 只是隐藏窗口、进程还在，所以「关掉了就不会再跑」并不成立。
     */
    internal fun stepFor(enabled: Boolean, wasEnabled: Boolean, nowMs: Long): Step = when {
        !enabled && wasEnabled -> Step.STOP_AND_CLEAR
        !enabled -> Step.IDLE
        // 刚从关切到开：立刻拉一次，别让用户白等两分钟才有提醒可排。
        !wasEnabled -> Step.FETCH
        shouldFetch(nowMs) -> Step.FETCH
        else -> Step.IDLE
    }

    /** 跑到调用方的协程被取消为止。MainScreen 按 ApiClient 绑定，
     *  切账号时整段重来。 */
    suspend fun run(fetch: EventFetcher) {
        var wasEnabled = ReminderPrefs.enabled.value
        while (coroutineContext.isActive) {
            val now = System.currentTimeMillis()
            when (stepFor(ReminderPrefs.enabled.value, wasEnabled, now)) {
                Step.FETCH -> {
                    refreshRequested.set(false)
                    fetchOnce(fetch, now)
                }
                Step.STOP_AND_CLEAR -> {
                    _events.value = emptyList()
                    nextAttemptAtMs = 0L
                    consecutiveFailures = 0
                    refreshRequested.set(false)
                }
                Step.IDLE -> Unit
            }
            wasEnabled = ReminderPrefs.enabled.value
            delay(POLL_STEP_MS)
        }
    }

    /** 拉一次。成功替换整份；失败保留上一份并按退避安排下一次。 */
    internal suspend fun fetchOnce(fetch: EventFetcher, nowMs: Long) {
        val (from, to) = windowFor(nowMs)
        try {
            val fresh = fetch(ISO.format(from), ISO.format(to))
            _events.value = fresh
            consecutiveFailures = 0
            nextAttemptAtMs = nowMs + nextDelayMs(0)
            DebugLog.d("ReminderFeed") { "fetched ${fresh.size} events for [$from, $to)" }
        } catch (e: CancellationException) {
            // 取消不是失败，原样往上抛，别记进退避里。
            throw e
        } catch (e: Exception) {
            consecutiveFailures += 1
            nextAttemptAtMs = nowMs + nextDelayMs(consecutiveFailures)
            DebugLog.d("ReminderFeed") { "fetch failed (#$consecutiveFailures): ${e.message}" }
        }
    }

    // ---- 仅供测试 ----

    internal fun seedForTest(list: List<EventDTO>) {
        _events.value = list
    }

    internal fun stateForTest(): Triple<Long, Int, Boolean> =
        Triple(nextAttemptAtMs, consecutiveFailures, refreshRequested.get())
}
