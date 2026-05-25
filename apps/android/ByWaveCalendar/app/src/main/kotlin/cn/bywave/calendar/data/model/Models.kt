// Wire models — direct mirror of iOS apps/ios/.../Network/Models.swift
// and the server's createSchema in src/routes/events.ts. Keep these in
// sync: when iOS gets a new field, Android gets it the same release.
//
// We use kotlinx.serialization with @SerialName so server snake_case
// or aliased fields decode without runtime gymnastics. Dates are kept
// as `Instant` so the rest of the APP doesn't have to re-parse ISO
// strings on every render.

package cn.bywave.calendar.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A single event, as returned by GET /api/v1/events. Recurring masters
 * are expanded server-side into per-occurrence rows that share the same
 * `id` — clients distinguish instances by `startsAt`.
 */
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
    /** Server's JSONB `extra` column — timezone, attendees, link. */
    val extra: EventExtraDTO? = null,
)

@Serializable
data class EventExtraDTO(
    val timezone: String? = null,
    val attendees: List<String>? = null,
    val category: String? = null,
    /** Meeting / document link added in v1.3.3. */
    val url: String? = null,
)

/** GET /api/v1/events response envelope. */
@Serializable
data class EventsResponse(
    val calendars: List<CalendarMeta>,
    val events: List<EventDTO>,
)

@Serializable
data class CalendarMeta(
    val id: String,
    val name: String,
    val color: String,           // "#rrggbb" hex; Color(hex:) helper parses.
    val timezone: String? = null,
)

// ---- Auth ----

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    /** Set when MFA challenge requires it; nil on first attempt. */
    val mfaCode: String? = null,
)

@Serializable
data class LoginResponse(
    val accessToken: String? = null,
    val refreshToken: String? = null,
    /** When true, client must POST /api/v1/auth/mfa with mfaToken + code. */
    val mfaPending: Boolean? = null,
    val mfaToken: String? = null,
)

@Serializable
data class RefreshRequest(val refreshToken: String)

@Serializable
data class RefreshResponse(
    val accessToken: String,
    val refreshToken: String,
)

/** Second step when [LoginResponse.mfaPending] is true. Sends the
 *  6-digit TOTP from the user's authenticator + the mfaToken issued
 *  by /auth/login. Returns the same shape as [LoginResponse] except
 *  mfaPending is always false (or the call fails). */
@Serializable
data class MfaVerifyRequest(
    val mfaToken: String,
    val code: String,
)

// ---- Attendees ----

@Serializable
data class AttendeesResponse(
    val attendees: List<String>,
)

@Serializable
data class AttendeeInviteRequest(val email: String)

@Serializable
data class AttendeeRevokeRequest(val email: String)

// ---- Edit / create ----

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
    /** For recurring events: "instance" / "future" / "series" / null. */
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
