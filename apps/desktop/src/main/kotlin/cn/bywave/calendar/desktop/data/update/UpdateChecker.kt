package cn.bywave.calendar.desktop.data.update

import cn.bywave.calendar.update.ReleaseLookup
import kotlinx.coroutines.CancellationException
import java.net.URI
import cn.bywave.calendar.desktop.BuildInfo
import cn.bywave.calendar.desktop.util.DebugLog
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class DesktopUpdateAsset(
    val url: String,
    val sha256: String = "",
    val sizeBytes: Long = 0,
)

@Serializable
data class DesktopUpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val releasedAt: String = "",
    val notes: String = "",
    val mandatory: Boolean = false,
    /** Keyed by "mac" / "win" / "linux". Server may return only the
     *  platforms it has assets for. */
    val assets: Map<String, DesktopUpdateAsset> = emptyMap(),
)

object UpdateChecker {
    /** Current desktop's platform key — matches the manifest's `assets`
     *  map keys. Use this to pick the right download URL on the user's
     *  OS. Returns null when we can't classify (very rare). */
    val platform: String? = detectPlatform()

    private val _available = MutableStateFlow<DesktopUpdateInfo?>(null)
    val available: StateFlow<DesktopUpdateInfo?> = _available.asStateFlow()

    private val lookup = ReleaseLookup<DesktopUpdateInfo>({ it.versionCode }, { validManifest(it, platform) })
    private var requestedServer: String? = null

    private val client: HttpClient by lazy {
        HttpClient(CIO) {
            install(ContentNegotiation) {
                json(Json {
                    ignoreUnknownKeys = true
                    explicitNulls = false
                })
            }
            install(HttpTimeout) {
                connectTimeoutMillis = 10_000
                requestTimeoutMillis = 15_000
            }
            expectSuccess = false
        }
    }

    /** Stable GitHub raw URL for the canonical manifest. Used as a
     *  fallback when the user's server endpoint fails or returns no
     *  newer version. Without this, a user whose server hasn't been
     *  re-deployed lately (or whose proxy / TLS chain is misbehaving)
     *  has no path to an update — they'd have to manually visit the
     *  GitHub Releases page. v0.7.6+ silently falls through here.
     *
     *  Gitee mirror is a future-friendly option for users behind GFW;
     *  for now GitHub's raw.githubusercontent.com is reliable enough. */
    private const val GITHUB_MANIFEST_URL =
        "https://raw.githubusercontent.com/wuha-like-sleep/by-wave-calendar/main/apps/desktop/releases/latest.json"

    /** Compare both sources; successful checks are cached for six hours, failures for one minute. */
    /** Outcome of a check: an update is available, we're confirmed
     *  up-to-date (reached ≥1 manifest source, nothing newer), or we
     *  couldn't reach ANY source. The last case must NEVER be surfaced
     *  to the user as 「已是最新版本」 — that's the bug this type fixes. */
    enum class CheckResult { UpdateAvailable, UpToDate, Unreachable }

    suspend fun check(serverUrl: String, force: Boolean = false): CheckResult {
        val server = serverUrl.trimEnd('/')
        requestedServer = server
        val result = lookup.check(server, force, listOf(
            { fetchManifest("$server/api/app/desktop/latest", "server") },
            { fetchManifest(GITHUB_MANIFEST_URL, "github") },
        ))
        if (requestedServer != server) return CheckResult.Unreachable
        val release = result.release ?: return CheckResult.Unreachable
        if (release.versionCode > BuildInfo.VERSION_CODE) {
            if (result.fresh || force) _available.value = release
            return CheckResult.UpdateAvailable
        }
        _available.value = null
        return CheckResult.UpToDate
    }

    internal fun validManifest(info: DesktopUpdateInfo, platform: String?): Boolean {
        if (info.versionCode <= 0 || info.versionName.isBlank()) return false
        val asset = info.assets[platform] ?: return false
        val suffix = when (platform) { "mac", "macIntel" -> ".dmg"; "win" -> ".msi"; "linux" -> ".deb"; else -> return false }
        val uri = runCatching { URI(asset.url) }.getOrNull() ?: return false
        return uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.fragment == null &&
            uri.path.orEmpty().lowercase().endsWith(suffix) && asset.sizeBytes in 1..1_073_741_824L &&
            asset.sha256.matches(Regex("[a-fA-F0-9]{64}"))
    }

    /** Fetch + parse manifest from one source. Returns null on network
     *  error / non-2xx / JSON parse fail. Logs the failure reason for
     *  debugging (visible in Console.app on macOS, stderr elsewhere). */
    private suspend fun fetchManifest(url: String, sourceTag: String): DesktopUpdateInfo? {
        val resp = try {
            client.get(url)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DebugLog.d("ByWave Updater") { "$sourceTag fetch failed: ${e::class.simpleName}: ${e.message}" }
            return null
        }
        if (resp.status == HttpStatusCode.NotFound) {
            // 404 is a legitimate "no release yet" answer from the
            // user's server. We don't log it (would spam stderr on
            // every check) but still try the next source.
            return null
        }
        if (!resp.status.isSuccess()) {
            DebugLog.d("ByWave Updater") { "$sourceTag returned ${resp.status}" }
            return null
        }
        return try {
            resp.body<DesktopUpdateInfo>()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DebugLog.d("ByWave Updater") { "$sourceTag JSON parse failed: ${e::class.simpleName}: ${e.message}" }
            null
        }
    }

    /** Dismiss the prompt for this session. Re-shows on next launch
     *  or after THROTTLE_MS elapses + check fires again. */
    fun dismiss() {
        _available.value = null
    }

    /** Distinct state for "user clicked check, nothing newer" so the
     *  MenuBar action can show a "已是最新版本" toast instead of
     *  silently doing nothing. Reset by the next available update. */
    private val _lastForceCheckOutcome = MutableStateFlow<ForceCheckOutcome>(ForceCheckOutcome.Idle)
    val lastForceCheckOutcome: StateFlow<ForceCheckOutcome> = _lastForceCheckOutcome.asStateFlow()

    sealed class ForceCheckOutcome {
        object Idle : ForceCheckOutcome()
        object Checking : ForceCheckOutcome()
        object UpToDate : ForceCheckOutcome()
        object UpdateFound : ForceCheckOutcome()
        data class Error(val message: String) : ForceCheckOutcome()
    }

    /** User-triggered "check now" — bypasses the 6h throttle and
     *  surfaces the outcome via [lastForceCheckOutcome] so the UI
     *  can show a transient confirmation/error chip. */
    suspend fun forceCheck(serverUrl: String) {
        _lastForceCheckOutcome.value = ForceCheckOutcome.Checking
        // check() now returns a tagged result, so we can tell a genuine
        // "already latest" apart from "couldn't reach any update source"
        // (network down / server + GitHub both unreachable). The latter shows
        // an error instead of falsely reassuring the user they're up to date.
        try {
            _lastForceCheckOutcome.value = when (check(serverUrl, force = true)) {
                CheckResult.UpdateAvailable -> ForceCheckOutcome.UpdateFound
                CheckResult.UpToDate -> ForceCheckOutcome.UpToDate
                CheckResult.Unreachable -> ForceCheckOutcome.Error(
                    cn.bywave.calendar.desktop.i18n.I18n.t("update.check.unreachable"),
                )
            }
        } catch (e: CancellationException) {
            _lastForceCheckOutcome.value = ForceCheckOutcome.Idle
            throw e
        }
    }

    internal fun detectPlatform(osName: String = System.getProperty("os.name").orEmpty(),
                                architecture: String = System.getProperty("os.arch").orEmpty()): String? {
        val os = osName.lowercase()
        val arch = architecture.lowercase()
        return when {
            os.contains("mac") || os.contains("darwin") -> when (arch) {
                "aarch64", "arm64" -> "mac"
                "x86_64", "amd64", "x64" -> "macIntel"
                else -> null
            }
            os.contains("win") -> "win"
            os.contains("nux") || os.contains("nix") || os.contains("aix") -> "linux"
            else -> null
        }
    }
}
