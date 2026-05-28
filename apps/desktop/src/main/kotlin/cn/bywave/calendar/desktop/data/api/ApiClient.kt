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
import cn.bywave.calendar.desktop.data.model.DesktopPairInitResponse
import cn.bywave.calendar.desktop.data.model.DesktopPairStatusResponse
import cn.bywave.calendar.desktop.data.model.EventsResponse
import cn.bywave.calendar.desktop.data.model.RefreshRequest
import cn.bywave.calendar.desktop.data.model.RefreshResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
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
        return resp.body()
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
                HttpStatusCode.OK -> PairStatus.Approved(resp.body())
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

    // ---- Internals ----

    /** Authenticated GET with envelope unwrap + automatic refresh-on-401. */
    private suspend fun <T> getAuthed(
        path: String,
        serializer: KSerializer<T>,
        configure: HttpRequestBuilder.() -> Unit = {},
    ): T {
        suspend fun attempt(): HttpResponse {
            val token = ProfileStore.accessToken()
            return client.get("$baseUrl$path") {
                if (!token.isNullOrEmpty()) bearerAuth(token)
                configure()
            }
        }

        var resp = attempt()
        if (resp.status == HttpStatusCode.Unauthorized) {
            // Drop the body to free the connection BEFORE we kick off
            // refresh — Ktor's CIO engine pools connections aggressively
            // and an unread 401 body can pin a connection.
            runCatching { resp.bodyAsText() }
            if (tryRefresh()) resp = attempt()
        }
        return unwrap(resp, serializer)
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
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    runCatching { content }.getOrNull()
