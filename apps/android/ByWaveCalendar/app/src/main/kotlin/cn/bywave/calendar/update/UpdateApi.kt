// Tiny Retrofit service for /api/app/android/latest. Deliberately
// separate from BywaveApi because:
//   - it's unauthenticated (the endpoint is public — anyone with the
//     server URL can poll it, which is fine since the APK itself is
//     downloadable),
//   - it works against any active profile's server (we hit the
//     server the user is logged into; future: also poll a "fleet"
//     URL if running multi-server),
//   - keeping it isolated means a 5xx on /api/app/android/latest
//     can never break a CalendarViewModel reload.

package cn.bywave.calendar.update

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
// Retrofit 2.11+ official kotlinx-serialization converter package.
// Same as data/api/ApiClient.kt — both rely on the asConverterFactory
// extension function this jar exports.
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.GET
import retrofit2.http.Url
import java.util.concurrent.TimeUnit

@Serializable
data class AndroidReleaseDto(
    @SerialName("versionCode") val versionCode: Int,
    @SerialName("versionName") val versionName: String,
    @SerialName("url") val url: String,
    @SerialName("sha256") val sha256: String = "",
    @SerialName("sizeBytes") val sizeBytes: Long = 0,
    @SerialName("releasedAt") val releasedAt: String = "",
    @SerialName("notes") val notes: String = "",
    @SerialName("mandatory") val mandatory: Boolean = false,
    @SerialName("minSupportedVersionCode") val minSupportedVersionCode: Int = 1,
)

interface UpdateApi {
    @GET("api/app/android/latest")
    suspend fun latest(): AndroidReleaseDto

    /** Fetch a manifest from an absolute URL (overrides baseUrl). Used for
     *  the canonical GitHub-raw fallback so a user whose own server hasn't
     *  been re-deployed lately still has a path to discover updates —
     *  mirrors the desktop client's UpdateChecker fallback. */
    @GET
    suspend fun fetchManifest(@Url url: String): AndroidReleaseDto
}

internal object UpdateApiFactory {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    fun create(baseUrl: String): UpdateApi {
        val ok = OkHttpClient.Builder()
            // Short timeouts — this poll runs on every resume, we'd rather
            // give up fast and try again next time than hang the UI thread
            // waiting on a flaky network.
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
        return Retrofit.Builder()
            .baseUrl(if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/")
            .client(ok)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(UpdateApi::class.java)
    }
}
