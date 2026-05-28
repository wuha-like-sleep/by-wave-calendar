// Wire models for the desktop client. Mirrors src/db/schema.ts and
// the corresponding Android Models.kt / iOS Models.swift — same field
// names, same nullability conventions. Keep changes in lockstep across
// all four clients (web, ios, android, desktop) so the server's API
// surface stays the source of truth.

package cn.bywave.calendar.desktop.data.model

import kotlinx.serialization.Serializable

// ---- Calendar + events (read path) ----

/** Single event row from GET /api/v1/events. Recurring masters are
 *  expanded server-side into per-occurrence rows that share the same
 *  `id` — clients distinguish instances by `startsAt`. */
@Serializable
data class EventDTO(
    val id: String,
    val calendarId: String,
    val summary: String,
    val description: String? = null,
    val location: String? = null,
    val startsAt: String,        // ISO8601 with offset; convert at use site.
    val endsAt: String,
    val allDay: Boolean = false,
    val rrule: String? = null,
    /** True for non-first occurrences of a recurring series. */
    val isOccurrence: Boolean? = null,
    val extra: EventExtraDTO? = null,
)

@Serializable
data class EventExtraDTO(
    val timezone: String? = null,
    val attendees: List<String>? = null,
    val category: String? = null,
    val url: String? = null,
)

/** GET /api/v1/events response envelope (the `data` payload after we
 *  strip the outer { ok, data } envelope). */
@Serializable
data class EventsResponse(
    val calendars: List<CalendarMeta>,
    val events: List<EventDTO>,
)

@Serializable
data class CalendarMeta(
    val id: String,
    val name: String,
    val color: String,           // "#rrggbb" hex.
    val timezone: String? = null,
    val description: String? = null,
)

// ---- Event create / update / delete ----

@Serializable
data class EventCreateInput(
    val calendarId: String,
    val summary: String,
    val description: String? = null,
    val location: String? = null,
    val startsAt: String,
    val endsAt: String,
    val allDay: Boolean? = null,
    val rrule: String? = null,
    val extra: EventExtra? = null,
)

@Serializable
data class EventUpdateInput(
    val calendarId: String? = null,
    val summary: String? = null,
    val description: String? = null,
    val location: String? = null,
    val startsAt: String? = null,
    val endsAt: String? = null,
    val allDay: Boolean? = null,
    val rrule: String? = null,
    val extra: EventExtra? = null,
    /** "instance" | "future" | "series" | null. Sent as query param on
     *  PATCH for recurring events to disambiguate scope. */
    val scope: String? = null,
    val recurrenceId: String? = null,
)

@Serializable
data class EventExtra(
    val timezone: String? = null,
    val attendees: List<String>? = null,
    val category: String? = null,
    val url: String? = null,
)

// ---- Auth refresh ----

@Serializable
data class RefreshRequest(val refreshToken: String)

@Serializable
data class RefreshResponse(
    val accessToken: String,
    val accessTokenExpiresAt: String? = null,
    /** Server's /auth/refresh doesn't currently rotate the refresh token,
     *  but keep nullable so older builds that did rotate still work. */
    val refreshToken: String? = null,
)

// ---- Desktop QR pair flow ----

@Serializable
data class DesktopPairInitResponse(
    val code: String,
    val approveUrl: String,
    val expiresAt: String,
)

/** Server returns one of three shapes from /desktop-pair-status:
 *    202 → { status: "pending" }
 *    200 → { status: "approved", accessToken, refreshToken, ... }
 *    410 → { status: "denied" }
 *    404 → { status: "expired" } — we synthesize this client-side too
 *  Single DTO with everything nullable; client checks `status`. */
@Serializable
data class DesktopPairStatusResponse(
    val status: String,
    val accessToken: String? = null,
    val accessTokenExpiresAt: String? = null,
    val refreshToken: String? = null,
    val deviceId: String? = null,
    val userId: String? = null,
    val userEmail: String? = null,
    val userName: String? = null,
)

// ---- Profile / persistence ----

/** On-disk profile written to ~/.bywave-calendar/profile.json after a
 *  successful pair. Plain JSON; encryption is not warranted on desktop
 *  because the OS user's home dir is already access-controlled. We keep
 *  refreshToken only — accessToken is short-lived, refreshed lazily on
 *  each authenticated API call via the auth interceptor.
 *
 *  Avoids the literal `/` `*` adjacency in this comment because Kotlin
 *  parses it as a nested block-comment opener inside KDoc. */
@Serializable
data class Profile(
    val serverUrl: String,
    val userId: String,
    val email: String,
    val displayName: String? = null,
    val deviceId: String,
    val refreshToken: String,
)
