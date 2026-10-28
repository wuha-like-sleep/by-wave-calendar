// Ktor-based HTTP client for the desktop app. Talks to the v1 REST
// API on the user's chosen ByWave server (everything under /api/v1).
//
// Two auth modes:
//
//   1. Anonymous — the pair-init / pair-status endpoints (no Bearer
//      header). These are the only ones used during sign-in.
//
//   2. Bearer — every other /api/v1 call carries Authorization:
//      Bearer <accessToken>. On 401 we trade the refresh token for a
//      fresh access token and retry once. Mirrors Android AuthInterceptor
//      and iOS APIClient's 401 retry shim.
//
// Response envelope: every /api/v1 response is wrapped in
//   { "ok": true,  "data": <payload> }
//   { "ok": false, "error": { "code": "...", "message": "..." } }
// We unwrap at the call site via `unwrap<T>(resp)` — explicit beats
// implicit here; the helper is one line.
//
// ⚠️ 出错的那一半**不要**照着上面这两行写死。服务端实际发出来的出错 body
// 有好几种形状，最常见的反而是扁平的 { "error":"码", "message":"人话" }
// （routes/devices.ts 的绝大多数分支、429 限流器、5xx 兜底处理器都是它），
// 而且桌面端连的是用户自己那台服务器，老版本服务端一直在发这个形状。
// 只按嵌套形状解析的代价见 ApiErrorBody.kt 开头 —— 服务端写给用户的那句话
// 被整条丢掉，界面上只剩通用文案，不报任何错。解析统一走
// userMessageFromErrorBody()。

package cn.bywave.calendar.desktop.data.api

import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.model.AttendeeInviteRequest
import cn.bywave.calendar.desktop.data.model.AttendeeRevokeRequest
import cn.bywave.calendar.desktop.data.model.AttendeesResponse
import cn.bywave.calendar.desktop.data.model.BookingLink
import cn.bywave.calendar.desktop.data.model.BookingLinkCreateInput
import cn.bywave.calendar.desktop.data.model.BookingLinkUpdateInput
import cn.bywave.calendar.desktop.data.model.CalendarCreateInput
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.CalendarUpdateInput
import cn.bywave.calendar.desktop.data.model.ChangePasswordInput
import cn.bywave.calendar.desktop.data.model.DesktopPairInitResponse
import cn.bywave.calendar.desktop.data.model.DesktopPairStatusResponse
import cn.bywave.calendar.desktop.data.model.DevicesResponse
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.ParseEventInput
import cn.bywave.calendar.desktop.data.model.ParseEventResult
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.desktop.data.model.Profile
import cn.bywave.calendar.desktop.data.model.EventsResponse
import cn.bywave.calendar.desktop.data.model.RefreshRequest
import cn.bywave.calendar.desktop.data.model.RefreshResponse
import cn.bywave.calendar.desktop.data.model.SearchResponse
import cn.bywave.calendar.desktop.data.model.ShareToken
import cn.bywave.calendar.desktop.data.model.ShareTokenCreateInput
import cn.bywave.calendar.desktop.data.model.WebSessionRequest
import cn.bywave.calendar.desktop.data.model.WebSessionResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ApiException(val status: Int, message: String) : RuntimeException(message)

/** 刷新一次登录令牌的结果。
 *
 *  **必须把「服务端不认这张票」和「根本没问到服务端」分开。**
 *  以前这里只有 true/false，调用方把 false 一律当成被吊销，于是网络一抖
 *  就把用户的账号从这台机器上清掉 —— 而他的账号什么事都没有。 */
internal enum class RefreshOutcome { OK, REVOKED, UNREACHABLE }

/** HTTP 状态码 → 该怎么理解这次刷新失败。
 *
 *  只有 401 是服务端**明确**说这张票作废（改密码 / 重置密码 / 后台移除设备）。
 *  5xx、502、网关超时只说明这次没问成，凭据不动。
 *
 *  放在顶层是为了能直接写单元测试 —— 判错一次的代价是用户的账号被删掉。 */
internal fun refreshOutcomeForStatus(status: Int): RefreshOutcome = when {
    status == 401 -> RefreshOutcome.REVOKED
    status in 200..299 -> RefreshOutcome.OK
    else -> RefreshOutcome.UNREACHABLE
}

/** 扫码登录轮询一次之后该怎么办。 */
internal enum class PairPollKind {
    APPROVED, PENDING, DENIED, EXPIRED,
    /** 这次没问成（网关 5xx、限流、超时）：退避一会儿再问，有次数上限。 */
    RETRY,
    /** 服务端明确拒绝了这次查询（400 之类）：再问一百次也一样，停。 */
    FAIL,
}

/** desktop-pair-status 的状态码 → 下一步。服务端的约定见 src/routes/devices.ts：
 *  200 批准、202 等待、410 拒绝、404 过期、400 缺 code。
 *
 *  以前「预期外的状态码」一律变成 `"HTTP 502"` 这种字符串原样摆给用户，
 *  而且每 2 秒一次无限重试 —— 网关挂着的话就永远停在这里转圈。 */
internal fun pairPollKindForStatus(status: Int): PairPollKind = when (status) {
    200 -> PairPollKind.APPROVED
    202 -> PairPollKind.PENDING
    410 -> PairPollKind.DENIED
    404 -> PairPollKind.EXPIRED
    408, 425, 429 -> PairPollKind.RETRY
    in 500..599 -> PairPollKind.RETRY
    else -> PairPollKind.FAIL
}

/** 连着问不成几次就放弃。8 次退避合计约 2.5 分钟，在二维码 5 分钟有效期之内。 */
internal const val PAIR_POLL_MAX_FAILURES = 8

/** 第 n 次（从 1 数）连续问不成之后，等多久再问；超过上限返回 null = 别再问了。
 *  2s、4s、8s、16s，之后封顶 30s。 */
internal fun pairPollRetryDelayMs(consecutiveFailures: Int): Long? {
    if (consecutiveFailures < 1) return 2_000L
    if (consecutiveFailures > PAIR_POLL_MAX_FAILURES) return null
    val shift = (consecutiveFailures - 1).coerceAtMost(10)
    return (2_000L shl shift).coerceAtMost(30_000L)
}

/**
 * 一个 ApiClient 代表**一个账号**：`profileId` 是 ProfileStore 里那个账号的
 * deviceId。带登录的请求用的 access token、401 之后去换票用的 refresh token、
 * 换来的新票存给谁、判定吊销之后登出谁 —— 全都按这个 id 来，**不读「当前活动账号」**。
 *
 * 以前全读活动账号，而 baseUrl 却是建立 client 时那台服务器。两个账号在不同
 * 服务器上时，切账号之后还在飞的请求会拿 B 的票去 A 的服务器换，A 当然回 401，
 * 于是被判成吊销 —— 删掉的还是 B，一个什么事都没有的账号。
 *
 * `profileId == null` 是匿名 client，只用于扫码配对那两个不带登录的接口；
 * 它碰到 401 什么都不做（没有票可换，也没有账号可登出）。
 */
class ApiClient(
    val serverUrl: String,
    val profileId: String? = null,
) {
    /** 绑定到一个已登录的账号。除了扫码配对，所有地方都该用这个。 */
    constructor(profile: Profile) : this(profile.serverUrl, profile.deviceId)

    private val baseUrl: String = serverUrl.trimEnd('/')

    /** 这个账号当前的 access token（匿名 client 永远是 null）。 */
    private fun accessToken(): String? = profileId?.let { ProfileStore.accessToken(it) }

    /** Shared JSON config — ignoreUnknownKeys so server-side additions
     *  don't crash older clients; explicitNulls=false so we don't ship
     *  `"field": null` over the wire for optional fields. */
    private val jsonCfg = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    private val client: HttpClient = HttpClient(CIO) {
        install(ContentNegotiation) { json(jsonCfg) }
        install(HttpTimeout) {
            connectTimeoutMillis = 15_000
            requestTimeoutMillis = 30_000
        }
        expectSuccess = false  // we read status codes manually
    }

    fun close() { client.close() }

    // ---- Anonymous endpoints (pair flow) ----

    suspend fun desktopPairInit(): DesktopPairInitResponse {
        val resp = client.post("$baseUrl/api/v1/devices/desktop-pair-init")
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "pair-init failed")
        }
        // Go through unwrap() — server wraps every /api/v1/* response in
        // { ok: true, data: ... }, so a bare resp.body() would try to
        // deserialize the outer envelope as DesktopPairInitResponse and
        // fail with "Fields [code, approveUrl, expiresAt] required but
        // missing at path: $".
        return unwrap(resp, DesktopPairInitResponse.serializer())
    }

    sealed class PairStatus {
        object Pending : PairStatus()
        data class Approved(val resp: DesktopPairStatusResponse) : PairStatus()
        object Denied : PairStatus()
        object Expired : PairStatus()
        /** 这次没问成（断网、超时、网关 5xx、限流）。调用方退避后再问，有次数上限。 */
        object Unreachable : PairStatus()
        /** 服务端明确拒绝了这次查询，重试没用。`message` 是能直接给用户看的话。 */
        data class Failed(val message: String) : PairStatus()
    }

    suspend fun desktopPairStatus(code: String): PairStatus {
        return try {
            val resp = client.get("$baseUrl/api/v1/devices/desktop-pair-status") {
                parameter("code", code)
            }
            when (pairPollKindForStatus(resp.status.value)) {
                PairPollKind.APPROVED -> PairStatus.Approved(
                    unwrap(resp, DesktopPairStatusResponse.serializer()),
                )
                PairPollKind.PENDING -> PairStatus.Pending
                PairPollKind.DENIED -> PairStatus.Denied
                PairPollKind.EXPIRED -> PairStatus.Expired
                PairPollKind.RETRY -> PairStatus.Unreachable
                // 服务端那句人话优先（userMessageFromErrorBody 会滤掉机器码）；
                // 没有就用本地化的通用说明。**绝不**把「HTTP 400」这种标记摆出来。
                PairPollKind.FAIL -> PairStatus.Failed(
                    userMessageFromErrorBody(runCatching { resp.bodyAsText() }.getOrDefault(""), resp.status.value)
                        ?: cn.bywave.calendar.desktop.i18n.I18n.t("setup.pollFailed"),
                )
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            // 用户离开了登录页 / 点了「重新生成」：别当成网络错误吞掉。
            throw e
        } catch (_: Exception) {
            // 连不上、超时、200 却解析不了（被中间页劫持）—— 都按「这次没问成」处理。
            PairStatus.Unreachable
        }
    }

    // ---- Authenticated endpoints ----

    /** GET /api/v1/events?from=<iso>&to=<iso>. Server expands recurring
     *  masters into per-occurrence rows that share an `id`, distinguished
     *  by `startsAt`. */
    suspend fun events(from: String, to: String): EventsResponse {
        return getAuthed("/api/v1/events", EventsResponse.serializer()) {
            parameter("from", from)
            parameter("to", to)
        }
    }

    /** GET /api/v1/search?q=<needle>&limit=<n>. Server-side substring match
     *  (case-insensitive) over summary / description / location across every
     *  calendar the user can see, ordered recency-first. Same endpoint the
     *  web Cmd+K palette + iOS SearchView use. `limit` caps results (server
     *  enforces max 100). The route hands back { events: [...] } which the
     *  envelope hook wraps to { ok: true, data: { events } } — so this goes
     *  through getAuthed/unwrap like every other authed read. */
    suspend fun search(query: String, limit: Int = 100): SearchResponse {
        return getAuthed("/api/v1/search", SearchResponse.serializer()) {
            parameter("q", query)
            parameter("limit", limit)
        }
    }

    // ---- Calendars (CRUD) ----

    /** POST /api/v1/calendars — create a calendar. Returns the new row
     *  (parsed as CalendarMeta; extra server columns ignored). */
    suspend fun createCalendar(body: CalendarCreateInput): CalendarMeta {
        return withBodyAuthed(
            method = HttpMethod.POST,
            path = "/api/v1/calendars",
            body = body,
            bodySerializer = CalendarCreateInput.serializer(),
            respSerializer = CalendarMeta.serializer(),
        )
    }

    /** PATCH /api/v1/calendars/{id} — rename / recolor / change timezone /
     *  edit description. Only non-null fields are sent. Returns updated row. */
    suspend fun updateCalendar(id: String, body: CalendarUpdateInput): CalendarMeta {
        return withBodyAuthed(
            method = HttpMethod.PATCH,
            path = "/api/v1/calendars/$id",
            body = body,
            bodySerializer = CalendarUpdateInput.serializer(),
            respSerializer = CalendarMeta.serializer(),
        )
    }

    /** DELETE /api/v1/calendars/{id} — delete a calendar and (server-side
     *  cascade) all its events. Server returns { ok: true }; we only care
     *  that the status is success. */
    suspend fun deleteCalendar(id: String) {
        val resp = withRefresh {
            val token = accessToken()
            client.delete("$baseUrl/api/v1/calendars/$id") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
            }
        }
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "calendar delete failed")
        }
    }

    // ---- Share / subscribe links ----

    /** GET /api/v1/calendars/{id}/share-tokens — list a calendar's active
     *  subscribe links (revoked ones are filtered out server-side). The
     *  route uses okList(), so its `data` payload is a bare JSON ARRAY (not
     *  an object) — we unwrap it with a List serializer rather than a
     *  wrapper DTO. */
    suspend fun listShareTokens(calendarId: String): List<ShareToken> {
        return getAuthed(
            "/api/v1/calendars/$calendarId/share-tokens",
            ListSerializer(ShareToken.serializer()),
        )
    }

    /** POST /api/v1/calendars/{id}/share-tokens — mint a new subscribe link.
     *  Optional `label` names it. Returns the new ShareToken (with its `url`
     *  .ics subscribe link). */
    suspend fun createShareToken(calendarId: String, label: String? = null): ShareToken {
        return withBodyAuthed(
            method = HttpMethod.POST,
            path = "/api/v1/calendars/$calendarId/share-tokens",
            body = ShareTokenCreateInput(label = label),
            bodySerializer = ShareTokenCreateInput.serializer(),
            respSerializer = ShareToken.serializer(),
        )
    }

    /** DELETE /api/v1/calendars/{id}/share-tokens/{token} — revoke a link.
     *  Anyone still subscribed to that .ics URL stops getting updates. The
     *  server returns a bare { ok: true } (no `data`), so we check status
     *  only — same pattern as deleteCalendar / revokeDevice. */
    suspend fun revokeShareToken(calendarId: String, token: String) {
        val resp = withRefresh {
            val bearer = accessToken()
            client.delete("$baseUrl/api/v1/calendars/$calendarId/share-tokens/$token") {
                if (!bearer.isNullOrEmpty()) bearerAuth(bearer)
            }
        }
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "share-token revoke failed")
        }
    }

    // ---- Booking links (owner management) ----

    /** GET /api/v1/booking-links — list the user's booking links. The route
     *  hands back a bare JSON ARRAY of BookingLink (okList-style), so we
     *  unwrap it with a List serializer rather than a wrapper DTO — same
     *  shape as listShareTokens. */
    suspend fun listBookingLinks(): List<BookingLink> {
        return getAuthed(
            "/api/v1/booking-links",
            ListSerializer(BookingLink.serializer()),
        )
    }

    /** POST /api/v1/booking-links — create a booking link. Returns the new
     *  row (with its server-rendered `publicUrl`). The server validates the
     *  slug shape (^[a-z0-9][a-z0-9-]{0,30}$) and defaults
     *  weeklyAvailability / buffers / notifyEmail when omitted. */
    suspend fun createBookingLink(body: BookingLinkCreateInput): BookingLink {
        return withBodyAuthed(
            method = HttpMethod.POST,
            path = "/api/v1/booking-links",
            body = body,
            bodySerializer = BookingLinkCreateInput.serializer(),
            respSerializer = BookingLink.serializer(),
        )
    }

    /** PATCH /api/v1/booking-links/{id} — update any subset of a booking
     *  link's fields. Only non-null fields are sent. Returns the updated
     *  row. */
    suspend fun updateBookingLink(id: String, body: BookingLinkUpdateInput): BookingLink {
        return withBodyAuthed(
            method = HttpMethod.PATCH,
            path = "/api/v1/booking-links/$id",
            body = body,
            bodySerializer = BookingLinkUpdateInput.serializer(),
            respSerializer = BookingLink.serializer(),
        )
    }

    /** Convenience wrapper around updateBookingLink that flips just the
     *  enabled flag (pause / resume a link). Returns the updated row. */
    suspend fun setBookingLinkEnabled(id: String, enabled: Boolean): BookingLink {
        return updateBookingLink(id, BookingLinkUpdateInput(enabled = enabled))
    }

    /** DELETE /api/v1/booking-links/{id} — delete a booking link. Server
     *  returns a bare { ok: true } (no `data`), so we check status only —
     *  same pattern as deleteCalendar / revokeShareToken. */
    suspend fun deleteBookingLink(id: String) {
        val resp = withRefresh {
            val token = accessToken()
            client.delete("$baseUrl/api/v1/booking-links/$id") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
            }
        }
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "booking-link delete failed")
        }
    }

    /** POST /api/v1/events — create a new event. Pass a stable
     *  `clientUid` (generated once when the create editor opens) to make
     *  the create idempotent: the server uses it as the event's uid
     *  (UNIQUE per calendar), so a RETRIED save collapses onto the first
     *  row instead of duplicating. Null leaves it off the wire. */
    suspend fun createEvent(body: EventCreateInput, clientUid: String? = null): EventDTO {
        return withBodyAuthed(
            method = HttpMethod.POST,
            path = "/api/v1/events",
            body = if (clientUid != null) body.copy(clientUid = clientUid) else body,
            bodySerializer = EventCreateInput.serializer(),
            respSerializer = EventDTO.serializer(),
        )
    }

    /** PATCH /api/v1/events/{id} — update an existing event. For recurring
     *  events the body's `scope` + `recurrenceId` fields disambiguate
     *  which occurrence(s) the edit applies to. */
    suspend fun updateEvent(id: String, body: EventUpdateInput): EventDTO {
        return withBodyAuthed(
            method = HttpMethod.PATCH,
            path = "/api/v1/events/$id",
            body = body,
            bodySerializer = EventUpdateInput.serializer(),
            respSerializer = EventDTO.serializer(),
        )
    }

    /** DELETE /api/v1/events/{id}?scope=...&recurrenceId=... — delete an
     *  event. For recurring events the caller MUST pass an explicit
     *  scope; absence makes the server default to "series" (silent
     *  data loss for the user who only meant "this occurrence"). */
    suspend fun deleteEvent(id: String, scope: String? = null, recurrenceId: String? = null) {
        val resp = withRefresh {
            val token = accessToken()
            client.delete("$baseUrl/api/v1/events/$id") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
                if (scope != null) parameter("scope", scope)
                if (recurrenceId != null) parameter("recurrenceId", recurrenceId)
            }
        }
        // Server returns 204 No Content on success; envelope unwrap on
        // an empty body would fail, so handle DELETE separately.
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "delete failed")
        }
    }

    /** POST /api/v1/parse-event — natural-language quick-add. `now` is the
     *  caller's local wall-clock so 明天 / 周五 resolve in the user's zone.
     *  Server ≥ 1.6.4; older servers 404 (caller falls back to a blank form). */
    suspend fun parseEvent(text: String, now: String? = null): ParseEventResult {
        return withBodyAuthed(
            method = HttpMethod.POST,
            path = "/api/v1/parse-event",
            body = ParseEventInput(text, now),
            bodySerializer = ParseEventInput.serializer(),
            respSerializer = ParseEventResult.serializer(),
        )
    }

    /** POST /api/v1/events/{id}/restore — undo a soft-delete. No body; the
     *  caller reloads afterwards (parity with web's undo toast). */
    suspend fun restoreEvent(id: String) {
        val resp = withRefresh {
            val token = accessToken()
            client.post("$baseUrl/api/v1/events/$id/restore") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
            }
        }
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "restore failed")
        }
    }

    // ---- Attendees ----

    /** POST /api/v1/auth/web-session — mint a 5-minute one-shot token
     *  that opens a browser tab signed in as the current user. Used by
     *  the Settings page to deep-link into web pages (修改密码 /
     *  Passkey / MFA / 删除账号 / 外观偏好) that the desktop UI doesn't
     *  cover natively. The phone APPs do the same trick. */
    suspend fun webSession(next: String): WebSessionResponse {
        return withBodyAuthed(
            method = HttpMethod.POST,
            path = "/api/v1/auth/web-session",
            body = WebSessionRequest(next = next),
            bodySerializer = WebSessionRequest.serializer(),
            respSerializer = WebSessionResponse.serializer(),
        )
    }

    // ---- Account / devices (native security flows) ----
    //
    // These cover what used to deep-link out to the web Settings page:
    // change password and view/revoke paired devices. MFA setup, Passkey,
    // delete-account and login history stay on the web — they need more
    // native UI than is worth building right now.

    /** POST /api/v1/account/password — change the account password.
     *  Server verifies `currentPassword`, enforces its own min-length /
     *  policy on `newPassword`, then invalidates all OTHER sessions (this
     *  device's refresh token survives, so the desktop keeps working).
     *
     *  The server replies with a bare { ok: true } that the onSend
     *  envelope hook passes through UNCHANGED (it already has a top-level
     *  `ok`). That means there's no `data` payload to decode — so we can't
     *  route through unwrap() (which would throw "missing_data"). Instead
     *  we mirror deleteEvent/deleteCalendar: check the status, and on a
     *  non-2xx surface the server's { ok:false, error:{ message } } so the
     *  dialog can show "当前密码错误" / "weak_password" inline. */
    suspend fun changePassword(currentPassword: String, newPassword: String) {
        val resp = withRefresh {
            val token = accessToken()
            val jsonBody = jsonCfg.encodeToString(
                ChangePasswordInput.serializer(),
                ChangePasswordInput(currentPassword = currentPassword, newPassword = newPassword),
            )
            client.post("$baseUrl/api/v1/account/password") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
                contentType(ContentType.Application.Json)
                setBody(jsonBody)
            }
        }
        if (!resp.status.isSuccess()) {
            // Prefer the server's structured { ok:false, error:{ message } }
            // so the user sees "当前密码错误" rather than a raw HTTP code.
            throw errorFrom(resp, "change password failed")
        }
    }

    /** GET /api/v1/devices — list the user's paired devices. Goes through
     *  unwrap(): the route's { devices: [...] } body has no top-level `ok`,
     *  so the onSend hook wraps it as { ok: true, data: { devices } }. */
    suspend fun listDevices(): DevicesResponse {
        return getAuthed("/api/v1/devices", DevicesResponse.serializer())
    }

    /** DELETE /api/v1/devices/{id} — revoke (un-pair) one device. Same
     *  bare-{ ok: true } story as changePassword, so we check status only
     *  (no unwrap). Revoking the CURRENT desktop's own device would log it
     *  out on the next refresh — the UI guards against that by hiding the
     *  revoke button on the active device. */
    suspend fun revokeDevice(id: String) {
        val resp = withRefresh {
            val token = accessToken()
            client.delete("$baseUrl/api/v1/devices/$id") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
            }
        }
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "revoke device failed")
        }
    }

    suspend fun attendees(eventId: String): AttendeesResponse {
        return getAuthed("/api/v1/events/$eventId/attendees", AttendeesResponse.serializer())
    }

    suspend fun inviteAttendee(eventId: String, email: String) {
        // Server returns the updated AttendeesResponse, but we don't need
        // it — the caller will re-list. Use a discard-result helper.
        val resp = withRefresh {
            val token = accessToken()
            val jsonBody = jsonCfg.encodeToString(
                AttendeeInviteRequest.serializer(), AttendeeInviteRequest(email),
            )
            client.post("$baseUrl/api/v1/events/$eventId/attendees") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
                contentType(ContentType.Application.Json)
                setBody(jsonBody)
            }
        }
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "invite failed")
        }
    }

    /** DELETE with a body — Ktor's `client.delete` doesn't support body
     *  directly in a fluent way, so we use request {} with method =
     *  HttpMethod.Delete. The server's revoke route uses HTTP DELETE +
     *  body for parity with iOS/Android. */
    suspend fun revokeAttendee(eventId: String, email: String) {
        val resp = withRefresh {
            val token = accessToken()
            val jsonBody = jsonCfg.encodeToString(
                AttendeeRevokeRequest.serializer(), AttendeeRevokeRequest(email),
            )
            client.request("$baseUrl/api/v1/events/$eventId/attendees") {
                method = io.ktor.http.HttpMethod.Delete
                if (!token.isNullOrEmpty()) bearerAuth(token)
                contentType(ContentType.Application.Json)
                setBody(jsonBody)
            }
        }
        if (!resp.status.isSuccess()) {
            throw errorFrom(resp, "revoke failed")
        }
    }

    // ---- Internals ----

    private enum class HttpMethod { POST, PATCH }

    /** Authenticated GET with envelope unwrap + automatic refresh-on-401. */
    private suspend fun <T> getAuthed(
        path: String,
        serializer: KSerializer<T>,
        configure: HttpRequestBuilder.() -> Unit = {},
    ): T {
        val resp = withRefresh {
            val token = accessToken()
            client.get("$baseUrl$path") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
                configure()
            }
        }
        return unwrap(resp, serializer)
    }

    /** Authenticated POST or PATCH with a JSON body. Envelope-unwraps the
     *  response. Shared by createEvent / updateEvent so they don't repeat
     *  the refresh-on-401 dance. */
    private suspend fun <B, R> withBodyAuthed(
        method: HttpMethod,
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
        respSerializer: KSerializer<R>,
    ): R {
        val resp = withRefresh {
            val token = accessToken()
            val jsonBody = jsonCfg.encodeToString(bodySerializer, body)
            val builder: HttpRequestBuilder.() -> Unit = {
                if (!token.isNullOrEmpty()) bearerAuth(token)
                contentType(ContentType.Application.Json)
                setBody(jsonBody)
            }
            when (method) {
                HttpMethod.POST -> client.post("$baseUrl$path", builder)
                HttpMethod.PATCH -> client.patch("$baseUrl$path", builder)
            }
        }
        return unwrap(resp, respSerializer)
    }

    /** Run `block` (an HTTP call), and if it returns 401, refresh and
     *  retry once. Centralizes the auth-retry pattern so each verb
     *  doesn't reimplement it. */
    private suspend fun withRefresh(block: suspend () -> HttpResponse): HttpResponse {
        var resp = block()
        if (resp.status == HttpStatusCode.Unauthorized) {
            // 匿名 client：没有票可换，也没有账号可登出，401 原样交回去。
            val id = profileId ?: return resp
            // Drain the body BEFORE kicking off refresh — Ktor's CIO
            // engine pools connections aggressively and an unread 401
            // body can pin a connection.
            runCatching { resp.bodyAsText() }
            when (tryRefresh(id)) {
                RefreshOutcome.OK -> resp = block()
                // 服务端明确不认这张 refresh token 了（改密码、重置密码、
                // 后台移除设备都会吊销它）。登出的是**这个 client 的账号**，
                // 不是此刻的活动账号。
                //
                // 这一步不能省：省了桌面端会变成僵尸 —— 日历照常显示上次同步的
                // 内容，新建/编辑/删除全部失败，而界面上没有任何地方说明原因。
                RefreshOutcome.REVOKED -> ProfileStore.markSignedOut(id, "auth.sessionRevoked")
                // 这次没问到服务端（断网、超时、5xx）。**凭据不动。**
                // 把 401 原样交回去，调用方该报错报错；下一次请求会再试一次刷新。
                RefreshOutcome.UNREACHABLE -> Unit
            }
        }
        return resp
    }

    /** Single-flight refresh（按账号单飞，见 [refreshLockFor]）。成功时把新的
     *  access token 存进 ProfileStore（refresh token 轮换了也一并存），存给
     *  的都是 [id] 这个账号。 */
    private suspend fun tryRefresh(id: String): RefreshOutcome = refreshLockFor(id).withLock {
        // 账号已经不在本机了（用户刚手动移除，或者同一账号的另一个请求已经判定
        // 吊销并删掉了它）：什么都别动，把 401 原样交回去就好。
        val rt = ProfileStore.refreshToken(id) ?: return@withLock RefreshOutcome.UNREACHABLE
        return@withLock try {
            val resp = client.post("$baseUrl/api/v1/auth/refresh") {
                contentType(ContentType.Application.Json)
                setBody(RefreshRequest(rt))
            }
            // 401 = 服务端明确说这张票作废了。其余非 2xx（5xx、502、网关超时）
            // 只说明这次没问成，不说明凭据坏了。
            val outcome = refreshOutcomeForStatus(resp.status.value)
            if (outcome != RefreshOutcome.OK) return@withLock outcome
            val refreshed = unwrap(resp, RefreshResponse.serializer())
            ProfileStore.setAccessToken(id, refreshed.accessToken)
            val newRt = refreshed.refreshToken
            if (!newRt.isNullOrBlank() && newRt != rt) {
                ProfileStore.updateRefreshToken(id, newRt)
            }
            RefreshOutcome.OK
        } catch (e: ApiException) {
            refreshOutcomeForStatus(e.status)
        } catch (_: Exception) {
            // 连不上、超时、DNS 失败、解析炸了 —— 都不是「凭据坏了」。
            RefreshOutcome.UNREACHABLE
        }
    }

    /** Strip the `{ok, data, error}` envelope. Server returns this on
     *  every `/api/v1` path. ok=true → decode `data`; ok=false →
     *  throw ApiException with the inner error message.
     *
     *  (Backticks around the URL on purpose — `/` followed by `*` in a
     *  KDoc block parses as a nested comment opener and eats the rest
     *  of the function.) */
    private suspend fun <T> unwrap(resp: HttpResponse, serializer: KSerializer<T>): T {
        val raw = resp.bodyAsText()
        val obj = try {
            jsonCfg.parseToJsonElement(raw).jsonObject
        } catch (e: Exception) {
            throw ApiException(resp.status.value, "decode_failed: ${e.message}")
        }
        // runCatching 要把**取 jsonPrimitive 这一步**也包进来。
        // 原来只包了 .boolean：而 obj["ok"] 是对象或数组时 .jsonPrimitive 就抛，
        // 异常从 unwrap 直接逃出去、连 ApiException 都不是 ——
        // 和下面刚修掉的 obj["error"]?.jsonObject 是同一句写法、同一种失效。
        val ok = runCatching { obj["ok"]?.jsonPrimitive?.boolean }.getOrNull()
        if (ok == true) {
            val data = obj["data"] ?: throw ApiException(resp.status.value, "missing_data")
            return jsonCfg.decodeFromJsonElement(serializer, data)
        }
        // Either non-enveloped or ok=false. Build a helpful error.
        //
        // 这里原先是 `obj["error"]?.jsonObject` —— 服务端的扁平信封
        // { error:"码", message:"人话" } 里 error 是字符串，.jsonObject 会抛
        // IllegalArgumentException，而这一段**没有** runCatching 兜着，异常
        // 直接从 unwrap 逃出去，连 ApiException 都不是。信封形状见
        // ApiErrorBody.kt，那里对每种形状都不抛。
        //
        // 捞不到人话时给 "HTTP nnn"：userFacingError 认 startsWith("HTTP ")
        // 为内部标记，会换成通用文案 —— 正是想要的。注意**不要**退回成
        // error 里那个码：码不是给用户看的。
        val message = userMessageFromErrorBody(raw, resp.status.value) ?: "HTTP ${resp.status.value}"
        throw ApiException(resp.status.value, message)
    }

    /** 把一个非 2xx 响应翻成 ApiException，**并且把服务端那句人话留下来**。
     *  body 的几种形状（含「扁平信封里 error 是字符串」这一种）以及
     *  「哪些算人话、哪些是机器码」的判断，全在 ApiErrorBody.kt。
     *
     *  所有不走 unwrap() 的分支都必须经过这里。这条规矩是有来历的：
     *  这些分支原先是自己拼字符串——
     *      throw ApiException(status, "calendar delete failed: $status $body")
     *  拼完那句话会撞上 util/UserFacingError.kt 里的「内部标记」判定
     *  （msg.contains(" failed: ")），于是被整句换成通用文案。结果是：
     *  服务端明明回了「日历不存在」「管理员已停用 APP 同步。请进入网页后台…」
     *  这种能照着做的说明，用户看到的却是「删除失败」四个字。错误文案收口
     *  本来是为了别把内部标记摆给用户看，不是为了把服务端的说明一起吞掉。
     *
     *  body 实在读不出来时才退回 `fallback` + 状态码——那一句仍然带
     *  " failed: "，会被 userFacingError 换成通用文案，这正是想要的。 */
    private suspend fun errorFrom(resp: HttpResponse, fallback: String): ApiException {
        val raw = runCatching { resp.bodyAsText() }.getOrDefault("")
        // 解析和形状判断全在 ApiErrorBody.kt —— 抽出去是为了能不起 HTTP 就测。
        // 这里原先第一句是 `obj["error"]?.jsonObject`，在扁平信封上会抛，
        // 外层 runCatching 吞掉异常回 null，服务端那句人话整条丢失。
        val message = userMessageFromErrorBody(raw, resp.status.value)
        return ApiException(resp.status.value, message ?: "$fallback: HTTP ${resp.status.value}")
    }

    companion object {
        /** 换票的单飞锁，**按账号**、全进程共用。
         *
         *  以前是每个 ApiClient 实例一把锁，而设置页每个操作都 new 一个
         *  ApiClient —— 同一个账号的两个实例同时撞上 401 就会各自去换票，服务端
         *  一轮换，后到的那个拿着旧票必被拒，被判成吊销把人踢出去。按账号共用
         *  一把锁，后到的在锁里读到的已经是新票。 */
        private val refreshLocks = java.util.concurrent.ConcurrentHashMap<String, Mutex>()

        private fun refreshLockFor(profileId: String): Mutex =
            refreshLocks.computeIfAbsent(profileId) { Mutex() }
    }
}
