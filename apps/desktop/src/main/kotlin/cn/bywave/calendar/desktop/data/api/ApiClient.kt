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

package cn.bywave.calendar.desktop.data.api

import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.model.AttendeeInviteRequest
import cn.bywave.calendar.desktop.data.model.AttendeeRevokeRequest
import cn.bywave.calendar.desktop.data.model.AttendeesResponse
import cn.bywave.calendar.desktop.data.model.CalendarCreateInput
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.CalendarUpdateInput
import cn.bywave.calendar.desktop.data.model.ChangePasswordInput
import cn.bywave.calendar.desktop.data.model.DesktopPairInitResponse
import cn.bywave.calendar.desktop.data.model.DesktopPairStatusResponse
import cn.bywave.calendar.desktop.data.model.DevicesResponse
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.desktop.data.model.EventsResponse
import cn.bywave.calendar.desktop.data.model.RefreshRequest
import cn.bywave.calendar.desktop.data.model.RefreshResponse
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ApiException(val status: Int, message: String) : RuntimeException(message)

class ApiClient(val serverUrl: String) {
    private val baseUrl: String = serverUrl.trimEnd('/')

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

    /** Serialize refresh attempts so a burst of parallel 401s doesn't
     *  spawn N parallel refresh calls — they'd each rotate the token
     *  and a race would leave most retries holding stale tokens. */
    private val refreshMutex = Mutex()

    fun close() { client.close() }

    // ---- Anonymous endpoints (pair flow) ----

    suspend fun desktopPairInit(): DesktopPairInitResponse {
        val resp = client.post("$baseUrl/api/v1/devices/desktop-pair-init")
        if (!resp.status.isSuccess()) {
            // Read body BEFORE throwing — Kotlin's require() lambda is
            // non-suspend so we can't call bodyAsText() inside it.
            val body = runCatching { resp.bodyAsText() }.getOrDefault("<no body>")
            throw ApiException(resp.status.value, "pair-init failed: ${resp.status} $body")
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
        data class Error(val message: String) : PairStatus()
    }

    suspend fun desktopPairStatus(code: String): PairStatus {
        return try {
            val resp = client.get("$baseUrl/api/v1/devices/desktop-pair-status") {
                parameter("code", code)
            }
            when (resp.status) {
                HttpStatusCode.OK -> PairStatus.Approved(
                    unwrap(resp, DesktopPairStatusResponse.serializer()),
                )
                HttpStatusCode.Accepted -> PairStatus.Pending
                HttpStatusCode.Gone -> PairStatus.Denied
                HttpStatusCode.NotFound -> PairStatus.Expired
                else -> PairStatus.Error("HTTP ${resp.status.value}")
            }
        } catch (e: Exception) {
            PairStatus.Error(e.localizedMessage ?: "网络异常")
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
            val token = ProfileStore.accessToken()
            client.delete("$baseUrl/api/v1/calendars/$id") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
            }
        }
        if (!resp.status.isSuccess()) {
            val body = runCatching { resp.bodyAsText() }.getOrDefault("")
            throw ApiException(resp.status.value, "calendar delete failed: ${resp.status} $body")
        }
    }

    /** POST /api/v1/events — create a new event. */
    suspend fun createEvent(body: EventCreateInput): EventDTO {
        return withBodyAuthed(
            method = HttpMethod.POST,
            path = "/api/v1/events",
            body = body,
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
            val token = ProfileStore.accessToken()
            client.delete("$baseUrl/api/v1/events/$id") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
                if (scope != null) parameter("scope", scope)
                if (recurrenceId != null) parameter("recurrenceId", recurrenceId)
            }
        }
        // Server returns 204 No Content on success; envelope unwrap on
        // an empty body would fail, so handle DELETE separately.
        if (!resp.status.isSuccess()) {
            val body = runCatching { resp.bodyAsText() }.getOrDefault("")
            throw ApiException(resp.status.value, "delete failed: ${resp.status} $body")
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
            val token = ProfileStore.accessToken()
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
            val token = ProfileStore.accessToken()
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
            val token = ProfileStore.accessToken()
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
            val body = runCatching { resp.bodyAsText() }.getOrDefault("")
            throw ApiException(resp.status.value, "invite failed: ${resp.status} $body")
        }
    }

    /** DELETE with a body — Ktor's `client.delete` doesn't support body
     *  directly in a fluent way, so we use request {} with method =
     *  HttpMethod.Delete. The server's revoke route uses HTTP DELETE +
     *  body for parity with iOS/Android. */
    suspend fun revokeAttendee(eventId: String, email: String) {
        val resp = withRefresh {
            val token = ProfileStore.accessToken()
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
            val body = runCatching { resp.bodyAsText() }.getOrDefault("")
            throw ApiException(resp.status.value, "revoke failed: ${resp.status} $body")
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
            val token = ProfileStore.accessToken()
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
            val token = ProfileStore.accessToken()
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
            // Drain the body BEFORE kicking off refresh — Ktor's CIO
            // engine pools connections aggressively and an unread 401
            // body can pin a connection.
            runCatching { resp.bodyAsText() }
            if (tryRefresh()) resp = block()
        }
        return resp
    }

    /** Single-flight refresh. Returns true on success; saves the new
     *  access token in ProfileStore (and the refresh token if rotated). */
    private suspend fun tryRefresh(): Boolean = refreshMutex.withLock {
        val rt = ProfileStore.profile.value?.refreshToken ?: return@withLock false
        return@withLock try {
            val resp = client.post("$baseUrl/api/v1/auth/refresh") {
                contentType(ContentType.Application.Json)
                setBody(RefreshRequest(rt))
            }
            if (!resp.status.isSuccess()) return@withLock false
            val refreshed = unwrap(resp, RefreshResponse.serializer())
            ProfileStore.setAccessToken(refreshed.accessToken)
            val newRt = refreshed.refreshToken
            if (!newRt.isNullOrBlank() && newRt != rt) {
                ProfileStore.updateRefreshToken(newRt)
            }
            true
        } catch (_: Exception) {
            false
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
        val okPrim = obj["ok"]?.jsonPrimitive
        val ok = runCatching { okPrim?.boolean }.getOrNull()
        if (ok == true) {
            val data = obj["data"] ?: throw ApiException(resp.status.value, "missing_data")
            return jsonCfg.decodeFromJsonElement(serializer, data)
        }
        // Either non-enveloped or ok=false. Build a helpful error.
        val err = obj["error"]?.jsonObject
        val message = err?.get("message")?.jsonPrimitive?.contentOrNullSafe()
            ?: err?.get("code")?.jsonPrimitive?.contentOrNullSafe()
            ?: "HTTP ${resp.status.value}"
        throw ApiException(resp.status.value, message)
    }

    /** Build an ApiException from a non-2xx response whose body we expect
     *  to be the { ok:false, error:{ code, message } } envelope (or the
     *  legacy { error, message } shape). Used by the bare-{ ok: true }
     *  endpoints (changePassword / revokeDevice) that can't go through
     *  unwrap(). Falls back to `fallback` + status if the body is unusable
     *  so the caller always gets *something* readable to show inline. */
    private suspend fun errorFrom(resp: HttpResponse, fallback: String): ApiException {
        val raw = runCatching { resp.bodyAsText() }.getOrDefault("")
        val message = runCatching {
            val obj = jsonCfg.parseToJsonElement(raw).jsonObject
            val err = obj["error"]?.jsonObject
            err?.get("message")?.jsonPrimitive?.contentOrNullSafe()
                ?: err?.get("code")?.jsonPrimitive?.contentOrNullSafe()
                ?: obj["message"]?.jsonPrimitive?.contentOrNullSafe()
                ?: obj["error"]?.jsonPrimitive?.contentOrNullSafe()
        }.getOrNull()
        return ApiException(resp.status.value, message ?: "$fallback: HTTP ${resp.status.value}")
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    runCatching { content }.getOrNull()
