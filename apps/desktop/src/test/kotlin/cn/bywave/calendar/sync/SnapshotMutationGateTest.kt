package cn.bywave.calendar.sync

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SnapshotMutationGateTest {
    @Test fun `confirmed delete neither waits for HTTP nor accepts its older response`() = runTest {
        val gate = SnapshotMutationGate()
        val http = CompletableDeferred<Unit>()
        var cache = listOf("deleted")
        var applied = false
        val fetch = launch {
            val ticket = gate.capture()
            http.await()
            gate.applySnapshot(ticket) { applied = true; cache = listOf("deleted") }
        }
        runCurrent()
        gate.mutate { cache = emptyList() }
        assertFalse(fetch.isCompleted)
        assertEquals(emptyList(), cache)
        http.complete(Unit)
        fetch.join()
        assertFalse(applied)
        assertEquals(emptyList(), cache)
    }

    @Test fun `delete wins after a snapshot already entered its system side effects`() = runTest {
        val gate = SnapshotMutationGate()
        val enteredMirror = CompletableDeferred<Unit>()
        val finishMirror = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()
        var mirror = emptyList<String>()
        var reminders = emptyList<String>()
        val snapshot = launch {
            gate.applySnapshot(gate.capture()) {
                enteredMirror.complete(Unit)
                finishMirror.await()
                mirror = listOf("deleted", "keep")
                reminders = listOf("deleted", "keep")
                order += "snapshot"
            }
        }
        enteredMirror.await()
        val deletion = launch {
            gate.mutate {
                mirror = mirror.filterNot { it == "deleted" }
                reminders = reminders.filterNot { it == "deleted" }
                order += "delete"
            }
        }
        runCurrent()
        assertFalse(deletion.isCompleted)
        finishMirror.complete(Unit)
        snapshot.join(); deletion.join()
        assertEquals(listOf("snapshot", "delete"), order)
        assertEquals(listOf("keep"), mirror)
        assertEquals(listOf("keep"), reminders)
    }

    @Test fun `cleanup rejects a queued stale snapshot while the next fresh response can apply`() = runTest {
        val gate = SnapshotMutationGate()
        val oldTicket = gate.capture()
        var cached = "old"
        gate.mutate { cached = "signed out" }
        gate.applySnapshot(oldTicket) { cached = "old" }
        assertEquals("signed out", cached)
        gate.applySnapshot(gate.capture(), relevant = { false }) { cached = "wrong account" }
        assertEquals("signed out", cached)
        gate.applySnapshot(gate.capture()) { cached = "fresh" }
        assertEquals("fresh", cached)
    }

    @Test fun `failed mutation releases the gate but still rejects pre-mutation snapshots`() = runTest {
        val gate = SnapshotMutationGate()
        val ticket = gate.capture()
        runCatching { gate.mutate { error("cache unavailable") } }
        var staleApplied = false
        gate.applySnapshot(ticket) { staleApplied = true }
        assertFalse(staleApplied)
        var preferencesApplied = false
        gate.exclusively { preferencesApplied = true }
        assertTrue(preferencesApplied)
    }
}
