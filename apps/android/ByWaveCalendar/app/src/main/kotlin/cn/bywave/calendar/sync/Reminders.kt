// Local-only event reminders. Mirrors iOS LocalNotifications.swift.
//
// Strategy:
//   - On every successful fetchAndCache(), cancel all pending alarms
//     for this profile and re-schedule from the fresh event list.
//   - One AlarmManager.setExactAndAllowWhileIdle per event whose
//     (start - leadTime) is in the future, capped at MAX_PENDING
//     to stay polite to the OS scheduler.
//   - The PendingIntent fires ReminderReceiver, which posts a
//     normal Notification via NotificationManagerCompat.
//
// We use setExactAndAllowWhileIdle (instead of setAlarmClock) so the
// alarm doesn't show up in the "next alarm" lockscreen indicator —
// these are passive reminders, not user-set alarms. Doze deferral
// can shift them by a few minutes; for a "15 min before meeting"
// reminder that's a reasonable trade-off vs. battery cost.

package cn.bywave.calendar.sync

import android.app.AlarmManager
import android.util.Log
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import cn.bywave.calendar.BuildConfig
import cn.bywave.calendar.MainActivity
import cn.bywave.calendar.R
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

class Reminders(private val context: Context) {

    private val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    /**
     * Cancel + reschedule all reminders for [profile] from the given
     * [events]. Caller passes `leadMinutes` from SyncPreferences (the
     * global fallback) and the profile's [calendars] (an all-day
     * event-level alarm anchors in its calendar's timezone when the
     * event itself carries none).
     *
     * 事件级优先：extra.alarms 非空就按 alarms 逐条排（见 alarmFireTimes），
     * 全局提前量只在事件一条 alarms 都没有时才用 —— 和网页/服务端
     * reminder_triggers.ts 的口径一致，否则用户在事件上设的提醒会被
     * 全局设置悄悄盖掉。
     *
     * No-op when notification permission isn't granted.
     */
    fun reschedule(
        profile: Profile,
        events: List<EventDTO>,
        leadMinutes: Int,
        calendars: List<CalendarMeta> = emptyList(),
    ) {
        if (!isAvailable()) return

        val now = System.currentTimeMillis()
        val leadMs = leadMinutes * 60_000L
        val calendarZones = calendars.associate { it.id to it.timezone }

        // Cancel pass first, over EVERY slot an event could occupy.
        // Slot identity is (profile, event, occurrence start, slot) —
        // NOT derived from the alarm contents — so cancelling works
        // even for cache rows whose extra was stripped or has changed
        // since the alarms were scheduled (edits, remote deletes).
        for (ev in events) {
            for (slot in ALL_SLOTS) {
                val cancelIntent = buildPendingIntent(
                    reminderRequestCode(profile.id, ev.id, ev.startsAt, slot),
                    profile.id, ev,
                    flags = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
                )
                if (cancelIntent != null) alarms.cancel(cancelIntent)
            }
        }

        var scheduled = 0
        for (ev in events) {
            if (scheduled >= MAX_PENDING) break
            val alarmsForEvent = ev.extra?.alarms?.filter { it.trigger.isNotBlank() }
            val fireTimes = alarmFireTimes(ev, leadMs, calendarZones[ev.calendarId])
            for ((index, fireAt) in fireTimes.withIndex()) {
                if (fireAt <= now) continue       // already past
                if (scheduled >= MAX_PENDING) break
                // Event-level alarms occupy slots 0..7 by position; the
                // global fallback occupies slot -1 (FALLBACK_SLOT).
                val slot = if (alarmsForEvent.isNullOrEmpty()) FALLBACK_SLOT else index
                val pending = buildPendingIntent(
                    reminderRequestCode(profile.id, ev.id, ev.startsAt, slot),
                    profile.id, ev,
                    flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ) ?: continue
                try {
                    alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pending)
                    scheduled++
                } catch (_: SecurityException) {
                    // Android 12+ requires SCHEDULE_EXACT_ALARM for some
                    // setExact calls; fall back to setWindow with a tight
                    // tolerance so we still fire approximately on time. Log it so
                    // a "my reminder was a few minutes late" report is diagnosable
                    // instead of a silent downgrade.
                    // 事件 id 属于用户数据，正式包不往 logcat 里写。
                    if (BuildConfig.DEBUG) {
                        Log.w("Reminders", "SCHEDULE_EXACT_ALARM denied; using setWindow for event ${ev.id}")
                    }
                    alarms.setWindow(AlarmManager.RTC_WAKEUP, fireAt, 60_000L, pending)
                    scheduled++
                }
            }
        }
    }

    /** Cancel everything tied to this profile. Called on sign-out
     *  / disable. We can only cancel PendingIntents we can rebuild,
     *  so callers must pass the same events that were scheduled.
     *  Every slot is cancelled (see reschedule's slot note), so this
     *  works even when the passed rows have no extra/alarms left. */
    fun cancelAll(profile: Profile, events: List<EventDTO>) {
        for (ev in events) {
            for (slot in ALL_SLOTS) {
                val intent = buildPendingIntent(
                    reminderRequestCode(profile.id, ev.id, ev.startsAt, slot),
                    profile.id, ev,
                    flags = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
                ) ?: continue
                alarms.cancel(intent)
            }
        }
    }

    /**
     * 某个事件要响的时刻（epoch millis），按优先级：
     *
     *   1. extra.alarms 非空 → 逐条解析 trigger：
     *      · 定时事件：startsAt + 有符号时长（绝对时长，跨夏令时不变）。
     *      · 全天事件：基准是事件时区（extra.timezone → 日历时区 → 系统
     *        时区）当天 00:00 的**墙上时间**，再加有符号时长 —— PT9H
     *        永远落在当地 09:00，哪怕当天是夏令时切换日。日期取
     *        startsAt 的 UTC 日期（全天事件的 startsAt 是 UTC 零点）。
     *      · trigger 解析不了的那条跳过，不连累同一事件的其它条。
     *   2. 没有 alarms → 回落全局提前量，且只对定时事件（全天事件套
     *      「提前 N 分钟」会落在前一天的奇怪时刻，这是原有行为，
     *      保持不变）。
     */
    private fun alarmFireTimes(ev: EventDTO, leadMs: Long, calendarTimezone: String?): List<Long> {
        val alarms = ev.extra?.alarms?.filter { it.trigger.isNotBlank() }
        if (!alarms.isNullOrEmpty()) {
            return alarms.mapNotNull { alarm ->
                val duration = parseReminderTriggerDuration(alarm.trigger)
                    ?: return@mapNotNull null
                if (ev.allDay) {
                    val date = runCatching {
                        Instant.parse(ev.startsAt).atZone(ZoneOffset.UTC).toLocalDate()
                    }.getOrNull() ?: return@mapNotNull null
                    val zone = reminderZone(ev.extra?.timezone ?: calendarTimezone)
                    // LocalDateTime arithmetic IS wall-clock arithmetic:
                    // plus(Duration) on a naive date-time moves the clock
                    // reading, which is exactly the all-day semantics.
                    date.atStartOfDay().plus(duration).atZone(zone)
                        .toInstant().toEpochMilli()
                } else {
                    val start = runCatching { Instant.parse(ev.startsAt) }.getOrNull()
                        ?: return@mapNotNull null
                    start.plus(duration).toEpochMilli()
                }
            }
        }
        if (ev.allDay) return emptyList()
        val start = runCatching { Instant.parse(ev.startsAt).toEpochMilli() }.getOrNull()
            ?: return emptyList()
        return listOf(start - leadMs)
    }

    private fun reminderZone(name: String?): ZoneId {
        if (!name.isNullOrBlank()) {
            runCatching { return ZoneId.of(name) }
        }
        return ZoneId.systemDefault()
    }

    fun isAvailable(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val perm = ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.POST_NOTIFICATIONS,
            )
            if (perm != PackageManager.PERMISSION_GRANTED) return false
        }
        return true
    }

    private fun buildPendingIntent(
        requestCode: Int,
        profileId: String,
        event: EventDTO,
        flags: Int,
    ): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            putExtra(EXTRA_PROFILE_ID, profileId)
            putExtra(EXTRA_EVENT_ID, event.id)
            putExtra(EXTRA_EVENT_TITLE, event.summary)
            putExtra(EXTRA_EVENT_STARTS_AT, event.startsAt)
            putExtra(EXTRA_EVENT_LOCATION, event.location)
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }

    private fun reminderRequestCode(profileId: String, eventId: String, startsAt: String, slot: Int): Int {
        // Stable hash that fits Int; collisions are tolerated because
        // FLAG_UPDATE_CURRENT overwrites on insert anyway.
        // The FALLBACK slot deliberately keeps the pre-alarms formula
        // (no "#slot" suffix): alarms scheduled by older builds used
        // exactly this code, and they must stay cancellable after the
        // upgrade or they would fire forever with no way to revoke.
        return if (slot == FALLBACK_SLOT) {
            ("$profileId@$eventId@$startsAt").hashCode()
        } else {
            ("$profileId@$eventId@$startsAt#$slot").hashCode()
        }
    }

    companion object {
        const val CHANNEL_ID = "bwc-reminders"
        private const val MAX_PENDING = 64
        /** Slot of the global-lead-time fallback alarm. */
        private const val FALLBACK_SLOT = -1
        /** Event-level alarms occupy slots 0..7 — the server caps an
         *  event at 8 alarms (MAX_ALARMS_PER_EVENT in
         *  reminder_triggers.ts); slots beyond an event's actual alarm
         *  count are simply never scheduled, only cancelled. */
        private const val MAX_ALARM_SLOTS = 8
        private val ALL_SLOTS: IntRange = FALLBACK_SLOT until MAX_ALARM_SLOTS
        const val EXTRA_PROFILE_ID = "profileId"
        const val EXTRA_EVENT_ID = "eventId"
        const val EXTRA_EVENT_TITLE = "eventTitle"
        const val EXTRA_EVENT_STARTS_AT = "startsAt"
        const val EXTRA_EVENT_LOCATION = "location"

        /** Create the notification channel at first launch. Idempotent
         *  — re-calling with the same id no-ops. */
        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(NotificationManager::class.java)
            val existing = nm.getNotificationChannel(CHANNEL_ID)
            if (existing != null) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.reminder_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.reminder_channel_desc)
            }
            nm.createNotificationChannel(channel)
        }
    }
}

/**
 * Broadcast receiver that the AlarmManager hands a PendingIntent back
 * to at fire time. We materialize a Notification and POST it via
 * NotificationManagerCompat — the user's stock notification UI takes
 * over from there. Tapping the notification opens MainActivity (it
 * reads the extras and could deep-link into the event detail; for
 * v0.6 we just open the calendar root).
 */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val title = intent.getStringExtra(Reminders.EXTRA_EVENT_TITLE)
            ?: return
        val location = intent.getStringExtra(Reminders.EXTRA_EVENT_LOCATION).orEmpty()
        val eventId = intent.getStringExtra(Reminders.EXTRA_EVENT_ID).orEmpty()

        Reminders.ensureChannel(context)
        val openApp = PendingIntent.getActivity(
            context, eventId.hashCode(),
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, Reminders.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(title)
            .setContentText(if (location.isNotBlank()) location else context.getString(R.string.reminder_default_body))
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        if (ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        ) return

        NotificationManagerCompat.from(context).notify(eventId.hashCode(), n)
    }
}


// ---- Trigger parsing ----
//
// 先搜过：Android 端此前没有任何 trigger 解析（Reminders 只会用全局
// 提前量），shared 里也没有，所以这里新写一个小的。只认裸的 ISO 8601
// duration（带符号 P[nW][nD]T[nH][nM][nS]），和服务端
// reminder_triggers.ts 的 DURATION_RE 同口径：W 可以和 D/T 同现并
// 直接相加；年/月故意不认（一个月是 28 还是 31 天没法猜，猜错的提醒
// 比不提醒更难排查）。带参数前缀的写法（RELATED=END:-PT15M 等）不在
// 本解析范围内，解析不了就返回 null、调用方跳过那一条。

private val TRIGGER_DURATION_RE = Regex(
    "^([+-])?P(?:(\\d+)W)?(?:(\\d+)D)?(?:T(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?)?$",
    RegexOption.IGNORE_CASE,
)

/** Parse a signed ISO 8601 duration trigger into a [Duration].
 *  The sign is significant: "-PT15M" is 15 minutes BEFORE the anchor,
 *  "PT9H" is 9 hours after it, and "-PT0M" / "PT0S" are a legitimate
 *  zero (a reminder exactly at the anchor), NOT a parse failure.
 *  Returns null for anything unparseable — including a bare "P" with
 *  no components at all. */
internal fun parseReminderTriggerDuration(raw: String): Duration? {
    // runCatching: an absurd component (P99999999999999999999D) must
    // fail THIS trigger, not the whole reschedule pass.
    return runCatching {
        val match = TRIGGER_DURATION_RE.matchEntire(raw.trim()) ?: return null
        val (sign, weeks, days, hours, minutes, seconds) = match.destructured
        if (weeks.isEmpty() && days.isEmpty() && hours.isEmpty() &&
            minutes.isEmpty() && seconds.isEmpty()
        ) {
            return null
        }
        var duration = Duration.ZERO
        if (weeks.isNotEmpty()) duration = duration.plusDays(weeks.toLong() * 7)
        if (days.isNotEmpty()) duration = duration.plusDays(days.toLong())
        if (hours.isNotEmpty()) duration = duration.plusHours(hours.toLong())
        if (minutes.isNotEmpty()) duration = duration.plusMinutes(minutes.toLong())
        if (seconds.isNotEmpty()) duration = duration.plusSeconds(seconds.toLong())
        if (sign == "-") duration.negated() else duration
    }.getOrNull()
}
