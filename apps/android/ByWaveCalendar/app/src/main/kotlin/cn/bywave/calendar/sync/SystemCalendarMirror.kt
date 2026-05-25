// SystemCalendarMirror — mirrors ByWave events into the Android
// "Calendar" provider so they appear in the user's stock Calendar app,
// Google Calendar, the system widget, etc.
//
// Architecture:
//   - One local-only Calendars row per active profile ("ByWave — Work",
//     "ByWave — Personal", etc.) so different accounts don't collide.
//   - On every fetchAndCache(), we delete all rows in the ByWave
//     sub-calendar(s) and re-insert from the fresh wide-window data.
//     Clear-and-reinsert mirrors EventRepository's Room strategy —
//     simpler than diffing and the row counts are small (< few
//     thousand).
//   - Account type ACCOUNT_TYPE_LOCAL = local-only (no Google sync).
//     The user can still see / open / dismiss our events from the
//     stock app but the system won't try to sync them anywhere.
//
// Mirrors iOS EventKitMirror.swift.

package cn.bywave.calendar.sync

import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import java.time.Instant
import java.time.ZoneId

class SystemCalendarMirror(private val context: Context) {

    private val accountType = CalendarContract.ACCOUNT_TYPE_LOCAL
    private val accountName = "ByWave Calendar"

    fun isAvailable(): Boolean {
        val read = ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CALENDAR)
        val write = ContextCompat.checkSelfPermission(context, android.Manifest.permission.WRITE_CALENDAR)
        return read == PackageManager.PERMISSION_GRANTED && write == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Replace all events under our sub-calendars for [profile] with
     * the given fresh snapshot. Safe to call repeatedly; idempotent.
     *
     * Caller is responsible for checking [isAvailable] first — we
     * silently no-op if permissions aren't granted yet (so the
     * EventRepository.fetchAndCache hook stays clean).
     */
    fun mirror(
        profile: Profile,
        calendars: List<CalendarMeta>,
        events: List<EventDTO>,
    ) {
        if (!isAvailable()) return
        val resolver = context.contentResolver

        // 1. Resolve or insert one Calendars row per ByWave calendar,
        //    keyed by (profileId, calendarId). Stash the resulting
        //    system calendar id in a lookup map.
        val sysIds = mutableMapOf<String, Long>()
        for (cal in calendars) {
            val sysId = ensureSystemCalendar(resolver, profile, cal)
            if (sysId > 0) sysIds[cal.id] = sysId
        }

        // 2. Delete every event we previously inserted under this
        //    profile's sub-calendars.
        val deleteSelection = "${CalendarContract.Events.CALENDAR_ID} IN (" +
            sysIds.values.joinToString(",") + ")"
        if (sysIds.isNotEmpty()) {
            resolver.delete(CalendarContract.Events.CONTENT_URI, deleteSelection, null)
        }

        // 3. Insert fresh.
        val zone = ZoneId.systemDefault().id
        for (ev in events) {
            val sysId = sysIds[ev.calendarId] ?: continue
            val startMs = parseInstant(ev.startsAt) ?: continue
            val endMs = parseInstant(ev.endsAt) ?: continue
            val values = ContentValues().apply {
                put(CalendarContract.Events.CALENDAR_ID, sysId)
                put(CalendarContract.Events.TITLE, ev.summary)
                put(CalendarContract.Events.EVENT_LOCATION, ev.location.orEmpty())
                put(CalendarContract.Events.DESCRIPTION, buildDescription(ev))
                put(CalendarContract.Events.DTSTART, startMs)
                put(CalendarContract.Events.DTEND, endMs)
                put(CalendarContract.Events.EVENT_TIMEZONE, zone)
                put(CalendarContract.Events.ALL_DAY, if (ev.allDay) 1 else 0)
                // We DON'T set the RRULE column even for recurring
                // events — server-side rrule_expand already emitted
                // per-occurrence rows in our wide-window response, so
                // each row is a standalone event in the mirror.
            }
            resolver.insert(CalendarContract.Events.CONTENT_URI, values)
        }
    }

    /** Look up (by name + account match) or create our sub-calendar
     *  row for the given ByWave calendar under this profile. Returns
     *  the system calendar _id or -1 on failure. */
    private fun ensureSystemCalendar(
        resolver: ContentResolver,
        profile: Profile,
        cal: CalendarMeta,
    ): Long {
        val displayName = "${cal.name} · ${profile.email}"
        // Look up by displayName + accountName so two profiles with
        // the same calendar name don't conflict (the email suffix
        // disambiguates).
        val proj = arrayOf(CalendarContract.Calendars._ID)
        val sel = "${CalendarContract.Calendars.ACCOUNT_NAME} = ? AND " +
            "${CalendarContract.Calendars.CALENDAR_DISPLAY_NAME} = ?"
        val args = arrayOf(accountName, displayName)
        resolver.query(CalendarContract.Calendars.CONTENT_URI, proj, sel, args, null)?.use { c ->
            if (c.moveToFirst()) return c.getLong(0)
        }
        // Not found — insert.
        val uri = CalendarContract.Calendars.CONTENT_URI.buildUpon()
            .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, accountName)
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, accountType)
            .build()
        val values = ContentValues().apply {
            put(CalendarContract.Calendars.ACCOUNT_NAME, accountName)
            put(CalendarContract.Calendars.ACCOUNT_TYPE, accountType)
            put(CalendarContract.Calendars.NAME, "bywave-${profile.id}-${cal.id}")
            put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, displayName)
            put(CalendarContract.Calendars.OWNER_ACCOUNT, accountName)
            put(CalendarContract.Calendars.CALENDAR_TIME_ZONE, ZoneId.systemDefault().id)
            put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
                CalendarContract.Calendars.CAL_ACCESS_OWNER)
            put(CalendarContract.Calendars.CALENDAR_COLOR, parseColorInt(cal.color))
            put(CalendarContract.Calendars.SYNC_EVENTS, 1)
            put(CalendarContract.Calendars.VISIBLE, 1)
        }
        val created = resolver.insert(uri, values) ?: return -1
        return ContentUris.parseId(created)
    }

    /** Remove ALL ByWave sub-calendars for this profile from the
     *  system calendar. Called on sign-out / mirror-disable. */
    fun unmirror(profile: Profile) {
        if (!isAvailable()) return
        val resolver = context.contentResolver
        val sel = "${CalendarContract.Calendars.ACCOUNT_NAME} = ? AND " +
            "${CalendarContract.Calendars.NAME} LIKE ?"
        val args = arrayOf(accountName, "bywave-${profile.id}-%")
        // Use sync-adapter URI so we're allowed to delete calendar rows
        // (regular app-context delete requires CALENDAR_ACCESS_OWNER and
        // can still fail for system-managed accounts).
        val uri = CalendarContract.Calendars.CONTENT_URI.buildUpon()
            .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, accountName)
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, accountType)
            .build()
        resolver.delete(uri, sel, args)
    }

    // -- helpers --

    private fun parseInstant(iso: String): Long? =
        runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()

    /** Concatenate description + link for the mirrored event. iOS
     *  Calendar shows the link clickable when prefixed with the URL
     *  alone on its own line — keep that convention for consistency. */
    private fun buildDescription(ev: EventDTO): String {
        val parts = mutableListOf<String>()
        ev.description?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
        ev.extra?.url?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
        return parts.joinToString("\n\n")
    }

    /** Parse "#RRGGBB" → ARGB int with full alpha. Falls back to a
     *  neutral purple if the string is malformed. */
    private fun parseColorInt(hex: String?): Int {
        if (hex.isNullOrBlank()) return FALLBACK_COLOR_INT
        val cleaned = hex.removePrefix("#")
        return runCatching {
            val v = cleaned.toLong(16)
            (0xFF000000.toInt()) or v.toInt()
        }.getOrDefault(FALLBACK_COLOR_INT)
    }

    private companion object {
        val FALLBACK_COLOR_INT = (0xFF6640E9).toInt()
    }
}
