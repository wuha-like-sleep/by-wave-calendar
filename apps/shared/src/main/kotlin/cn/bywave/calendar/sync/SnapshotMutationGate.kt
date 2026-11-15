package cn.bywave.calendar.sync

import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Orders cache and system-side effects without holding a lock during HTTP.
 * A confirmed mutation invalidates older reads immediately, then runs after any
 * snapshot that already started applying. Its deletion therefore wins even if
 * an earlier snapshot was midway through scheduling reminders or mirror writes. */
class SnapshotMutationGate {
    private val revision = AtomicLong()
    private val mutex = Mutex()

    fun capture(): Long = revision.get()
    fun isCurrent(ticket: Long): Boolean = ticket == revision.get()

    suspend fun applySnapshot(ticket: Long, relevant: () -> Boolean = { true }, apply: suspend () -> Unit) {
        mutex.withLock {
            if (isCurrent(ticket) && relevant()) apply()
        }
    }

    suspend fun mutate(apply: suspend () -> Unit) {
        revision.incrementAndGet()
        mutex.withLock { apply() }
    }

    suspend fun exclusively(apply: suspend () -> Unit) {
        mutex.withLock { apply() }
    }
}
