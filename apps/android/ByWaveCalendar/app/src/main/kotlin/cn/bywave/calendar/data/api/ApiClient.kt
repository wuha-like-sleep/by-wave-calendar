// Retrofit-based API client. Mirrors iOS APIClient.swift.
//
// Design:
//   - Single OkHttpClient with a logging interceptor (gated to BuildConfig.DEBUG)
//   - AuthInterceptor injects Bearer + handles 401 → refresh → retry once
//   - JSON via kotlinx.serialization (ignoreUnknownKeys = true so server
//     can add fields without breaking client; the iOS side likewise
//     tolerates unknown extras)
//   - Base URL is dynamic per-server, set via ApiClient(serverUrl).
//     Retrofit needs a final URL at builder time, so we recreate the
//     client when the user switches servers.

package cn.bywave.calendar.data.api

import cn.bywave.calendar.BuildConfig
import cn.bywave.calendar.data.auth.TokenStore
import cn.bywave.calendar.data.model.EventsResponse
import cn.bywave.calendar.data.model.LoginRequest
import cn.bywave.calendar.data.model.LoginResponse
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
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

interface BywaveApi {
    @POST("api/v1/auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("api/v1/auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): RefreshResponse

    @GET("api/v1/events")
    suspend fun events(
        @Query("from") from: String,
        @Query("to") to: String,
    ): EventsResponse
}

class ApiClient private constructor(
    val baseUrl: String,
    private val tokens: TokenStore,
) {
    val api: BywaveApi

    init {
        val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false  // Don't serialize nulls — server treats
                                    // missing key as "leave unchanged" on PATCH.
        }

        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BASIC
                    else HttpLoggingInterceptor.Level.NONE
        }

        val ok = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(AuthInterceptor(tokens, baseUrl))
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
        /** Construct or return the cached client for this server URL.
         *  We cache so OkHttp's connection pool / DNS cache get reused
         *  across screens; rebuilding per-request would defeat HTTP/2 keepalive. */
        @Volatile
        private var cached: ApiClient? = null

        fun forServer(url: String, tokens: TokenStore): ApiClient {
            val existing = cached
            if (existing != null && existing.baseUrl == url) return existing
            return ApiClient(url, tokens).also { cached = it }
        }

        fun reset() { cached = null }
    }
}

/**
 * Adds `Authorization: Bearer <accessToken>`, transparently refreshes
 * on 401, and retries the original request once. Mirror of the iOS
 * APIClient's chained-request logic.
 */
private class AuthInterceptor(
    private val tokens: TokenStore,
    private val baseUrl: String,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()

        // Skip auth on the login + refresh endpoints themselves — they
        // don't accept Bearer and would loop forever otherwise.
        val isAuthEndpoint =
            original.url.encodedPath.contains("/auth/login") ||
            original.url.encodedPath.contains("/auth/refresh")

        val firstReq = if (isAuthEndpoint) original
                       else original.withBearer(tokens.accessToken)
        val firstResp = chain.proceed(firstReq)

        if (firstResp.code != 401 || isAuthEndpoint) return firstResp
        firstResp.close()

        // 401 path: try to mint a fresh access token from the stored
        // refresh token. If that fails (refresh expired / revoked), we
        // let the 401 bubble up — the ViewModel layer surfaces "please
        // sign in again".
        val rt = tokens.refreshToken ?: return chain.proceed(firstReq)
        val newAccess = runCatching { blockingRefresh(rt) }.getOrNull() ?: return chain.proceed(firstReq)
        tokens.accessToken = newAccess.accessToken
        tokens.refreshToken = newAccess.refreshToken

        return chain.proceed(original.withBearer(newAccess.accessToken))
    }

    /** Synchronous refresh — we're already on OkHttp's dispatcher thread
     *  in the interceptor, so blocking here is fine. Bypasses Retrofit's
     *  suspend pipeline to avoid bootstrapping a coroutine inside the
     *  interceptor. */
    private fun blockingRefresh(refreshToken: String): RefreshResponse {
        val tempApi = ApiClient.forServer(baseUrl, tokens).api
        return kotlinx.coroutines.runBlocking { tempApi.refresh(RefreshRequest(refreshToken)) }
    }

    private fun Request.withBearer(token: String?): Request {
        if (token.isNullOrEmpty()) return this
        return newBuilder().header("Authorization", "Bearer $token").build()
    }
}
