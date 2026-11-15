package cn.bywave.calendar.desktop.ui.calendar

import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.testutil.FakeServer
import cn.bywave.calendar.desktop.testutil.FakeServer.Companion.ok
import cn.bywave.calendar.desktop.testutil.FakeServer.Reply
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class CalendarRefreshTest {
    private val event = EventDTO(id = "e1", calendarId = "cal1", summary = "Meeting", startsAt = "2026-11-16T01:00:00Z", endsAt = "2026-11-16T02:00:00Z")
    private fun response(events: List<EventDTO>) = Reply(200, ok("""{"calendars":[],"events":${Json.encodeToString(ListSerializer(EventDTO.serializer()), events)}}"""))
    private suspend fun CoroutineScope.awaitIdle() {
        while (true) {
            val children = coroutineContext[Job]!!.children.toList()
            if (children.isEmpty()) return
            children.forEach { it.join() }
        }
    }

    @Test fun `remote deletion refreshes even with a read-only detail open`(): Unit = runBlocking {
        FakeServer().use { server ->
            var remote = listOf(event)
            server.handler = { response(remote) }
            val client = ApiClient(server.url)
            try {
                val state = CalendarState(client, this)
                state.load(); awaitIdle()
                state.openDetail(event)
                remote = emptyList()
                state.refreshIfIdle(); awaitIdle()
                assertEquals(emptyList(), state.ui.value.events)
                assertNull(state.ui.value.activeSheet)
            } finally { client.close() }
        }
    }

    @Test fun `read-only detail shows remote edits without losing an editor draft`(): Unit = runBlocking {
        FakeServer().use { server ->
            var remote = listOf(event)
            server.handler = { response(remote) }
            val client = ApiClient(server.url)
            try {
                val state = CalendarState(client, this)
                state.load(); awaitIdle()
                state.openDetail(event)
                val updated = event.copy(summary = "Updated elsewhere")
                remote = listOf(updated)
                state.refreshIfIdle(); awaitIdle()
                assertEquals(ActiveSheet.Detail(updated), state.ui.value.activeSheet)
                state.openEdit(updated)
                val requestsBefore = server.hits.size
                state.refreshIfIdle(); awaitIdle()
                assertEquals(requestsBefore, server.hits.size)
                assertEquals(ActiveSheet.Edit(updated), state.ui.value.activeSheet)
            } finally { client.close() }
        }
    }

    @Test fun `failed refresh preserves open detail and events`(): Unit = runBlocking {
        FakeServer().use { server ->
            server.handler = { response(listOf(event)) }
            val client = ApiClient(server.url)
            try {
                val state = CalendarState(client, this)
                state.load(); awaitIdle()
                state.openDetail(event)
                server.handler = { Reply(503, "") }
                state.refreshIfIdle(); awaitIdle()
                assertEquals(listOf(event), state.ui.value.events)
                assertEquals(ActiveSheet.Detail(event), state.ui.value.activeSheet)
                assertNotNull(state.ui.value.error)
            } finally { client.close() }
        }
    }

    @Test fun `acknowledged delete disappears even if follow-up fetch fails`(): Unit = runBlocking {
        FakeServer().use { server ->
            var deleted = false
            server.handler = { hit -> when {
                hit.method == "DELETE" -> { deleted = true; Reply(204) }
                deleted -> Reply(503, "")
                else -> response(listOf(event))
            } }
            val client = ApiClient(server.url)
            try {
                val state = CalendarState(client, this)
                state.load(); awaitIdle()
                state.delete(event); awaitIdle()
                assertEquals(emptyList(), state.ui.value.events)
                assertNotNull(state.ui.value.undoDelete)
                assertNull(state.ui.value.actionError)
            } finally { client.close() }
        }
    }

    @Test fun `rapid repeated delete clicks issue only one request`(): Unit = runBlocking {
        FakeServer().use { server ->
            server.handler = { hit -> if (hit.method == "DELETE") Reply(204) else response(emptyList()) }
            val client = ApiClient(server.url)
            try {
                val state = CalendarState(client, this)
                state.delete(event)
                state.delete(event)
                awaitIdle()
                assertEquals(1, server.hits.count { it.method == "DELETE" })
                assertNull(state.ui.value.actionError)
                assertNotNull(state.ui.value.undoDelete)
            } finally { client.close() }
        }
    }

    @Test fun `a detail opened from search outside the fetched window is preserved`() {
        val unrelated = event.copy(id = "outside")
        val sheet = ActiveSheet.Detail(unrelated)
        assertEquals(sheet, refreshedDetail(sheet, listOf(event), emptyList()))
    }
}
