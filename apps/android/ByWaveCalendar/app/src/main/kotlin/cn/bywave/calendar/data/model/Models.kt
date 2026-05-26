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
    val description: String? = null,
)

/** PATCH /api/v1/calendars/:id body. Server's updateSchema is
 *  createSchema.partial() — every field optional, only those present
 *  get updated. Null differs from absent in JSON serialization, so we
 *  use `explicitNulls = false` (set on the Json instance) to drop
 *  nulls from the wire and rely on Kotlin defaults instead. */
@Serializable
data class CalendarUpdateInput(
    val name: String? = null,
    val description: String? = null,
    val color: String? = null,
    val timezone: String? = null,
)

// ---- Auth ----
//
// IMPORTANT: native APPs do NOT call /auth/login (web cookie path —
// returns user info, NOT tokens). They call /auth/login-password
// which is the token-issuing endpoint added in server v0.7.5+.
// Same protocol the iOS app uses (see ios/Network/Models.swift).

/** POST /api/v1/auth/login-password body. label/kind/appVersion go into
 *  the server's `devices` table so each phone/tablet shows up as a
 *  separate session, revocable from the web admin. clientDeviceId is
 *  a stable per-install UUID — server uses it to dedup re-logins
 *  (otherwise every login spawns a new device row). */
@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val label: String,
    val kind: String = "android",
    val appVersion: String,
    val clientDeviceId: String,
)

/** /auth/login-password success response. iOS calls the same shape
 *  `PasswordLoginResponse`. accessTokenExpiresAt is ISO 8601 with
 *  fractional seconds — parse with the lenient ISO parser, not the
 *  built-in ISO8601DateFormatter equivalent. */
@Serializable
data class LoginResponse(
    val accessToken: String? = null,
    val accessTokenExpiresAt: String? = null,
    val refreshToken: String? = null,
    val deviceId: String? = null,
    val userId: String? = null,
    val userEmail: String? = null,
    val userName: String? = null,
    /** When true, client must POST /api/v1/auth/login-mfa-verify with
     *  mfaToken + code. accessToken / refreshToken will be null. */
    val mfaPending: Boolean? = null,
    val mfaToken: String? = null,
    val mfaExpiresAt: String? = null,
)

@Serializable
data class RefreshRequest(val refreshToken: String)

@Serializable
data class RefreshResponse(
    val accessToken: String,
    val accessTokenExpiresAt: String? = null,
    /** The server-side /auth/refresh response does NOT include a new
     *  refreshToken (refresh rotation is on the pair-claim / login
     *  endpoints, not refresh). Kept nullable so older server versions
     *  that did rotate continue to work. */
    val refreshToken: String? = null,
)

/** Second step when [LoginResponse.mfaPending] is true. Sends the
 *  6-digit TOTP from the user's authenticator + the mfaToken issued
 *  by /auth/login-password. Server endpoint: /auth/login-mfa-verify. */
@Serializable
data class MfaVerifyRequest(
    val mfaToken: String,
    val code: String,
)

// ---- QR pair flow ----

/** What the server's QR code actually encodes. iOS calls this
 *  `PairingPayload`. The "url" field is the server's public base URL
 *  (e.g. https://rl.lz-ss.com) — we use it to populate the server URL
 *  in the setup screen so the user doesn't have to type it. */
@Serializable
data class PairPayload(
    val v: Int,
    val url: String,
    val code: String,
)

/** POST /api/v1/devices/pair-claim body. Anonymous endpoint — the
 *  6-char `code` from the QR IS the proof of authorization. */
@Serializable
data class PairClaimRequest(
    val code: String,
    val label: String,
    val kind: String = "android",
    val appVersion: String,
    val clientDeviceId: String,
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
