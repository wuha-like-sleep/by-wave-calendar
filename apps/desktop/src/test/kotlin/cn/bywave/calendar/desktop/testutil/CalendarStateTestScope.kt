package cn.bywave.calendar.desktop.testutil

import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.ui.calendar.CalendarState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import java.time.ZoneId
import java.util.UUID
import kotlin.coroutines.CoroutineContext
import kotlin.test.assertEquals

/** A screen owns one long-lived queue observer. Await finite screen actions,
 * then cancel the screen itself; do not wait forever for its StateFlow. */
class CalendarStateTestScope(parent: CoroutineScope) : CoroutineScope {
    private val job = SupervisorJob(parent.coroutineContext[Job])
    override val coroutineContext: CoroutineContext = parent.coroutineContext + job
    private val observers = mutableSetOf<Job>()
    private val clients = mutableListOf<ApiClient>()

    fun testClient(url: String): ApiClient = ApiClient(url, accountKey = "calendar-test-${UUID.randomUUID()}")
        .also { clients += it }

    fun createState(client: ApiClient, zone: ZoneId = ZoneId.systemDefault()): CalendarState {
        val before = job.children.toSet()
        return CalendarState(client, this, zone).also {
            val started = job.children.toSet() - before
            assertEquals(1, started.size, "Only the screen's persistent queue observer starts at initialization")
            observers += started
        }
    }

    suspend fun awaitIdle() = withTimeout(15_000) {
        while (true) {
            yield() // deliver pending queue state before asserting the UI
            val actions = job.children.filter { it !in observers }.toList()
            if (actions.isEmpty()) return@withTimeout
            actions.forEach { it.join() }
        }
    }

    suspend fun close() {
        job.cancelAndJoin()
        clients.forEach { it.close() }
    }
}

fun calendarStateTest(block: suspend CalendarStateTestScope.() -> Unit): Unit = runBlocking {
    val screen = CalendarStateTestScope(this)
    try { screen.block() } finally { screen.close() }
}
