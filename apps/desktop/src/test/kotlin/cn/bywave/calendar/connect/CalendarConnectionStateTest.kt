package cn.bywave.calendar.connect

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class CalendarConnectionStateTest {
    private fun snapshot(name: String = "Before") = CalendarConnection(
        configured = true,
        calendars = listOf(SyncCalendar("calendar", name)),
        apple = AppleConnection(true, "https://example.test/caldav/", "user@example.test"),
    )

    private class FakeApi : CalendarConnectionApi {
        val remoteRequests = mutableListOf<Boolean>()
        var load: suspend () -> CalendarConnection = { error("No reply configured") }
        override suspend fun load(remote: Boolean): CalendarConnection {
            remoteRequests += remote
            return load()
        }
        override suspend fun command(command: CalendarCommand) = error("Unexpected command")
        override suspend fun appleProfile() = error("Unexpected profile request")
    }

    @Test fun `cancelling a foreground read cannot unlock an in-flight save`() = runTest {
        val api = FakeApi().apply { load = { snapshot() } }
        val state = CalendarConnectionState(api)
        state.refresh(true)
        val readReply = CompletableDeferred<CalendarConnection>()
        api.load = { readReply.await() }
        val read = launch { state.refresh(false) }
        runCurrent()
        val saveReply = CompletableDeferred<Unit>()
        val save = launch { state.perform { saveReply.await() } }
        runCurrent()
        read.cancelAndJoin()
        assertTrue(state.busy)
        assertTrue(state.operating)
        var duplicateSaves = 0
        state.perform { duplicateSaves++ }
        assertEquals(0, duplicateSaves)
        saveReply.complete(Unit)
        save.join()
        assertFalse(state.busy)
    }

    @Test fun `late polling result cannot restore state from before a save`() = runTest {
        val before = snapshot()
        val after = snapshot("After")
        val api = FakeApi().apply { load = { before } }
        val state = CalendarConnectionState(api)
        state.refresh(true)
        val oldReply = CompletableDeferred<CalendarConnection>()
        api.load = { oldReply.await() }
        val poll = launch { state.refresh(false, quiet = true) }
        runCurrent()
        api.load = { after }
        state.perform(reload = true) {}
        oldReply.complete(before)
        poll.join()
        assertEquals(after, state.data)
        assertNull(state.error)
    }

    @Test fun `late polling error cannot replace a newer successful save`() = runTest {
        val api = FakeApi().apply { load = { snapshot() } }
        val state = CalendarConnectionState(api)
        state.refresh(true)
        val oldReply = CompletableDeferred<CalendarConnection>()
        api.load = { oldReply.await() }
        val read = launch { state.refresh(false) }
        runCurrent()
        api.load = { snapshot("After") }
        state.perform(reload = true) {}
        oldReply.completeExceptionally(IllegalStateException("Old connection failed"))
        read.join()
        assertNull(state.error)
        assertEquals("After", state.data?.calendars?.single()?.name)
    }

    @Test fun `returning to foreground during a save does not issue a competing read`() = runTest {
        val api = FakeApi().apply { load = { snapshot() } }
        val state = CalendarConnectionState(api)
        state.refresh(true)
        val saved = CompletableDeferred<Unit>()
        val save = launch { state.perform { saved.await() } }
        runCurrent()
        state.refresh(false)
        assertEquals(listOf(true), api.remoteRequests)
        assertTrue(state.busy)
        saved.complete(Unit)
        save.join()
    }

    @Test fun `failed post-save refresh preserves data and does not replay the command`() = runTest {
        val before = snapshot()
        val api = FakeApi().apply { load = { before } }
        val state = CalendarConnectionState(api)
        state.refresh(true)
        var saves = 0
        api.load = { throw IllegalStateException("Offline") }
        state.perform(reload = true) { saves++ }
        assertIs<CalendarStatusRefreshFailed>(state.error)
        assertEquals(before, state.data)
        assertFalse(state.busy)
        api.load = { snapshot("Saved") }
        state.refresh(true)
        assertEquals(1, saves)
        assertNull(state.error)
        assertEquals("Saved", state.data?.calendars?.single()?.name)
    }

    @Test fun `background success does not hide a command failure`() = runTest {
        val api = FakeApi().apply { load = { snapshot() } }
        val state = CalendarConnectionState(api)
        state.refresh(true)
        val rejected = IllegalStateException("Save rejected")
        state.perform(reload = true) { throw rejected }
        state.refresh(false, quiet = true)
        assertSame(rejected, state.error)
    }

    @Test fun `duplicate initial loads share one request and cancellation allows retry`() = runTest {
        val reply = CompletableDeferred<CalendarConnection>()
        val api = FakeApi().apply { load = { reply.await() } }
        val state = CalendarConnectionState(api)
        val initial = launch { state.refresh(true) }
        runCurrent()
        state.refresh(true)
        assertEquals(1, api.remoteRequests.size)
        assertTrue(state.busy)
        initial.cancelAndJoin()
        assertFalse(state.busy)
        assertNull(state.error)
        api.load = { snapshot() }
        state.refresh(false, quiet = true)
        assertEquals(listOf(true, true), api.remoteRequests)
        assertEquals(snapshot(), state.data)
    }

    @Test fun `status refresh retains remote calendars only for the same account`() = runTest {
        val remote = listOf(SyncCalendar("outlook-a", "A's calendar"))
        val initial = snapshot().copy(account = SyncAccount("a@example.test"), remote = remote)
        val api = FakeApi().apply { load = { initial } }
        val state = CalendarConnectionState(api)
        state.refresh(true)
        api.load = { initial.copy(remote = null) }
        state.refresh(false)
        assertEquals(remote, state.data?.remote)
        api.load = { snapshot().copy(account = SyncAccount("b@example.test")) }
        state.refresh(false)
        assertNull(state.data?.remote)
        api.load = { snapshot().copy(account = SyncAccount("b@example.test"), remote = emptyList()) }
        state.refresh(false)
        assertEquals(listOf(true, false, false, true), api.remoteRequests)
    }

    @Test fun `initial read failures stay visible until a successful retry`() = runTest {
        val offline = IllegalStateException("Offline")
        val api = FakeApi().apply { load = { throw offline } }
        val state = CalendarConnectionState(api)
        state.refresh(false, quiet = true)
        assertSame(offline, state.error)
        assertNull(state.data)
        assertFalse(state.busy)
        api.load = { snapshot() }
        state.refresh(false, quiet = true)
        assertNull(state.error)
        assertEquals(snapshot(), state.data)
    }
}
