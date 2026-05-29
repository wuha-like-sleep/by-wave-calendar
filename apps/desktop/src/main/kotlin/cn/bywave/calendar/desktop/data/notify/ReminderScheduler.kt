// Desktop event-reminder scheduler. Polls the loaded events and fires a
// native notification `leadMinutes` before each event's start.
//
// Why polling (every 30s) instead of one timer per event: events reload on
// every refresh / profile switch / calendar mutation, which would mean
// constantly cancelling + rescheduling N timers. A single coroutine that
// re-reads the current event list each tick is far simpler and 30s
// granularity is plenty for human calendar reminders.
//
// "Fire once" dedup: a key of "eventId|startsAt" (startsAt distinguishes
// recurring occurrences that share an id) is added to `fired` after we
// notify, so the same occurrence never double-notifies within a session.
// On app restart the set resets, but past events fall outside the fire
// window (now is already past their start), so they won't re-fire — only
// still-upcoming ones can, which is the desired behaviour.

package cn.bywave.calendar.desktop.data.notify

import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.i18n.I18n
import cn.bywave.calendar.desktop.ui.calendar.CalendarUiState
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import java.time.OffsetDateTime
import kotlin.coroutines.coroutineContext

object ReminderScheduler {
    private const val TICK_MS = 30_000L
    // Grace window after an event's start during which a lead=0 (or just-
    // missed) reminder still fires. Keeps us from notifying for events that
    // started long ago (e.g. right after launch) while still catching
    // "remind me at start time".
    private const val POST_START_GRACE_MS = 60_000L

    private val fired = mutableSetOf<String>()

    /** Run the reminder loop bound to a screen's event flow. Suspends until
     *  the calling coroutine is cancelled (MainScreen's LaunchedEffect, so
     *  it lives the whole session and re-binds on profile switch). */
    suspend fun run(uiFlow: StateFlow<CalendarUiState>) {
        while (coroutineContext.isActive) {
            runCatching { tick(uiFlow.value.events) }
                .onFailure { System.err.println("[ReminderScheduler] tick failed: ${it.message}") }
            delay(TICK_MS)
        }
    }

    private fun tick(events: List<EventDTO>) {
        if (!ReminderPrefs.enabled.value) return
        val leadMs = ReminderPrefs.leadMinutes.value.toLong() * 60_000L
        val now = System.currentTimeMillis()

        for (ev in events) {
            // All-day events have no meaningful "minutes before"; skip to
            // avoid 00:00 spam. (A future "morning-of" digest could cover
            // them.)
            if (ev.allDay) continue
            val startMs = parseStartMs(ev.startsAt) ?: continue
            val reminderAt = startMs - leadMs
            val key = "${ev.id}|${ev.startsAt}"
            if (key in fired) continue
            // Fire when we're inside [reminderAt, start + grace).
            if (now in reminderAt until (startMs + POST_START_GRACE_MS)) {
                fired.add(key)
                Notifier.notify(
                    title = ev.summary.ifBlank { I18n.t("reminder.untitled") },
                    body = I18n.t("reminder.body", mapOf("time" to formatLocalTime(startMs))),
                )
            }
        }

        // Bound the dedup set so a long-running session doesn't leak memory:
        // once it's large, drop keys for events whose start is well in the
        // past (they can never fire again).
        if (fired.size > 500) {
            fired.removeAll { k ->
                val sa = k.substringAfter("|", "")
                val sm = parseStartMs(sa)
                sm != null && sm < now - POST_START_GRACE_MS
            }
        }
    }

    private fun parseStartMs(iso: String): Long? =
        runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()

    private fun formatLocalTime(epochMs: Long): String =
        runCatching {
            val odt = java.time.Instant.ofEpochMilli(epochMs)
                .atZone(java.time.ZoneId.systemDefault())
            java.time.format.DateTimeFormatter.ofPattern("HH:mm").format(odt)
        }.getOrDefault("")
}
