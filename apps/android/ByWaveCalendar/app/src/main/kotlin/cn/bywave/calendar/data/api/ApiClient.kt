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
import cn.bywave.calendar.data.model.EventCreateInput
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.EventUpdateInput
import cn.bywave.calendar.data.model.EventsResponse
import cn.bywave.calendar.data.model.LoginRequest
import cn.bywave.calendar.data.model.LoginResponse
import cn.bywave.calendar.data.model.MfaVerifyRequest
import cn.bywave.calendar.data.model.RefreshRequest
import cn.bywave.calendar.data.model.RefreshResponse
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
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
    @POST("api/v1/auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("api/v1/auth/mfa")
    suspend fun verifyMfa(@Body body: MfaVerifyRequest): LoginResponse

    @POST("api/v1/auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): RefreshResponse

    @GET("api/v1/events")
    suspend fun events(
        @Query("from") from: String,
        @Query("to") to: String,
    ): EventsResponse

    @POST("api/v1/events")
    suspend fun createEvent(@Body body: EventCreateInput): EventDTO

    @PATCH("api/v1/events/{id}")
    suspend fun updateEvent(
        @Path("id") id: String,
        @Body body: EventUpdateInput,
    ): EventDTO

    @DELETE("api/v1/events/{id}")
    suspend fun deleteEvent(@Path("id") id: String)

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
        val isAuthEndpoint =
            original.url.encodedPath.contains("/auth/login") ||
            original.url.encodedPath.contains("/auth/refresh") ||
            original.url.encodedPath.contains("/auth/mfa")

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
        // Server rotates refresh tokens on use — persist the new one.
        if (refreshed.refreshToken != rt) {
            store.updateRefreshToken(profileId, refreshed.refreshToken)
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
