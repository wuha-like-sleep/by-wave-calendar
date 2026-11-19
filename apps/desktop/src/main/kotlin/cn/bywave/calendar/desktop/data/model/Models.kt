// Wire models for the desktop client. Mirrors src/db/schema.ts and
// the corresponding Android Models.kt / iOS Models.swift — same field
// names, same nullability conventions. Keep changes in lockstep across
// all four clients (web, ios, android, desktop) so the server's API
// surface stays the source of truth.

package cn.bywave.calendar.desktop.data.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull

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
    /** Deleted single occurrences of a recurring series (canonical ISO
     *  instants). Top-level column, not part of extra — GET returns it
     *  verbatim (null when the series never had an occurrence deleted). */
    val exdates: List<String>? = null,
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
    val meetingPassword: String? = null,
    // Per-event reminders (extra.alarms), kept as raw JSON on the read
    // path: the editor and the scheduler parse it via ReminderTriggers,
    // which tolerates imported shapes this client doesn't know about.
    val alarms: kotlinx.serialization.json.JsonElement? = null,
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

// ---- Natural-language quick-add ----

@Serializable
data class ParseEventInput(
    val text: String,
    /** Caller's current LOCAL wall-clock "YYYY-MM-DDTHH:mm:ss" so the server
     *  resolves 明天 / 周五 in the user's timezone, not its own. */
    val now: String? = null,
)

@Serializable
data class ParseEventResult(
    val summary: String,
    val startsAt: String,
    val endsAt: String,
    // Optional fields the shared parser adds when the phrase carries
    // them (same shape as the web ParsedEvent). Older servers omit
    // them; all three default to "not said".
    val location: String? = null,
    val rrule: String? = null,
    val allDay: Boolean? = null,
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
    /** Stable client-generated uid for idempotent create. When set, the
     *  server uses it as the event's uid (UNIQUE per calendar), so a
     *  RETRIED POST collapses onto the first row instead of duplicating.
     *  Generated once per new-event editing session and reused across
     *  retries. Omitted from the wire when null (explicitNulls=false). */
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
    /** Whole-table replacement for the series' deleted occurrences
     *  (PATCH only — POST ignores it). null here means the field is
     *  omitted from the wire (explicitNulls=false) and the server leaves
     *  the stored list untouched; a sent array replaces it wholesale,
     *  so an empty array restores every deleted occurrence. The editor
     *  only sets this when the user actually removed an entry. */
    val exdates: List<String>? = null,
    /** "instance" | "future" | "series" | null. Sent as query param on
     *  PATCH for recurring events to disambiguate scope. */
    val scope: String? = null,
    val recurrenceId: String? = null,
)

/** One entry of extra.alarms — the server's alarm shape (see
 *  src/lib/reminder_triggers.ts). `trigger` is the raw iCalendar value
 *  ("-PT15M", "PT9H", or an imported custom value); action / description
 *  ride along untouched for alarms this client did not create. */
@Serializable
data class AlarmDTO(
    val trigger: String,
    val action: String? = null,
    val description: String? = null,
)

/** Non-null wrapper so an explicit alarms deletion survives
 *  explicitNulls=false — the same trick EventStringField plays for
 *  url / meetingPassword. The server shallow-merges extra: an omitted
 *  `alarms` key keeps the stored value, only an explicit null deletes
 *  it. So: wrapper == null → this editor is not managing alarms (omit);
 *  wrapper.value == null → send `"alarms": null` (delete the key);
 *  wrapper.value == list → send that array. */
@Serializable(with = EventAlarmsFieldSerializer::class)
data class EventAlarmsField(val value: List<AlarmDTO>?)

object EventAlarmsFieldSerializer : KSerializer<EventAlarmsField> {
    override val descriptor = PrimitiveSerialDescriptor("EventAlarmsField", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: EventAlarmsField) {
        require(encoder is JsonEncoder)
        val alarms = value.value
        if (alarms == null) {
            encoder.encodeJsonElement(JsonNull)
        } else {
            encoder.encodeJsonElement(
                encoder.json.encodeToJsonElement(ListSerializer(AlarmDTO.serializer()), alarms),
            )
        }
    }

    override fun deserialize(decoder: Decoder): EventAlarmsField {
        require(decoder is JsonDecoder)
        val element = decoder.decodeJsonElement()
        if (element == JsonNull) return EventAlarmsField(null)
        return EventAlarmsField(
            decoder.json.decodeFromJsonElement(ListSerializer(AlarmDTO.serializer()), element),
        )
    }
}

@Serializable
data class EventExtra(
    val timezone: String? = null,
    val attendees: List<String>? = null,
    /** Category is picked in the edit form, so — like url — it rides in
     *  the EventStringField wrapper: wrapper null = not sent, wrapper
     *  with null value = explicit `"category": null` (clears the key
     *  under the server's shallow extra merge). */
    val category: cn.bywave.calendar.event.EventStringField? = null,
    val url: cn.bywave.calendar.event.EventStringField? = null,
    val meetingPassword: cn.bywave.calendar.event.EventStringField? = null,
    val alarms: EventAlarmsField? = null,
)

// ---- Global search ----
//
// GET /api/v1/search?q=<needle>&limit=<n>. The server matches the needle
// (case-insensitive substring) against each event's summary / description
// / location across every calendar the user can see (owned + shared), and
// returns a lighter row shape than EventDTO — notably no rrule / allDay /
// extra. We mirror iOS's SearchResult: decode into SearchResultDTO, then
// promote to EventDTO on tap (missing fields default to nil/false; the
// detail dialog re-fetches via /events if the user edits). Same client as
// every other authed call, same { ok, data } envelope: the route uses a
// bare reply.send({ events }), which the server's onSend hook wraps to
// { ok: true, data: { events } } — so unwrap() decodes into SearchResponse.

@Serializable
data class SearchResultDTO(
    val id: String,
    val calendarId: String,
    val calendarName: String? = null,
    val calendarColor: String? = null,
    val summary: String,
    val location: String? = null,
    val startsAt: String,
    val endsAt: String,
)

/** GET /api/v1/search response (the `data` payload after the outer
 *  { ok, data } envelope is stripped). */
@Serializable
data class SearchResponse(
    val events: List<SearchResultDTO>,
)

// ---- ICS import ----
//
// POST /api/v1/calendars/{id}/import[/preview]. `text` is the whole
// .ics file decoded as UTF-8. `filename` only feeds the server's
// sourceTag (the same `file:<name>` shape the web upload produces) —
// the tag takes part in the "did anything change" judgement, so
// sending the real name keeps re-importing the same file a no-op
// even when it was first imported through another channel.

@Serializable
data class IcsImportRequest(
    val text: String,
    val filename: String? = null,
)

/** Preview counts for an ICS import — computed server-side by the
 *  same judgement the real import uses, but writes nothing. */
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

// ---- Share / subscribe links ----
//
// GET/POST/DELETE /api/v1/calendars/{id}/share-tokens. A share token is an
// opaque key the server turns into a public read-only .ics subscribe URL
// (the `url` field — e.g. https://server/ics/<token>.ics). The list route
// uses okList() so its `data` payload is a bare JSON ARRAY of ShareToken
// (not an object) — see ApiClient.listShareTokens for how that's decoded.
// `revokedAt` is always null for rows the list returns (the server filters
// revoked tokens out), but we keep it nullable to mirror the DB shape.

@Serializable
data class ShareToken(
    val token: String,
    val calendarId: String,
    val label: String? = null,
    val url: String,
    val revokedAt: String? = null,
    val createdAt: String,
)

/** POST /api/v1/calendars/{id}/share-tokens body. `label` is an optional
 *  free-text name so the user can tell two links apart ("公开", "给老板"). */
@Serializable
data class ShareTokenCreateInput(
    val label: String? = null,
)

// ---- Booking links (owner management) ----
//
// GET/POST/PATCH/DELETE /api/v1/booking-links. A booking link is a public
// scheduling page (the `publicUrl`) where guests can pick an open slot and
// book a meeting; the owner manages these here. Mirrors the web owner UI:
// no weekly-availability editor on desktop for v1 — the server defaults
// `weeklyAvailability`, so we ignore it on the wire (ignoreUnknownKeys on
// the shared Json config drops it). The list route returns a bare JSON
// ARRAY of BookingLink (see ApiClient.listBookingLinks).

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
    val bufferBeforeMin: Int,
    val bufferAfterMin: Int,
    val enabled: Boolean,
    val notifyEmail: Boolean,
    val createdAt: String,
    val updatedAt: String,
    /** Server-rendered public scheduling page URL (e.g.
     *  https://server/book/<slug>). Shown with a Copy button + open-in-browser. */
    val publicUrl: String,
    /** Availability follows the initiating calendar; booked instants use the device zone. */
    val timezone: String? = null,
)

/** A single guest booking for a link, from
 *  GET /api/v1/booking-links/{id}/bookings. Not surfaced in the v1 UI but
 *  modeled for completeness / future use. `eventId` is null until the
 *  server materializes the calendar event; `cancelledAt` is null while
 *  active. */
@Serializable
data class Booking(
    val id: String,
    val linkId: String,
    val eventId: String? = null,
    val guestEmail: String,
    val guestName: String,
    val guestMessage: String? = null,
    val startsAt: String,
    val endsAt: String,
    val cancelToken: String,
    val cancelledAt: String? = null,
    val createdAt: String,
)

/** POST /api/v1/booking-links body. `slug` must match
 *  ^[a-z0-9][a-z0-9-]{0,30}$ (server validates). Buffers + notifyEmail are
 *  optional (server defaults them); weeklyAvailability is server-defaulted
 *  and intentionally not exposed in the desktop v1 UI. */
@Serializable
data class BookingLinkCreateInput(
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

/** PATCH /api/v1/booking-links/{id} body. Any subset of fields; only the
 *  non-null ones are serialized (explicitNulls=false on the shared Json
 *  config), so e.g. toggling `enabled` sends just { enabled }. */
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

// ---- Event conflicts ----
//
// POST /api/v1/events/conflicts { calendarId, startsAt, endsAt,
// excludeId? } → { conflicts: [{ id, summary, startsAt, endsAt }] }.
// The route answers with a bare reply.send({ conflicts }), which the
// server's onSend hook wraps into the usual { ok, data } envelope.

@Serializable
data class ConflictCheckInput(
    val calendarId: String,
    val startsAt: String,
    val endsAt: String,
    /** The event being edited, so it doesn't conflict with itself. */
    val excludeId: String? = null,
)

@Serializable
data class ConflictDTO(
    val id: String,
    val summary: String,
    val startsAt: String,
    val endsAt: String,
)

@Serializable
data class ConflictsResponse(
    val conflicts: List<ConflictDTO> = emptyList(),
)

// ---- ICS subscriptions (inbound feeds) ----
//
// GET/POST /api/v1/calendars/{id}/subscriptions,
// POST   /api/v1/calendars/{id}/subscriptions/{subId}/refresh,
// DELETE /api/v1/calendars/{id}/subscriptions/{subId}.
// A subscription pulls an external .ics feed INTO this calendar — the
// opposite direction of a ShareToken, which publishes this calendar
// out. The list route uses okList(), so its `data` payload is a bare
// JSON array of CalendarSubscription.

@Serializable
data class CalendarSubscription(
    val id: String,
    val calendarId: String,
    val url: String,
    val label: String? = null,
    val refreshMinutes: Int = 360,
    val lastFetchedAt: String? = null,
    /** "ok" / "error" once the feed has been fetched at least once. */
    val lastStatus: String? = null,
    val lastError: String? = null,
    val lastEventCount: Int? = null,
    val createdAt: String,
)

/** POST /api/v1/calendars/{id}/subscriptions body. refreshMinutes is
 *  server-defaulted (360) when omitted; the v1 UI doesn't expose it. */
@Serializable
data class SubscriptionCreateInput(
    val url: String,
    val label: String? = null,
    val refreshMinutes: Int? = null,
)

/** The first-fetch outcome riding along in the create response. The
 *  subscription is saved even when this says ok=false — the UI must
 *  report "saved, first sync failed", not a creation failure. */
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

/** POST .../subscriptions/{subId}/refresh response (the `data`
 *  payload). A failed refresh is a 502 instead, surfaced as an
 *  ApiException carrying the server's message. */
@Serializable
data class SubscriptionRefreshResponse(
    val subscription: CalendarSubscription,
    val inserted: Int = 0,
    val updated: Int = 0,
    val skipped: Int = 0,
    val total: Int = 0,
)
