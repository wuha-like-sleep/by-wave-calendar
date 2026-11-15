package cn.bywave.calendar.desktop.data.time

import java.time.ZoneId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

@OptIn(ExperimentalCoroutinesApi::class)
class SystemTimeZoneMonitorTest {
    private val melbourne = ZoneId.of("Australia/Melbourne")
    private val shanghai = ZoneId.of("Asia/Shanghai")

    @Test fun pollsWhileBackgroundedAndAppliesJvmZoneBeforePublishing() = runTest {
        var current = melbourne
        val applied = mutableListOf<ZoneId>()
        val monitor = SystemTimeZoneMonitor(melbourne, { current }, { applied += it },
            dispatcher = StandardTestDispatcher(testScheduler))
        try {
            monitor.start(); monitor.start(); runCurrent()
            current = shanghai
            advanceTimeBy(5_000); runCurrent()
            assertEquals(shanghai, monitor.zone.value)
            assertEquals(listOf(shanghai), applied)
            advanceTimeBy(5_000); runCurrent()
            assertEquals(listOf(shanghai), applied)
        } finally { monitor.stop() }
    }

    @Test fun foregroundRefreshDoesNotWaitForPollingAndRequestsAreCoalesced() = runTest {
        val result = CompletableDeferred<ZoneId?>()
        var calls = 0
        val monitor = SystemTimeZoneMonitor(melbourne, {
            calls++
            if (calls == 1) result.await() else shanghai
        }, {}, dispatcher = StandardTestDispatcher(testScheduler))
        try {
            monitor.start(); runCurrent()
            repeat(100) { monitor.refresh() }
            runCurrent()
            assertEquals(1, calls)
            result.complete(shanghai); runCurrent()
            assertEquals(2, calls)
            assertEquals(shanghai, monitor.zone.value)
        } finally { monitor.stop() }
    }

    @Test fun failedOrUnknownReadKeepsLastValidZoneAndLaterReadRecovers() = runTest {
        var calls = 0
        val monitor = SystemTimeZoneMonitor(melbourne, {
            when (++calls) {
                1 -> shanghai
                2 -> error("temporary OS failure")
                3 -> throw UnsatisfiedLinkError("temporarily unavailable native library")
                4 -> null
                else -> melbourne
            }
        }, {}, dispatcher = StandardTestDispatcher(testScheduler))
        try {
            monitor.start(); runCurrent()
            repeat(3) {
                monitor.refresh(); runCurrent()
                assertEquals(shanghai, monitor.zone.value)
            }
            monitor.refresh(); runCurrent()
            assertEquals(melbourne, monitor.zone.value)
        } finally { monitor.stop() }
    }

    @Test fun stoppingCancelsPendingReadAndRestartHasOnlyOneWorker() = runTest {
        val pending = CompletableDeferred<ZoneId?>()
        var calls = 0
        val monitor = SystemTimeZoneMonitor(melbourne, {
            calls++
            if (calls == 1) pending.await() else shanghai
        }, {}, dispatcher = StandardTestDispatcher(testScheduler))
        monitor.start(); runCurrent()
        monitor.stop(); pending.complete(ZoneId.of("Europe/Paris")); runCurrent()
        assertEquals(melbourne, monitor.zone.value)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(1, calls)
        try {
            monitor.start(); monitor.start(); runCurrent()
            assertEquals(shanghai, monitor.zone.value)
            assertEquals(2, calls)
        } finally { monitor.stop() }
    }

    @Test fun explicitOverridePinsDisplayAndAvoidsNativePolling() = runTest {
        var calls = 0
        val monitor = SystemTimeZoneMonitor(melbourne, { calls++; melbourne }, {}, pinnedZone = shanghai,
            dispatcher = StandardTestDispatcher(testScheduler))
        try {
            monitor.start(); monitor.refresh(); advanceTimeBy(60_000); runCurrent()
            assertEquals(shanghai, monitor.zone.value)
            assertEquals(0, calls)
        } finally { monitor.stop() }
    }

    @Test fun deniedJvmChangeDoesNotPublishDivergentZoneAndPollingRecovers() = runTest {
        var deny = true
        val monitor = SystemTimeZoneMonitor(melbourne, { shanghai }, { if (deny) throw SecurityException() },
            dispatcher = StandardTestDispatcher(testScheduler))
        try {
            monitor.start(); runCurrent()
            assertEquals(melbourne, monitor.zone.value)
            deny = false
            monitor.refresh(); runCurrent()
            assertEquals(shanghai, monitor.zone.value)
        } finally { monitor.stop() }
    }

    @Test fun overrideComesFromLaunchArgumentsRatherThanCachedProperty() {
        assertNull(explicitTimeZoneOverride(listOf("-Xmx512m")))
        assertEquals(shanghai, explicitTimeZoneOverride(listOf("-Duser.timezone=Asia/Shanghai")))
        assertEquals(melbourne, explicitTimeZoneOverride(listOf("-Duser.timezone=Asia/Shanghai", "-Duser.timezone=Australia/Melbourne")))
        assertNull(explicitTimeZoneOverride(listOf("-Duser.timezone=Asia/Shanghai", "-Duser.timezone=")))
        assertEquals(ZoneId.of("GMT"), explicitTimeZoneOverride(listOf("-Duser.timezone=Invalid/Zone")))
    }
}
