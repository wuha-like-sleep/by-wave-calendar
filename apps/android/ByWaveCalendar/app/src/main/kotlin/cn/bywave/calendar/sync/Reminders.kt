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
import cn.bywave.calendar.MainActivity
import cn.bywave.calendar.R
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.model.EventDTO
import java.time.Instant

class Reminders(private val context: Context) {

    private val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    /**
     * Cancel + reschedule all reminders for [profile] from the given
     * [events]. Caller passes `leadMinutes` from SyncPreferences.
     * No-op when notification permission isn't granted.
     */
    fun reschedule(profile: Profile, events: List<EventDTO>, leadMinutes: Int) {
        if (!isAvailable()) return

        // Best-effort cancel: we re-use the stable hash of
        // (profileId + event id + occurrence start) for each PendingIntent
        // request code, so cancel just iterates through known events.
        val now = System.currentTimeMillis()
        val leadMs = leadMinutes * 60_000L

        var scheduled = 0
        for (ev in events) {
            if (ev.allDay) continue
            val start = runCatching { Instant.parse(ev.startsAt).toEpochMilli() }.getOrNull() ?: continue
            val fireAt = start - leadMs
            val requestCode = reminderRequestCode(profile.id, ev.id, ev.startsAt)

            // Cancel any previously scheduled one for this slot first
            // (handles event time edits — old time's alarm goes away,
            // new time gets a fresh one below).
            val cancelIntent = buildPendingIntent(requestCode, profile.id, ev, flags = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
            if (cancelIntent != null) alarms.cancel(cancelIntent)

            if (fireAt <= now) continue       // already past
            if (scheduled >= MAX_PENDING) break

            val pending = buildPendingIntent(
                requestCode, profile.id, ev,
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
                Log.w("Reminders", "SCHEDULE_EXACT_ALARM denied; using setWindow for event ${ev.id}")
                alarms.setWindow(AlarmManager.RTC_WAKEUP, fireAt, 60_000L, pending)
                scheduled++
            }
        }
    }

    /** Cancel everything tied to this profile. Called on sign-out
     *  / disable. We can only cancel PendingIntents we can rebuild,
     *  so callers must pass the same events that were scheduled. */
    fun cancelAll(profile: Profile, events: List<EventDTO>) {
        for (ev in events) {
            val requestCode = reminderRequestCode(profile.id, ev.id, ev.startsAt)
            val intent = buildPendingIntent(
                requestCode, profile.id, ev,
                flags = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
            ) ?: continue
            alarms.cancel(intent)
        }
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

    private fun reminderRequestCode(profileId: String, eventId: String, startsAt: String): Int {
        // Stable hash that fits Int; collisions are tolerated because
        // FLAG_UPDATE_CURRENT overwrites on insert anyway.
        return ("$profileId@$eventId@$startsAt").hashCode()
    }

    companion object {
        const val CHANNEL_ID = "bwc-reminders"
        private const val MAX_PENDING = 64
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
            .setSmallIcon(R.mipmap.ic_launcher)
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
