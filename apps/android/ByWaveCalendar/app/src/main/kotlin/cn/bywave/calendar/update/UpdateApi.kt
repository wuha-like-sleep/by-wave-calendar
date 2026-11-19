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
    /** Second source for the same APK (e.g. the upstream release page
     *  when the primary is the user's own server). The server API sends
     *  it when it has one; the committed GitHub manifest doesn't carry
     *  it, so it defaults to "" = no fallback. ApkDownloader tries it
     *  when the primary fails — same size + sha256 must still match.
     *  Declared last on purpose: several call sites build this DTO
     *  positionally, and a mid-list insertion would silently rebind
     *  their arguments. */
    @SerialName("fallbackUrl") val fallbackUrl: String = "",
    /** Third source (mirror, e.g. Gitee), tried only after BOTH the
     *  primary and the fallback fail. Same contract as fallbackUrl:
     *  "" = none, unusable values are skipped by the downloader, and
     *  the sha256/size gate applies unchanged. Also appended last. */
    @SerialName("mirrorUrl") val mirrorUrl: String = "",
    /** Staged-rollout percentage for this release (0–100). Absent in
     *  older manifests → 100 = everyone. UpdateChecker applies the
     *  shared Rollout bucket rule locally, because the GitHub-manifest
     *  path never passes through the server's gate. */
    @SerialName("rolloutPercent") val rolloutPercent: Int = 100,
    /** Days of grace before a forced upgrade turns hard: within the
     *  grace window the prompt stays dismissible, after it the sheet
     *  becomes non-dismissible. Absent → 7. Same field, same meaning
     *  as the desktop client — one definition in shared Rollout. */
    @SerialName("graceDays") val graceDays: Int = 7,
)

interface UpdateApi {
    /** deviceId + currentVersionCode let the server apply the staged
     *  rollout gate (and its recall exemption for installs below the
     *  minimum supported version). Both are optional server-side: an
     *  old server ignores unknown query params, a missing deviceId is
     *  treated as "not a rollout subject". */
    @GET("api/app/android/latest")
    suspend fun latest(
        @retrofit2.http.Query("deviceId") deviceId: String,
        @retrofit2.http.Query("currentVersionCode") currentVersionCode: Int,
    ): AndroidReleaseDto

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
