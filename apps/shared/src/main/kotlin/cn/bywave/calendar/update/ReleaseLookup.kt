package cn.bywave.calendar.update

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Compare every source, coalesce simultaneous checks, and retry failures promptly. */
class ReleaseLookup<T>(
    private val version: (T) -> Int,
    private val valid: (T) -> Boolean,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    data class Result<T>(val release: T?, val fresh: Boolean)
    private val mutex = Mutex()
    @Volatile private var generation = 0L
    private var key: String? = null
    private var checkedAt = 0L
    private var cached: T? = null

    suspend fun check(sourceKey: String, force: Boolean = false, sources: List<suspend () -> T?>): Result<T> {
        val requestedAtGeneration = generation
        return mutex.withLock {
            val age = now() - checkedAt
            val ttl = if (cached == null) 60_000L else 6 * 60 * 60_000L
            if (key == sourceKey && (requestedAtGeneration != generation || (!force && age in 0 until ttl))) {
                return@withLock Result(cached, false)
            }
            val newest = coroutineScope {
                sources.map { fetch -> async {
                    try { fetch()?.takeIf(valid) }
                    catch (e: CancellationException) { throw e }
                    catch (_: Exception) { null }
                } }.awaitAll().filterNotNull().maxByOrNull(version)
            }
            // Cancellation leaves the previous result and retry deadline untouched.
            cached = newest
            key = sourceKey
            checkedAt = now()
            generation++
            Result(newest, true)
        }
    }
}
