// Retrofit-based API client. v0.5: now keyed by (profileId, serverUrl)
// so we keep a separate OkHttp connection pool per account and don't
// accidentally cross-contaminate auth between profiles. AuthInterceptor
// reads the refresh token from the active Profile in ProfileStore.

package cn.bywave.calendar.data.api

import cn.bywave.calendar.BuildConfig
import cn.bywave.calendar.data.auth.Profile
import cn.bywave.calendar.data.auth.ProfileStore
import cn.bywave.calendar.data.model.AttendeeInviteRequest
import cn.bywave.calendar.data.model.AttendeeRevokeRequest
import cn.bywave.calendar.data.model.AttendeesResponse
import cn.bywave.calendar.data.model.Booking
import cn.bywave.calendar.data.model.BookingLink
import cn.bywave.calendar.data.model.BookingLinkCreateRequest
import cn.bywave.calendar.data.model.BookingLinkUpdateInput
import cn.bywave.calendar.data.model.CalendarCreateRequest
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.CalendarUpdateInput
import cn.bywave.calendar.data.model.ChangePasswordRequest
import cn.bywave.calendar.data.model.DeleteAccountRequest
import cn.bywave.calendar.data.model.DesktopPairApproveRequest
import cn.bywave.calendar.data.model.EventCreateInput
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.ParseEventInput
import cn.bywave.calendar.data.model.ParseEventResult
import cn.bywave.calendar.data.model.EventUpdateInput
import cn.bywave.calendar.data.model.EventsResponse
import cn.bywave.calendar.data.model.LoginRequest
import cn.bywave.calendar.data.model.LoginResponse
import cn.bywave.calendar.data.model.MfaVerifyRequest
import cn.bywave.calendar.data.model.PairClaimRequest
import cn.bywave.calendar.data.model.RefreshRequest
import cn.bywave.calendar.data.model.RefreshResponse
import cn.bywave.calendar.data.model.ShareToken
import cn.bywave.calendar.data.model.ShareTokenCreateRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
// Retrofit 2.11+ ships its own converter at this exact package.
// (The earlier JakeWharton converter required different wiring — we
// switched to the official one in v0.8 to get `asConverterFactory`.)
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

interface BywaveApi {
    // CRITICAL: this is /auth/login-password, NOT /auth/login.
    // /auth/login is the WEB cookie endpoint — it returns user info and
    // sets a session cookie but does NOT mint access/refresh tokens.
    // Native APPs (iOS + Android) must use the -password variant which
    // creates a `devices` row and returns the token pair. Hit the wrong
    // endpoint and login appears to succeed (or return 401 for some
    // shapes) but every subsequent API call gets 401 because there's no
    // Bearer token to send.
    @POST("api/v1/auth/login-password")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("api/v1/auth/login-mfa-verify")
    suspend fun verifyMfa(@Body body: MfaVerifyRequest): LoginResponse

    @POST("api/v1/auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): RefreshResponse

    /** Anonymous endpoint — the 6-char code from the QR IS the
     *  authorization. Returns token pair on success. */
    @POST("api/v1/devices/pair-claim")
    suspend fun pairClaim(@Body body: PairClaimRequest): LoginResponse

    /** Bearer-auth endpoint: phone scans a desktop's pair-init QR
     *  (https://server/desktop-pair/<code>), extracts the 8-char code,
     *  posts here with its access token. Desktop's polling picks up
     *  the approval. No response body — 200 means OK. */
    @POST("api/v1/devices/desktop-pair-approve")
    suspend fun desktopPairApprove(@Body body: DesktopPairApproveRequest)

    /** Web 扫码登录 counterpart. Phone scans a browser's QR on the /login
     *  page (encoded as https://server/web-pair/<code>), posts here with
     *  bearer token. Browser's polling picks up the approval and the
     *  server plants a session cookie on the polling browser. Same shape
     *  + payload as desktopPairApprove — server just routes to a
     *  different in-memory map. */
    @POST("api/v1/devices/web-pair-approve")
    suspend fun webPairApprove(@Body body: DesktopPairApproveRequest)

    /** Edit a calendar — name / color / timezone / description.
     *  All fields optional; only those passed get changed. */
    @PATCH("api/v1/calendars/{id}")
    suspend fun updateCalendar(
        @Path("id") id: String,
        @Body body: CalendarUpdateInput,
    ): CalendarMeta

    /** Create a new calendar. Returns the freshly-inserted row (the
     *  server replies 201; Retrofit treats any 2xx as success). */
    @POST("api/v1/calendars")
    suspend fun createCalendar(@Body body: CalendarCreateRequest): CalendarMeta

    /** Delete a calendar. CASCADES — the server drops its events too
     *  (the FK from events → calendars is onDelete: cascade). No body
     *  in the success response we care about; envelope unwraps to
     *  `{ ok: true }`. Show a destructive confirm before calling. */
    @DELETE("api/v1/calendars/{id}")
    suspend fun deleteCalendar(@Path("id") id: String)

    /** List the active (non-revoked) subscribe links for a calendar.
     *  Each token carries a public `url` (`<base>/ics/<token>.ics`). */
    @GET("api/v1/calendars/{id}/share-tokens")
    suspend fun shareTokens(@Path("id") id: String): List<ShareToken>

    /** Mint a new subscribe link (optional label). Returns the row
     *  with its `url`. Server replies 201. */
    @POST("api/v1/calendars/{id}/share-tokens")
    suspend fun createShareToken(
        @Path("id") id: String,
        @Body body: ShareTokenCreateRequest,
    ): ShareToken

    /** Revoke a subscribe link. The .ics URL stops resolving; already-
     *  imported events on subscribers' devices are left untouched. */
    @DELETE("api/v1/calendars/{id}/share-tokens/{token}")
    suspend fun revokeShareToken(
        @Path("id") id: String,
        @Path("token") token: String,
    )

    // ---- Booking links (owner-managed scheduling pages) ----
    //
    // Bearer-auth, enveloped /api/v1 routes — same shape as the calendar
    // CRUD above. Each BookingLink carries a `publicUrl` (`<base>/book/
    // <slug>`) the owner shares; visitors book against it and the owner
    // sees the resulting appointments via .../bookings.

    /** List every booking link the active user owns (enabled + paused). */
    @GET("api/v1/booking-links")
    suspend fun bookingLinks(): List<BookingLink>

    /** Create a booking link. slug must match the server's regex
     *  (^[a-z0-9][a-z0-9-]{0,30}$); we validate before calling. Server
     *  replies 201 with the freshly-inserted row. */
    @POST("api/v1/booking-links")
    suspend fun createBookingLink(@Body body: BookingLinkCreateRequest): BookingLink

    /** Patch a booking link — any subset of fields. The per-link
     *  pause/resume toggle sends only `enabled`. Returns the updated row. */
    @PATCH("api/v1/booking-links/{id}")
    suspend fun updateBookingLink(
        @Path("id") id: String,
        @Body body: BookingLinkUpdateInput,
    ): BookingLink

    /** Delete a booking link. The public `/book/<slug>` page stops
     *  resolving; existing bookings are left on attendees' calendars.
     *  Envelope unwraps to `{ ok: true }`; show a confirm before calling. */
    @DELETE("api/v1/booking-links/{id}")
    suspend fun deleteBookingLink(@Path("id") id: String)

    /** List the confirmed appointments made through a booking link. */
    @GET("api/v1/booking-links/{id}/bookings")
    suspend fun bookings(@Path("id") id: String): List<Booking>

    @GET("api/v1/events")
    suspend fun events(
        @Query("from") from: String,
        @Query("to") to: String,
    ): EventsResponse

    @POST("api/v1/events")
    suspend fun createEvent(@Body body: EventCreateInput): EventDTO

    // Natural-language quick-add — server parses a phrase into event fields.
    // Requires server ≥ 1.6.4; older servers 404 (caller falls back to a blank
    // create form).
    @POST("api/v1/parse-event")
    suspend fun parseEvent(@Body body: ParseEventInput): ParseEventResult

    @PATCH("api/v1/events/{id}")
    suspend fun updateEvent(
        @Path("id") id: String,
        @Body body: EventUpdateInput,
    ): EventDTO

    /** Delete with optional scope + recurrenceId for recurring events.
     *  Server interprets a missing scope as "series" (delete the whole
     *  recurring series). When the user picks "仅此次" or "此后", we
     *  send the picked scope + the original occurrence's startsAt as
     *  recurrenceId so the server knows which instance is meant.
     *  DELETE has no body, so these go on the query string. */
    @DELETE("api/v1/events/{id}")
    suspend fun deleteEvent(
        @Path("id") id: String,
        @Query("scope") scope: String? = null,
        @Query("recurrenceId") recurrenceId: String? = null,
    )

    @GET("api/v1/events/{id}/attendees")
    suspend fun attendees(@Path("id") id: String): AttendeesResponse

    @POST("api/v1/events/{id}/attendees")
    suspend fun inviteAttendee(
        @Path("id") id: String,
        @Body body: AttendeeInviteRequest,
    )

    @retrofit2.http.HTTP(
        method = "DELETE",
        path = "api/v1/events/{id}/attendees",
        hasBody = true,
    )
    suspend fun revokeAttendee(
        @Path("id") id: String,
        @Body body: AttendeeRevokeRequest,
    )

    // ---- Native account management ----
    //
    // Bearer-auth endpoints that reply WITHOUT the data envelope (bare
    // `{ ok: true }` on success, 4xx + `{ error, message }` on failure).
    // We don't decode the success body; the caller only cares that no
    // HttpException was thrown. On 4xx the message is in the errorBody —
    // see serverErrorMessage() for extraction.

    /** Change password. newPassword must be ≥ 8 chars. On success the
     *  server invalidates every OTHER session/device but keeps THIS
     *  device's refresh token alive, so the APP keeps working. */
    @POST("api/v1/account/password")
    suspend fun changePassword(@Body body: ChangePasswordRequest)

    /** Permanently delete the account. `confirm` must exactly equal the
     *  server's literal phrase (see DeleteAccountRequest). On success
     *  the account + all sessions are gone — the APP must sign out and
     *  return to setup. */
    @POST("api/v1/account/delete")
    suspend fun deleteAccount(@Body body: DeleteAccountRequest)
}

class ApiClient private constructor(
    val baseUrl: String,
    private val store: ProfileStore,
    private val profileId: String,
) {
    val api: BywaveApi

    init {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BASIC
                    else HttpLoggingInterceptor.Level.NONE
        }
        val ok = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            // Order matters: envelope unwrap BEFORE the auth interceptor
            // sees the response, because the unwrap turns 200 responses
            // with `{ok: false, error}` into HTTP errors at the
            // interceptor level — which keeps the rest of the call
            // graph reading the natural data shape.
            .addInterceptor(EnvelopeInterceptor())
            .addInterceptor(AuthInterceptor(store, profileId, baseUrl))
            .addInterceptor(logging)
            .build()
        api = Retrofit.Builder()
            .baseUrl(if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/")
            .client(ok)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(BywaveApi::class.java)
    }

    companion object {
        @Volatile
        private var cache: MutableMap<String, ApiClient> = mutableMapOf()

        /** Return the client for the given profile id, creating a fresh
         *  one if the cached entry's baseUrl no longer matches (e.g.
         *  user edited the server URL). */
        @Synchronized
        fun forProfile(profile: Profile, store: ProfileStore): ApiClient {
            val cached = cache[profile.id]
            if (cached != null && cached.baseUrl == profile.serverUrl) return cached
            return ApiClient(profile.serverUrl, store, profile.id).also {
                cache[profile.id] = it
            }
        }

        /** For setup-time login + MFA verify, when we don't yet have
         *  a Profile to key against. Uses a transient throwaway client
         *  per call; OkHttp's global pool still reuses connections. */
        fun forSetup(serverUrl: String): BywaveApi {
            val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
            val ok = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                // Setup-time client doesn't carry the bearer interceptor
                // (we don't have a token yet) but the envelope unwrap is
                // still essential — every /api/v1/* response is wrapped.
                .addInterceptor(EnvelopeInterceptor())
                .build()
            return Retrofit.Builder()
                .baseUrl(if (serverUrl.endsWith("/")) serverUrl else "$serverUrl/")
                .client(ok)
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
                .create(BywaveApi::class.java)
        }

        /** Drop the cached client for the given profile (e.g. after
         *  remove or sign-out). Forces a rebuild on next access. */
        @Synchronized
        fun invalidate(profileId: String) {
            cache.remove(profileId)
        }

        @Synchronized
        fun reset() {
            cache.clear()
        }
    }
}

private class AuthInterceptor(
    private val store: ProfileStore,
    private val profileId: String,
    private val baseUrl: String,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        // Endpoints that AREN'T behind Bearer auth — we never send an
        // access token (because we don't have one yet) and never try
        // refresh on a 401 from them (because their 401 means real
        // credential failure, not "token expired").
        val path = original.url.encodedPath
        val isAuthEndpoint =
            path.contains("/auth/login-password") ||
            path.contains("/auth/login-mfa-verify") ||
            path.contains("/auth/refresh") ||
            path.contains("/devices/pair-claim")

        val firstReq = if (isAuthEndpoint) original
                       else original.withBearer(store.accessToken(profileId))
        val firstResp = chain.proceed(firstReq)
        if (firstResp.code != 401 || isAuthEndpoint) return firstResp
        firstResp.close()

        // Refresh path — read the profile's refresh token (might have
        // been rotated since this client was built), trade for a new
        // access token, retry once.
        val profile = store.profiles.value.firstOrNull { it.id == profileId }
        val rt = profile?.refreshToken ?: return chain.proceed(firstReq)
        val refreshed = runCatching { blockingRefresh(rt) }.getOrNull() ?: return chain.proceed(firstReq)
        store.setAccessToken(profileId, refreshed.accessToken)
        // Older server builds rotated the refresh token on use; current
        // /auth/refresh doesn't (it omits the field). Only persist when
        // the server actually returned a new one and it's different.
        val newRt = refreshed.refreshToken
        if (!newRt.isNullOrBlank() && newRt != rt) {
            store.updateRefreshToken(profileId, newRt)
        }
        return chain.proceed(original.withBearer(refreshed.accessToken))
    }

    private fun blockingRefresh(refreshToken: String): RefreshResponse {
        val api = ApiClient.forSetup(baseUrl)
        return kotlinx.coroutines.runBlocking { api.refresh(RefreshRequest(refreshToken)) }
    }

    private fun Request.withBearer(token: String?): Request {
        if (token.isNullOrEmpty()) return this
        return newBuilder().header("Authorization", "Bearer $token").build()
    }
}

/** Unwraps the server's `/api/v1/`-prefixed JSON envelope so route handlers
 *  can decode the natural data shape. Server format:
 *  - success:  `{ "ok": true, "data": <object|array|null|primitive> }`
 *  - error:    `{ "ok": false, "error": { "code": "...", "message": "..." } }`
 *
 *  We only run on `/api/v1/` paths to leave room for raw legacy `/api/`
 *  responses (e.g. `/api/version`) to pass through. Non-JSON responses
 *  (downloads, ICS) also pass through untouched.
 *
 *  On `ok: false`, we rewrite the response body to surface the error
 *  shape Retrofit's HttpException will pick up. We also coerce the
 *  status to 4xx if the server returned 200 with `ok: false`, which
 *  it does for in-band errors.
 *
 *  Avoids `/` `*` adjacency in this doc comment because Kotlin parses
 *  it as a nested block-comment opener inside KDoc. */
private class EnvelopeInterceptor : Interceptor {
    private val json = Json { ignoreUnknownKeys = true }

    override fun intercept(chain: Interceptor.Chain): Response {
        val resp = chain.proceed(chain.request())
        if (!resp.request.url.encodedPath.startsWith("/api/v1/")) return resp
        val contentType = resp.header("Content-Type") ?: return resp
        if (!contentType.contains("json", ignoreCase = true)) return resp
        val body = resp.body ?: return resp
        // Buffer the whole body — fine for our JSON sizes (KB-scale).
        val raw = body.string()
        val parsed = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
            ?: return resp.rebody(raw, contentType)
        val okVal = parsed["ok"]
        val okBool = runCatching { okVal?.jsonPrimitive?.boolean }.getOrNull()
            ?: return resp.rebody(raw, contentType)  // not enveloped — pass through
        if (okBool) {
            // Replace body with just the `data` payload (string-serialized).
            // `data` can be an object, array, primitive, or null — handle each.
            val data = parsed["data"]
            val newBody = data?.toString() ?: "null"
            return resp.rebody(newBody, contentType)
        }
        // ok=false. Surface as HTTP 400 with the inner error object so
        // Retrofit raises HttpException and the caller gets an actionable
        // status code. If the original status was already an error we
        // preserve it.
        val error = parsed["error"]?.toString() ?: """{"code":"unknown","message":""}"""
        val newCode = if (resp.code in 200..299) 400 else resp.code
        return resp.newBuilder()
            .code(newCode)
            .body(error.toResponseBody(contentType.toMediaTypeOrNull()))
            .build()
    }

    private fun Response.rebody(text: String, contentType: String): Response =
        newBuilder().body(text.toResponseBody(contentType.toMediaTypeOrNull())).build()
}

/** Pull the server's human-readable error out of a thrown exception so
 *  the UI can show an actionable inline message instead of a raw
 *  "HTTP 401" or stack trace. Native account endpoints reply with a
 *  `{ "error": code, "message": text }` body on 4xx; the enveloped
 *  /api/v1 routes surface `{ "code": ..., "message": ... }`. We read
 *  the HttpException's errorBody and dig out `message`, falling back to
 *  the exception's own message (e.g. for network/timeout failures).
 *
 *  Returns null only when there's truly nothing useful — callers should
 *  pair with their own localized fallback string. */
fun serverErrorMessage(e: Throwable): String? {
    val http = e as? retrofit2.HttpException
    if (http != null) {
        val raw = runCatching { http.response()?.errorBody()?.string() }.getOrNull()
        if (!raw.isNullOrBlank()) {
            val json = Json { ignoreUnknownKeys = true }
            val obj = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
            val msg = runCatching { obj?.get("message")?.jsonPrimitive?.content }.getOrNull()
            if (!msg.isNullOrBlank()) return msg
        }
    }
    return e.localizedMessage
}
