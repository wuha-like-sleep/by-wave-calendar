package cn.bywave.calendar.desktop.data.update

import cn.bywave.calendar.update.ReleaseLookup
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class ReleaseLookupTest {
    @Test fun comparesBothSourcesEvenWhenServerHasAnUpdate() = runTest {
        val lookup = ReleaseLookup<Int>({ it }, { it > 0 })
        assertEquals(30, lookup.check("server", sources = listOf({ 29 }, { 30 })).release)
    }
    @Test fun malformedSourceDoesNotHideValidFallback() = runTest {
        val lookup = ReleaseLookup<Int>({ it }, { it in 1..99 })
        assertEquals(30, lookup.check("server", sources = listOf({ 1000 }, { 30 })).release)
    }
    @Test fun failedLookupRetriesAfterOneMinuteAndManualCheckBypassesThrottle() = runTest {
        var clock = 0L
        var calls = 0
        val lookup = ReleaseLookup<Int>({ it }, { it > 0 }, { clock })
        val failed: List<suspend () -> Int?> = listOf({ calls++; throw java.io.IOException() }, { null })
        assertNull(lookup.check("server", sources = failed).release)
        clock = 59_999
        assertFalse(lookup.check("server", sources = failed).fresh)
        assertEquals(1, calls)
        clock = 60_000
        assertTrue(lookup.check("server", sources = failed).fresh)
        assertEquals(2, calls)
        assertEquals(30, lookup.check("server", force = true, sources = listOf({ 30 })).release)
    }
    @Test fun cancellationDoesNotPoisonRetryDeadline() = runTest {
        val lookup = ReleaseLookup<Int>({ it }, { true })
        assertFailsWith<CancellationException> {
            lookup.check("server", sources = listOf({ throw CancellationException() }))
        }
        assertEquals(30, lookup.check("server", sources = listOf({ 30 })).release)
    }
    @Test fun concurrentRequestsShareOneRoundTrip() = runTest {
        var calls = 0
        val lookup = ReleaseLookup<Int>({ it }, { true })
        val requests = (1..5).map { async {
            lookup.check("server", force = true, sources = listOf({ calls++; delay(100); 30 }))
        } }.awaitAll()
        assertEquals(1, calls)
        assertTrue(requests.all { it.release == 30 })
    }
    @Test fun successIsCachedPerServerAndClockRollbackDoesNotStick() = runTest {
        var clock = 1000L
        val lookup = ReleaseLookup<Int>({ it }, { true }, { clock })
        lookup.check("a", sources = listOf({ 30 }))
        assertEquals(30, lookup.check("a", sources = listOf({ 31 })).release)
        assertEquals(32, lookup.check("b", sources = listOf({ 32 })).release)
        clock = 0
        assertEquals(33, lookup.check("b", sources = listOf({ 33 })).release)
    }
}
