package cn.bywave.calendar.desktop.ui.calendar

import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.testutil.FakeServer
import cn.bywave.calendar.desktop.testutil.FakeServer.Companion.ok
import cn.bywave.calendar.desktop.testutil.FakeServer.Reply
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.net.URLDecoder
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CalendarTimeZoneRefreshTest {
    private val melbourne = ZoneId.of("Australia/Melbourne")
    private val shanghai = ZoneId.of("Asia/Shanghai")
    private val day = LocalDate.of(2026, 11, 16)
    private val now = Instant.parse("2026-11-16T01:00:00Z")
    private val event = EventDTO(id = "zone-event", calendarId = "calendar", summary = "Appointment",
        startsAt = "2026-11-16T01:00:00Z", endsAt = "2026-11-16T02:00:00Z")

    private fun response(events: List<EventDTO>) = Reply(200, ok("""{"calendars":[],"events":${Json.encodeToString(ListSerializer(EventDTO.serializer()), events)}}"""))
    private suspend fun CoroutineScope.awaitIdle() {
        while (true) {
            val jobs = coroutineContext[Job]!!.children.toList()
            if (jobs.isEmpty()) return
            jobs.forEach { it.join() }
        }
    }
    private fun query(hit: FakeServer.Hit): String = URLDecoder.decode(hit.query.orEmpty(), "UTF-8")

    @Test fun `zone change refetches the correct local day and preserves the editor and event instant`(): Unit = runBlocking {
        FakeServer().use { server ->
            server.handler = { response(listOf(event)) }
            val client = ApiClient(server.url)
            try {
                val state = CalendarState(client, this, melbourne)
                state.jumpToDay(day); awaitIdle()
                assertTrue(query(server.hits.last()).contains("from=2026-11-15T13:00:00Z"))
                state.openEdit(event)
                val editor = state.ui.value.activeSheet
                state.followDisplayTimeZone(shanghai, now); awaitIdle()
                assertTrue(query(server.hits.last()).contains("from=2026-11-15T16:00:00Z"))
                assertTrue(query(server.hits.last()).contains("to=2026-11-16T16:00:00Z"))
                assertEquals(editor, state.ui.value.activeSheet)
                assertEquals(listOf(event), state.ui.value.events)
                val requests = server.hits.size
                state.followDisplayTimeZone(shanghai, now); awaitIdle()
                assertEquals(requests, server.hits.size, "An unchanged zone must not repeatedly refetch")
            } finally { client.close() }
        }
    }

    @Test fun `zone change during deletion waits for the acknowledged mutation`(): Unit = runBlocking {
        FakeServer().use { server ->
            val deleting = CountDownLatch(1)
            val finish = CountDownLatch(1)
            server.handler = { hit ->
                if (hit.method == "DELETE") {
                    deleting.countDown()
                    check(finish.await(10, TimeUnit.SECONDS))
                    Reply(204)
                } else response(emptyList())
            }
            val client = ApiClient(server.url)
            try {
                val state = CalendarState(client, this, melbourne)
                state.jumpToDay(day); awaitIdle()
                state.delete(event)
                assertTrue(withContext(Dispatchers.IO) { deleting.await(10, TimeUnit.SECONDS) })
                assertTrue(state.ui.value.saving)
                val before = server.hits.size
                state.followDisplayTimeZone(shanghai, now)
                assertEquals(before, server.hits.size)
                finish.countDown(); awaitIdle()
                assertFalse(state.ui.value.saving)
                assertEquals(emptyList(), state.ui.value.events)
                assertTrue(query(server.hits.last()).contains("from=2026-11-15T16:00:00Z"))
            } finally { finish.countDown(); client.close() }
        }
    }

    @Test fun `today follows a date-line crossing while a browsed day stays selected`() {
        val at = Instant.parse("2026-11-16T01:00:00Z")
        val la = ZoneId.of("America/Los_Angeles")
        assertEquals(LocalDate.of(2026, 11, 15), anchorAfterTimeZoneChange(day, melbourne, la, at))
        val browsed = LocalDate.of(2026, 12, 25)
        assertEquals(browsed, anchorAfterTimeZoneChange(browsed, melbourne, la, at))
    }

    @Test fun `open detail is not mistaken for deletion when the event moves out of the queried day`(): Unit = runBlocking {
        FakeServer().use { server ->
            val early = event.copy(startsAt = "2026-11-15T14:00:00Z", endsAt = "2026-11-15T15:00:00Z")
            server.handler = { hit -> response(if (query(hit).contains("from=2026-11-15T13:00:00Z")) listOf(early) else emptyList()) }
            val client = ApiClient(server.url)
            try {
                val state = CalendarState(client, this, melbourne)
                state.jumpToDay(day); awaitIdle()
                state.openDetail(early)
                state.followDisplayTimeZone(shanghai, now); awaitIdle()
                assertEquals(emptyList(), state.ui.value.events)
                assertEquals(ActiveSheet.Detail(early), state.ui.value.activeSheet)
                state.refreshIfIdle(); awaitIdle()
                assertEquals(ActiveSheet.Detail(early), state.ui.value.activeSheet)
            } finally { client.close() }
        }
    }

    @Test fun `local day query keeps DST short and long days after a zone change`() {
        val ny = ZoneId.of("America/New_York")
        for ((date, hours) in listOf(LocalDate.of(2026, 3, 8) to 23L, LocalDate.of(2026, 11, 1) to 25L)) {
            val (start, end) = CalendarState.windowFor(ViewMode.Day, date, ny)
            assertEquals(hours, java.time.Duration.between(start, end).toHours())
        }
    }
}
