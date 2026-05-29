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

// ---- Calendar create / update ----
// Mirror the server's createSchema (POST /api/v1/calendars): name required,
// the rest optional. updateSchema is the same fields all-optional (PATCH).
// Both endpoints return the full calendar row, which CalendarMeta parses
// (ignoreUnknownKeys drops the extra server-only columns).

@Serializable
data class CalendarCreateInput(
    val name: String,
    val description: String? = null,
    val color: String? = null,      // "#rrggbb"
    val timezone: String? = null,
)

@Serializable
data class CalendarUpdateInput(
    val name: String? = null,
    val description: String? = null,
    val color: String? = null,
    val timezone: String? = null,
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

// ---- Attendees ----

@Serializable
data class AttendeesResponse(val attendees: List<String>)

@Serializable
data class AttendeeInviteRequest(val email: String)

@Serializable
data class AttendeeRevokeRequest(val email: String)

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

// ---- Account: change password ----
//
// POST /api/v1/account/password. Mirrors the server's zod body
// (currentPassword + newPassword, newPassword min 8). Server returns
// { ok: true } on success (an empty `data` payload after the envelope
// is stripped) and invalidates all OTHER sessions — the current device's
// refresh token survives, so the desktop stays signed in.

@Serializable
data class ChangePasswordInput(
    val currentPassword: String,
    val newPassword: String,
)

// ---- Devices: list + revoke ----
//
// GET /api/v1/devices returns { devices: [...] }; each row carries the
// fields the server hands back (see src/routes/devices.ts GET /devices).
// ignoreUnknownKeys on the shared Json config means future server-side
// columns won't break older desktop builds, but we mirror the current
// shape so the UI can show label / kind / last-seen.

/** One paired device from GET /api/v1/devices. All timestamps are ISO8601
 *  strings (or null when the server has never seen the device since
 *  pairing). `prefix` is the refresh-token prefix — handy for the user to
 *  tell two same-labelled devices apart, but we mostly show label + kind. */
@Serializable
data class DeviceDTO(
    val id: String,
    val label: String,
    val kind: String,
    val prefix: String? = null,
    val appVersion: String? = null,
    val lastSeenAt: String? = null,
    val lastSeenIp: String? = null,
    val firstSeenIp: String? = null,
    val createdAt: String,
)

/** GET /api/v1/devices response (the `data` payload after the outer
 *  { ok, data } envelope is stripped). */
@Serializable
data class DevicesResponse(
    val devices: List<DeviceDTO>,
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

/** POST /api/v1/auth/web-session response. Server mints a 5-minute
 *  one-shot token; opening the returned URL in a browser plants a web
 *  session cookie for this user without re-authenticating. Used by the
 *  desktop Settings page to "open <web page> already signed in" for
 *  things the desktop UI doesn't (yet) cover natively — change password,
 *  Passkey enroll, MFA setup, delete account, theme picker. */
@Serializable
data class WebSessionResponse(
    val url: String,
    val expiresAt: String,
)

@Serializable
data class WebSessionRequest(
    /** Path inside the web app to land on after the token is consumed.
     *  Must start with /app/ (server enforces; rejects open redirects). */
    val next: String,
)
