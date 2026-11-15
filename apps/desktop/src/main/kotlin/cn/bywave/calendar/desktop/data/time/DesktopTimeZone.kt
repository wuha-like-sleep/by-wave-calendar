package cn.bywave.calendar.desktop.data.time

import java.lang.management.ManagementFactory
import java.time.ZoneId
import java.util.TimeZone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** One process-wide display zone. Start/stop with the application, refresh on window focus.
 *
 * A nonempty explicit JVM -Duser.timezone pins the display zone for this launch.
 * Reading System.getProperty("user.timezone") cannot detect this: TimeZone.getDefault()
 * itself writes that property. RuntimeMXBean exposes the actual launch arguments.
 * The OS is only read; updating the JVM default never changes the user's system setting.
 */
object DesktopTimeZone {
    private val monitor by lazy {
        val initial = ZoneId.systemDefault()
        val reader = OperatingSystemTimeZoneReader()
        SystemTimeZoneMonitor(
            initialZone = initial,
            pinnedZone = explicitTimeZoneOverride(ManagementFactory.getRuntimeMXBean().inputArguments),
            readZone = reader::read,
            applyZone = { TimeZone.setDefault(TimeZone.getTimeZone(it)) },
        )
    }

    val zone: StateFlow<ZoneId> get() = monitor.zone
    fun start() = monitor.start()
    fun refresh() = monitor.refresh()
    fun stop() = monitor.stop()
}

internal fun explicitTimeZoneOverride(arguments: List<String>): ZoneId? {
    val argument = arguments.lastOrNull { it.startsWith("-Duser.timezone=") } ?: return null
    val value = argument.substringAfter('=')
    // An empty property asks the JVM to detect the platform zone. Preserve the
    // JVM's usual handling of legacy aliases and invalid explicit IDs (GMT).
    return value.takeIf { it.isNotEmpty() }?.let { TimeZone.getTimeZone(it).toZoneId() }
}

/** Serializes native reads and coalesces foreground/timer requests. No UI-thread I/O. */
internal class SystemTimeZoneMonitor(
    initialZone: ZoneId,
    private val readZone: suspend () -> ZoneId?,
    private val applyZone: (ZoneId) -> Unit,
    private val pinnedZone: ZoneId? = null,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val pollIntervalMillis: Long = 5_000,
) {
    init { require(pollIntervalMillis > 0) }
    private val mutableZone = MutableStateFlow(pinnedZone ?: initialZone)
    val zone: StateFlow<ZoneId> = mutableZone.asStateFlow()
    private val lifecycleLock = Any()
    private var scope: CoroutineScope? = null
    private var requests: Channel<Unit>? = null

    fun start(): Unit = synchronized(lifecycleLock) {
        if (scope != null || pinnedZone != null) return@synchronized
        val newScope = CoroutineScope(SupervisorJob() + dispatcher)
        val newRequests = Channel<Unit>(Channel.CONFLATED)
        scope = newScope
        requests = newRequests
        newScope.launch {
            for (ignored in newRequests) {
                val next = try {
                    readZone()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    null
                } catch (_: LinkageError) {
                    null
                }
                currentCoroutineContext().ensureActive()
                if (next != null) synchronized(lifecycleLock) {
                    // A stopped native read may finish after a new start. It
                    // must not overwrite the new worker's observation.
                    if (scope === newScope && mutableZone.value != next) {
                        try {
                            applyZone(next)
                            mutableZone.value = next
                        } catch (_: Exception) {
                            // A denied JVM default change must not publish a
                            // different UI zone or permanently stop polling.
                        }
                    }
                }
            }
        }
        newScope.launch {
            while (true) {
                newRequests.trySend(Unit)
                delay(pollIntervalMillis)
            }
        }
        Unit
    }

    /** Nonblocking. Multiple requests during a read produce at most one extra read. */
    fun refresh() = synchronized(lifecycleLock) { requests?.trySend(Unit); Unit }

    fun stop() = synchronized(lifecycleLock) {
        scope?.cancel()
        requests?.close()
        scope = null
        requests = null
    }
}
