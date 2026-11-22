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
    /** Occurrence starts (ISO 8601) deleted one-by-one from a recurring
     *  series — the server's events.exdates column, sent on GET rows.
     *  Note the asymmetry: PATCH's updateSchema has NO exdates field
     *  (verified in src/routes/events.ts), so the client can read and
     *  stage restores but the current server strips them on save —
     *  see EventUpdateInput.exdates. */
    val exdates: List<String>? = null,
    /** True for non-first occurrences of a recurring series. */
    val isOccurrence: Boolean? = null,
    /** Server's JSONB `extra` column — timezone, attendees, link. */
    val extra: EventExtraDTO? = null,
    /** Only on /search results for recurring events: the next occurrence's
     *  start (the row's own startsAt stays the series start). Null when the
     *  series has ended or the event does not repeat. */
    val nextStartsAt: String? = null,
    /** 本地标记，不上线：这条事件有还没同步到服务端的改动（离线队列
     *  里有它的条目，含停在待处理里的）。由 EventRepository.observe
     *  在读缓存时按队列现状打上，界面据此显示「待同步」。 */
    @kotlinx.serialization.Transient
    val pendingSync: Boolean = false,
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
    /** Event-level reminders from extra.alarms — the server's single
     *  source of truth (src/lib/reminder_triggers.ts). First entry is
     *  the "primary" reminder the editor shows; the rest are preserved
     *  verbatim on save. */
    val alarms: List<EventAlarm>? = null,
)

/** One entry of extra.alarms. `trigger` is a signed ISO 8601 duration
 *  (e.g. "-PT15M"); action is "DISPLAY" for every alarm we create. */
@Serializable
data class EventAlarm(
    val trigger: String,
    val action: String? = null,
    val description: String? = null,
)

/** GET /api/v1/events response envelope. */
@Serializable
data class EventsResponse(
    val calendars: List<CalendarMeta>,
    val events: List<EventDTO>,
)

/** GET /api/v1/search response (after the envelope is unwrapped).
 *  Events carry two extra fields over the wire (calendarName /
 *  calendarColor) that EventDTO does not model — the Json config ignores
 *  unknown keys, and the names/colors come from `calendars` below. */
@Serializable
data class SearchResponse(
    val events: List<EventDTO> = emptyList(),
    val calendars: List<SearchCalendarHit> = emptyList(),
    val bookingLinks: List<SearchBookingLinkHit> = emptyList(),
)

/** GET /api/v1/geo/suggest 的一条在线地址建议（服务端已整形成完整
 *  地址串，客户端只管展示与回填）。 */
@Serializable
data class GeoSuggestion(
    val label: String,
)

/** GET /api/v1/geo/suggest response (after the envelope is unwrapped).
 *  上游失败时服务端回空列表，所以永远能解出。 */
@Serializable
data class GeoSuggestResponse(
    val suggestions: List<GeoSuggestion> = emptyList(),
)

/** POST /api/v1/calendars/{id}/import(/preview) body. `text` is the
 *  whole .ics file decoded as UTF-8. `filename` only feeds the server's
 *  sourceTag (the same `file:<name>` shape the web upload produces) —
 *  the tag takes part in the "did anything change" judgement, so
 *  sending the real name keeps re-importing the same file a no-op even
 *  when it was first imported through another channel. */
@Serializable
data class IcsImportRequest(
    val text: String,
    val filename: String? = null,
)

/** Preview counts for an ICS import — computed server-side by the same
 *  judgement the real import uses, but writes nothing. */
@Serializable
data class IcsImportPreview(
    val total: Int = 0,
    val inserted: Int = 0,
    val updated: Int = 0,
    val duplicates: Int = 0,
    val invalid: Int = 0,
    val invalidReasons: List<String> = emptyList(),
)

/** Result of an ICS import. `skipped` = duplicates + invalid. */
@Serializable
data class IcsImportResult(
    val inserted: Int = 0,
    val updated: Int = 0,
    val skipped: Int = 0,
    val total: Int = 0,
)

@Serializable
data class SearchCalendarHit(
    val id: String,
    val name: String,
    val color: String? = null,
    val url: String? = null,
)

@Serializable
data class SearchBookingLinkHit(
    val id: String,
    val title: String,
    val slug: String,
    val enabled: Boolean = true,
    val url: String? = null,
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
 *  table + the augmented `publicUrl` (`<base>/book/<slug>`).
 *  `weeklyAvailability` is the bookable-windows matrix: keys "0".."6"
 *  (0 = Sunday), values a list of ["HH:MM", "HH:MM"] wall-clock pairs
 *  in the linked calendar's timezone, or null for a day off. The
 *  management UI edits it (BookingLinksScreen's availability section),
 *  seeded from this value. createdAt/updatedAt are ISO 8601 strings. */
@Serializable
data class BookingLink(
    val id: String,
    val userId: String,
    val slug: String,
    val calendarId: String,
    val title: String,
    val description: String? = null,
    val durationMinutes: Int,
    val weeklyAvailability: Map<String, List<List<String>>?>? = null,
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
    /** Availability follows the initiating calendar; booked instants use the device zone. */
    val timezone: String? = null,
)

/** POST /api/v1/booking-links body. `slug` must match
 *  /^[a-z0-9][a-z0-9-]{0,30}$/ (validated client-side before submit).
 *  bufferBeforeMin / bufferAfterMin / notifyEmail are optional — the
 *  server defaults the buffers to 0 and notifyEmail to false.
 *  weeklyAvailability carries only the bookable weekdays as keys (an
 *  absent day means "not bookable"), matching what the availability
 *  editor produces; omitting it entirely keeps the server default.
 *  Response is a BookingLink row. */
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
    val weeklyAvailability: Map<String, List<List<String>>>? = null,
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
    val weeklyAvailability: Map<String, List<List<String>>>? = null,
)

/** One row from GET /api/v1/booking-links/:id/bookings — an appointment
 *  a visitor made through the public page. Field names are the server's
 *  bookings-table columns (an earlier model guessed bookingLinkId /
 *  name / email / note, which never matched the wire — the row decoded
 *  to defaults and the list was unusable). Surfaced by the bookings
 *  viewer in BookingLinksScreen. `cancelledAt` non-null = cancelled
 *  (by the guest or the owner); `eventId` links to the calendar event
 *  the booking created (null once that event is gone). */
@Serializable
data class Booking(
    val id: String,
    val linkId: String,
    val guestName: String,
    val guestEmail: String,
    val guestMessage: String? = null,
    val startsAt: String,
    val endsAt: String,
    val cancelToken: String? = null,
    val cancelledAt: String? = null,
    val eventId: String? = null,
    val createdAt: String? = null,
)

/** POST /api/v1/booking-links/{id}/bookings/{bookingId}/cancel result.
 *  `alreadyCancelled` is true when the booking was already cancelled —
 *  the call is idempotent. */
@Serializable
data class BookingCancelResult(
    val ok: Boolean,
    val alreadyCancelled: Boolean = false,
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
    val codeVerifier: String? = null,
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
    val tokens: List<AttendeeToken> = emptyList(),
    val proposals: List<TimeProposal> = emptyList(),
)

@Serializable
data class AttendeeToken(
    val recipientEmail: String,
    val responseStatus: String = "pending",
    val respondedAt: String? = null,
    val acceptedAt: String? = null,
)

/** 受邀者的「提议新时间」。status: pending / accepted / declined / superseded。 */
@Serializable
data class TimeProposal(
    val id: String,
    val proposerEmail: String,
    val proposedStartsAt: String,
    val proposedEndsAt: String,
    val note: String? = null,
    val status: String,
)

@Serializable
data class ProposalDecisionResponse(val ok: Boolean, val status: String)

@Serializable
data class AttendeeInviteRequest(val email: String)

@Serializable
data class AttendeeRevokeRequest(val email: String)

// ---- Invitations (invitee side) ----
//
// GET /api/v1/invitations — invitations addressed to MY account email.
// Each row carries everything the detail page needs, in the same shape
// as the web /event-invite/:token page: the event's display timezone,
// the full invitee list with per-person RSVP status, and my own time
// proposals. Respond / propose go through the token endpoints (the
// token is the credential, exactly like the web page).

@Serializable
data class InvitationsResponse(
    val invitations: List<Invitation> = emptyList(),
)

@Serializable
data class Invitation(
    val token: String,
    /** pending / accepted / declined / tentative — my current reply. */
    val responseStatus: String = "pending",
    val respondedAt: String? = null,
    val expiresAt: String,
    val organizer: InvitationOrganizer? = null,
    val event: InvitationEvent,
    val invitees: List<InvitationInvitee> = emptyList(),
    val myProposals: List<InvitationProposal> = emptyList(),
)

@Serializable
data class InvitationOrganizer(
    val email: String,
    val name: String,
)

@Serializable
data class InvitationEvent(
    val id: String,
    val summary: String,
    val description: String? = null,
    val location: String? = null,
    val startsAt: String,
    val endsAt: String,
    val allDay: Boolean = false,
    /** Display timezone resolved server-side (event → calendar → default). */
    val timeZone: String = "Asia/Shanghai",
    val cancelled: Boolean = false,
)

@Serializable
data class InvitationInvitee(
    val email: String,
    val name: String? = null,
    /** pending / accepted / declined / tentative. */
    val status: String = "pending",
    val isMe: Boolean = false,
)

/** 我通过这条邀请发出的「提议新时间」。status: pending / accepted / declined / superseded。 */
@Serializable
data class InvitationProposal(
    val id: String,
    val proposedStartsAt: String,
    val proposedEndsAt: String,
    val note: String? = null,
    val status: String,
    val createdAt: String,
    val decidedAt: String? = null,
)

@Serializable
data class InvitationRespondRequest(val status: String)

@Serializable
data class InvitationRespondResponse(
    val ok: Boolean = true,
    val status: String,
)

@Serializable
data class InvitationProposeRequest(
    val startsAt: String,
    val endsAt: String,
    /** 空备注就不发这个字段（explicitNulls=false 时 null 会被省略）。 */
    val note: String? = null,
)

@Serializable
data class InvitationProposeResponse(
    val ok: Boolean = true,
    val proposal: InvitationProposalStub,
)

@Serializable
data class InvitationProposalStub(
    val id: String,
    val proposedStartsAt: String,
    val proposedEndsAt: String,
    val status: String,
)

// ---- Natural-language quick-add ----

@Serializable
data class ParseEventInput(
    val text: String,
    /** Caller's current LOCAL wall-clock "YYYY-MM-DDTHH:mm:ss" so the server
     *  resolves 明天 / 周五 / etc. in the user's timezone, not its own. */
    val now: String? = null,
)

@Serializable
data class ParseEventResult(
    val summary: String,
    /** naive local wall-clock "YYYY-MM-DDTHH:mm:ss" */
    val startsAt: String,
    val endsAt: String,
    // Optional fields the shared parser adds when the phrase carries
    // them (same shape as the web ParsedEvent). Older servers omit
    // them; all three default to "not said".
    val location: String? = null,
    val rrule: String? = null,
    val allDay: Boolean? = null,
)

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
    /** Restored (un-deleted) occurrence list for a recurring series.
     *  Sent ONLY when the user restored at least one entry in the
     *  editor. **Current server caveat**: PATCH's updateSchema
     *  (createSchema.partial() in src/routes/events.ts) has no
     *  exdates field, so zod strips this today — the restore is
     *  staged client-side and takes effect once the server schema
     *  accepts exdates; the editor re-reads the list from the server
     *  on every open, so a not-yet-effective restore is visible as
     *  "still deleted" rather than silently believed. */
    val exdates: List<String>? = null,
    val extra: EventExtra? = null,
    /** For recurring events: "instance" / "future" / "series" / null. */
    val scope: String? = null,
    val recurrenceId: String? = null,
)

@Serializable
data class EventExtra(
    val timezone: String? = null,
    val attendees: List<String>? = null,
    /** Category is FORM-MANAGED since this batch (was create-only
     *  passthrough before), so it uses the same explicit-null wrapper
     *  as url: selected value → string, cleared → JSON null (server's
     *  extraSchema accepts category: string | null), unmanaged →
     *  field omitted. Server values: work / personal / family /
     *  health / travel / meeting (web editor's set). */
    val category: cn.bywave.calendar.event.EventStringField? = null,
    val url: cn.bywave.calendar.event.EventStringField? = null,
    val meetingPassword: cn.bywave.calendar.event.EventStringField? = null,
    /** Managed exactly like url / meetingPassword above: a null field
     *  means "this editor doesn't touch alarms" (omitted from the wire
     *  thanks to explicitNulls = false, server keeps the old value),
     *  a wrapper holding null sends an explicit JSON null (server's
     *  shallow merge deletes the alarms key), a wrapper holding a list
     *  replaces it. See EventEditUiState.buildAlarmsField. */
    val alarms: EventAlarmsField? = null,
)

/** Non-null wrapper so an explicit alarms deletion survives
 *  explicitNulls = false — same trick as the shared EventStringField,
 *  re-implemented here because apps/shared is out of scope for this
 *  change and the payload is a list, not a string. */
@Serializable(with = EventAlarmsFieldSerializer::class)
data class EventAlarmsField(val alarms: List<EventAlarm>?)

object EventAlarmsFieldSerializer : kotlinx.serialization.KSerializer<EventAlarmsField> {
    override val descriptor = kotlinx.serialization.descriptors.PrimitiveSerialDescriptor(
        "EventAlarmsField", kotlinx.serialization.descriptors.PrimitiveKind.STRING,
    )
    override fun serialize(encoder: kotlinx.serialization.encoding.Encoder, value: EventAlarmsField) {
        require(encoder is kotlinx.serialization.json.JsonEncoder)
        val element = value.alarms?.let {
            kotlinx.serialization.json.Json.encodeToJsonElement(
                kotlinx.serialization.builtins.ListSerializer(EventAlarm.serializer()), it,
            )
        } ?: kotlinx.serialization.json.JsonNull
        encoder.encodeJsonElement(element)
    }
    override fun deserialize(decoder: kotlinx.serialization.encoding.Decoder): EventAlarmsField {
        require(decoder is kotlinx.serialization.json.JsonDecoder)
        val element = decoder.decodeJsonElement()
        if (element == kotlinx.serialization.json.JsonNull) return EventAlarmsField(null)
        return EventAlarmsField(
            kotlinx.serialization.json.Json.decodeFromJsonElement(
                kotlinx.serialization.builtins.ListSerializer(EventAlarm.serializer()), element,
            ),
        )
    }
}

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

// ---- MFA settings (POST /api/v1/account/mfa/*) ----
//
// There is NO mfaEnabled field anywhere the native client can read:
// GET /auth/me returns only id / email / displayName / isAdmin, and
// LoginResponse has no MFA flag either (both checked against the
// server + this file). So — same as iOS MfaSettingsPage — the settings
// page probes POST /account/mfa/setup: 200 means "was off, here is a
// pending secret", 409 already_enabled means "on, show disable form".

/** Empty JSON body for POST /account/mfa/setup (the handler reads no
 *  fields; Retrofit still needs a @Body to send `{}`). */
@Serializable
data class EmptyBodyRequest(val unused: String? = null)

/** POST /api/v1/account/mfa/setup success — pending secret, NOT yet
 *  active until /verify succeeds. */
@Serializable
data class MfaSetupResponse(
    val otpauthUri: String,
    val secret: String,
)

/** POST /api/v1/account/mfa/verify body. (Distinct from the login-time
 *  MfaVerifyRequest, which carries an mfaToken instead.) */
@Serializable
data class AccountMfaVerifyRequest(val code: String)

/** POST /api/v1/account/mfa/verify success. The handler replies with a
 *  bare `{ ok: true, backupCodes: [...] }` — see the EnvelopeInterceptor
 *  note in ApiClient.kt for why those codes survive unwrapping.
 *  Backup codes are shown ONCE; the server stores only hashes. */
@Serializable
data class MfaVerifyResponse(
    val ok: Boolean = true,
    val backupCodes: List<String> = emptyList(),
)

/** POST /api/v1/account/mfa/disable body — password + current TOTP.
 *  Wrong password or code is a 403 (not 401), so no refresh storm. */
@Serializable
data class MfaDisableRequest(
    val password: String,
    val code: String,
)

// ---- Devices (GET /api/v1/devices, /devices/me, DELETE /devices/{id}) ----

/** One row of GET /api/v1/devices. Timestamps are ISO 8601 strings. */
@Serializable
data class DeviceItem(
    val id: String,
    val label: String? = null,
    val kind: String? = null,
    val prefix: String? = null,
    val appVersion: String? = null,
    val lastSeenAt: String? = null,
    val lastSeenIp: String? = null,
    val firstSeenIp: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class DevicesResponse(
    val devices: List<DeviceItem> = emptyList(),
)

/** GET /api/v1/devices/me — which devices row THIS bearer token belongs
 *  to. Used only to badge the current device in the list. */
@Serializable
data class CurrentDevice(
    val id: String,
    val label: String? = null,
    val kind: String? = null,
    val hasPushToken: Boolean = false,
)

// ---- API tokens (GET/POST /api/v1/account/api-tokens …) ----
//
// The JSON twin of the Web settings form flow, with the same view
// model: token rows carry the public prefix only (the full secret is a
// hash server-side and comes back exactly ONCE, as `plain` in the
// create / rotate response), plus the step-up context that tells the
// UI which confirmation fields to render. `passwordSet` is tri-state:
// true = account has its own password, false = SSO-only (no usable
// password), null = legacy row.

@Serializable
data class ApiTokenItem(
    val id: String,
    val label: String,
    val prefix: String,
    /** "read" | "write" (server normalizes anything else to "read"). */
    val scope: String = "read",
    val lastUsedAt: String? = null,
    val lastUsedIp: String? = null,
    val useCount: Int = 0,
    val expiresAt: String? = null,
    val rotatedAt: String? = null,
    val createdAt: String? = null,
    val expired: Boolean = false,
    /** True while a rotated token's old secret is in its 7-day grace. */
    val inGrace: Boolean = false,
)

@Serializable
data class ApiTokenUsageDay(
    val day: String,
    val count: Int = 0,
)

@Serializable
data class ApiTokenUsagePerToken(
    val tokenId: String,
    val label: String,
    val count: Int = 0,
)

@Serializable
data class ApiTokenUsage(
    val total: Int = 0,
    val perDay: List<ApiTokenUsageDay> = emptyList(),
    val perToken: List<ApiTokenUsagePerToken> = emptyList(),
)

@Serializable
data class ApiTokensResponse(
    val apiEnabled: Boolean = false,
    val limit: Int = 5,
    val limitReached: Boolean = false,
    val passwordSet: Boolean? = null,
    val mfaEnabled: Boolean = false,
    val tokens: List<ApiTokenItem> = emptyList(),
    val usage: ApiTokenUsage = ApiTokenUsage(),
)

/** Create body. Null step-up fields are omitted on the wire
 *  (explicitNulls = false on the shared Json config). */
@Serializable
data class CreateApiTokenRequest(
    val label: String,
    val scope: String,
    val expiresInDays: Int,
    val currentPassword: String? = null,
    val mfaCode: String? = null,
)

/** Rotate body — step-up fields only; the scope comes from the token. */
@Serializable
data class ApiTokenStepUpRequest(
    val currentPassword: String? = null,
    val mfaCode: String? = null,
)

/** Create success (201). `plain` is shown ONCE and never persisted. */
@Serializable
data class ApiTokenCreatedResponse(
    val token: ApiTokenItem,
    val plain: String,
)

/** Rotate success. `oldExpiresAt` = when the old secret stops working. */
@Serializable
data class ApiTokenRotatedResponse(
    val token: ApiTokenItem,
    val plain: String,
    val oldExpiresAt: String? = null,
)

// ---- Conflict check (POST /api/v1/events/conflicts) ----

@Serializable
data class ConflictsRequest(
    val calendarId: String,
    val startsAt: String,
    val endsAt: String,
    /** The event being edited, so it doesn't conflict with itself. */
    val excludeId: String? = null,
)

@Serializable
data class EventConflict(
    val id: String,
    val summary: String,
    val startsAt: String,
    val endsAt: String,
)

@Serializable
data class ConflictsResponse(
    val conflicts: List<EventConflict> = emptyList(),
)

// ---- Calendar subscriptions (GET/POST/DELETE /calendars/{id}/subscriptions) ----

/** One row of GET /api/v1/calendars/{id}/subscriptions. Mirrors the
 *  server's presentSub() in src/routes/subscriptions.ts. */
@Serializable
data class CalendarSubscription(
    val id: String,
    val calendarId: String,
    val url: String,
    val label: String? = null,
    val refreshMinutes: Int = 360,
    val lastFetchedAt: String? = null,
    val lastStatus: String? = null,
    val lastError: String? = null,
    val lastEventCount: Int? = null,
    val createdAt: String? = null,
)

/** POST /calendars/{id}/subscriptions body. refreshMinutes is left to
 *  the server default (360) in v1 — the native UI doesn't expose it. */
@Serializable
data class SubscriptionCreateRequest(
    val url: String,
    val label: String? = null,
    val refreshMinutes: Int? = null,
)

/** The first-refresh outcome embedded in the create response. A failed
 *  first fetch does NOT mean creation failed — the subscription row is
 *  already stored and will retry on its normal cadence. */
@Serializable
data class SubscriptionRefreshOutcome(
    val ok: Boolean,
    val inserted: Int? = null,
    val updated: Int? = null,
    val skipped: Int? = null,
    val total: Int? = null,
    val error: String? = null,
)

@Serializable
data class SubscriptionCreateResponse(
    val subscription: CalendarSubscription,
    val refresh: SubscriptionRefreshOutcome,
)

/** POST /calendars/{id}/subscriptions/{subId}/refresh success body. */
@Serializable
data class SubscriptionRefreshResponse(
    val subscription: CalendarSubscription,
    val inserted: Int = 0,
    val updated: Int = 0,
    val skipped: Int = 0,
    val total: Int = 0,
)
