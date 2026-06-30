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
    /** Optional meeting passcode (入会密码). */
    val meetingPassword: String? = null,
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

/** POST /api/v1/calendars body. Server's createSchema requires `name`
 *  (1..200 chars); description/color/timezone are optional. color must
 *  match /^#[0-9a-fA-F]{6}$/ when present — the swatch picker only ever
 *  produces valid 6-hex values. Response is a CalendarMeta row. */
@Serializable
data class CalendarCreateRequest(
    val name: String,
    val description: String? = null,
    val color: String? = null,
    val timezone: String? = null,
)

// ---- Share / subscribe links (.ics) ----

/** One row from GET /api/v1/calendars/:id/share-tokens (and the body of
 *  POST .../share-tokens). The server augments each DB row with a `url`
 *  field — the public `<base>/ics/<token>.ics` subscribe link. `token`
 *  is the primary key; we use it as the path segment when revoking.
 *  `createdAt` / `revokedAt` are ISO 8601 strings (Date serialized). */
@Serializable
data class ShareToken(
    val token: String,
    val calendarId: String,
    val label: String? = null,
    val revokedAt: String? = null,
    val createdAt: String? = null,
    /** Public subscribe URL — `<PUBLIC_BASE_URL>/ics/<token>.ics`. */
    val url: String? = null,
)

/** POST /api/v1/calendars/:id/share-tokens body. `label` is optional —
 *  a free-text name shown next to the link ("家庭", "工作团队"). */
@Serializable
data class ShareTokenCreateRequest(val label: String? = null)

// ---- Booking links (owner-managed scheduling pages) ----

/** One row from GET /api/v1/booking-links (and the body returned by
 *  POST / PATCH .../booking-links). Mirrors the server's bookingLinks
 *  table + the augmented `publicUrl` (`<base>/book/<slug>`). The server
 *  also returns `weeklyAvailability` (a JSON object keyed by weekday)
 *  — the v1 native UI doesn't edit it, so we omit it from the model and
 *  rely on ignoreUnknownKeys to drop it on decode. createdAt/updatedAt
 *  are ISO 8601 strings. */
@Serializable
data class BookingLink(
    val id: String,
    val userId: String,
    val slug: String,
    val calendarId: String,
    val title: String,
    val description: String? = null,
    val durationMinutes: Int,
    val minNoticeHours: Int,
    val maxDaysAhead: Int,
    val bufferBeforeMin: Int = 0,
    val bufferAfterMin: Int = 0,
    val enabled: Boolean = true,
    val notifyEmail: Boolean = false,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    /** Public booking page URL — `<PUBLIC_BASE_URL>/book/<slug>`. */
    val publicUrl: String? = null,
)

/** POST /api/v1/booking-links body. `slug` must match
 *  /^[a-z0-9][a-z0-9-]{0,30}$/ (validated client-side before submit).
 *  bufferBeforeMin / bufferAfterMin / notifyEmail are optional — the
 *  server defaults the buffers to 0 and notifyEmail to false. The server
 *  defaults weeklyAvailability, so the native v1 create flow never sends
 *  it. Response is a BookingLink row. */
@Serializable
data class BookingLinkCreateRequest(
    val slug: String,
    val title: String,
    val description: String? = null,
    val calendarId: String,
    val durationMinutes: Int,
    val minNoticeHours: Int,
    val maxDaysAhead: Int,
    val bufferBeforeMin: Int? = null,
    val bufferAfterMin: Int? = null,
    val notifyEmail: Boolean? = null,
)

/** PATCH /api/v1/booking-links/:id body. Server's update schema is the
 *  create schema partial()'d plus `enabled` — every field optional, only
 *  those present get changed. We rely on `explicitNulls = false` (set on
 *  the Json instance) to drop nulls from the wire so absent ≠ null. The
 *  per-link enabled toggle sends only `enabled`. */
@Serializable
data class BookingLinkUpdateInput(
    val slug: String? = null,
    val title: String? = null,
    val description: String? = null,
    val calendarId: String? = null,
    val durationMinutes: Int? = null,
    val minNoticeHours: Int? = null,
    val maxDaysAhead: Int? = null,
    val bufferBeforeMin: Int? = null,
    val bufferAfterMin: Int? = null,
    val enabled: Boolean? = null,
    val notifyEmail: Boolean? = null,
)

/** One row from GET /api/v1/booking-links/:id/bookings — a confirmed
 *  appointment a visitor made through the public page. Not surfaced in
 *  the v1 management UI's primary flow but modeled for completeness;
 *  extra server fields decode away via ignoreUnknownKeys. */
@Serializable
data class Booking(
    val id: String,
    val bookingLinkId: String,
    val name: String? = null,
    val email: String? = null,
    val startsAt: String,
    val endsAt: String,
    val note: String? = null,
    val createdAt: String? = null,
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

/** POST /api/v1/devices/desktop-pair-approve body. Bearer-auth endpoint
 *  for the phone-side approval of a desktop pair-init — the phone scans
 *  the desktop's QR (encoded as a URL `<server>/desktop-pair/<code>`),
 *  extracts <code>, and posts here with its access token. Server flips
 *  the pending pair to "approved" using the phone user's identity. */
@Serializable
data class DesktopPairApproveRequest(val code: String)

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
    /** Idempotency key. When set, the server uses it as the event's uid
     *  (UNIQUE per calendar) so a RETRIED create collapses onto the first
     *  row instead of duplicating. Generated ONCE per new-event editing
     *  session (see EventEditViewModel.bootstrap) and reused on every
     *  save attempt. `explicitNulls = false` omits it from the wire when
     *  null (the edit/PATCH path never sends it). */
    val clientUid: String? = null,
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
    val meetingPassword: String? = null,
)

// ---- Native account management ----
//
// These hit the bearer-auth JSON endpoints in src/routes/devices.ts
// (POST /account/password, POST /account/delete). Unlike the /api/v1
// calendar/event routes these reply WITHOUT the ok()/data envelope —
// success is a bare `{ ok: true }` and failure is a 4xx with
// `{ error, message }`. The EnvelopeInterceptor leaves un-enveloped
// bodies (no top-level `ok` boolean wrapping `data`) intact, so the
// 4xx flows through as an HttpException whose errorBody carries the
// server's localized `message`. We never decode the success body.

/** POST /api/v1/account/password body. newPassword must be ≥ 8 chars
 *  (server's z.string().min(8)); the server also runs passwordPolicyError
 *  and returns 400 weak_password with a message if it's too weak.
 *  On success all OTHER sessions/devices are invalidated; the current
 *  device's refresh token survives. */
@Serializable
data class ChangePasswordRequest(
    val currentPassword: String,
    val newPassword: String,
)

/** POST /api/v1/account/delete body. The server validates
 *  `confirm` as a z.literal — it must EXACTLY equal the Chinese phrase
 *  「删除我的账号」 (note this differs from the web delete-account page's
 *  phrase; we match THIS native endpoint, devices.ts:754-757). On
 *  success the account + all sessions are destroyed; the APP must sign
 *  the profile out and return to setup. */
@Serializable
data class DeleteAccountRequest(
    val password: String,
    val confirm: String,
)
