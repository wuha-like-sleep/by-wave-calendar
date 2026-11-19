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
    /** Second source for the same installer (e.g. the upstream
     *  release page when the primary is the user's own server). ""
     *  when the source has none — the committed GitHub manifest
     *  doesn't carry it. Declared last: call sites build this
     *  positionally. */
    val fallbackUrl: String = "",
    /** Third source (mirror, e.g. Gitee), tried only after both the
     *  primary and the fallback fail. Same contract as fallbackUrl.
     *  Also appended last. */
    val mirrorUrl: String = "",
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
    /** Builds older than this must update — the Android manifest has
     *  carried the field from the start; the desktop chain (server
     *  parser → API → here) only learned it later, so manifests
     *  without it deserialize as 1 = no floor. */
    val minSupportedVersionCode: Int = 1,
    /** Staged-rollout percentage (0–100). Absent in older manifests
     *  → 100 = everyone. Applied locally with the shared Rollout
     *  rule, because the GitHub-manifest source never passes through
     *  the server's gate. Appended last, like the fields above. */
    val rolloutPercent: Int = 100,
    /** Days of grace before a forced upgrade turns hard. Same field,
     *  same meaning as Android — one definition in shared Rollout. */
    val graceDays: Int = 7,
    /** Set by UpdateChecker when a forced upgrade is still inside
     *  its grace window: the dialog stays dismissible but shows this
     *  deadline. Never serialized — it's computed per check. */
    @kotlinx.serialization.Transient
    val graceDeadlineMillis: Long? = null,
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

    suspend fun check(serverUrl: String, deviceId: String? = null, force: Boolean = false): CheckResult {
        val server = serverUrl.trimEnd('/')
        requestedServer = server
        // deviceId + currentVersionCode let the server apply its
        // rollout gate (and the recall exemption). The GitHub source
        // takes no params — the local gate below covers that path.
        val serverLatest = buildString {
            append(server).append("/api/app/desktop/latest")
            if (!deviceId.isNullOrBlank()) {
                append("?deviceId=").append(java.net.URLEncoder.encode(deviceId, "UTF-8"))
                append("&currentVersionCode=").append(BuildInfo.VERSION_CODE)
            }
        }
        val result = lookup.check(server, force, listOf(
            { fetchManifest(serverLatest, "server") },
            { fetchManifest(GITHUB_MANIFEST_URL, "github") },
        ))
        if (requestedServer != server) return CheckResult.Unreachable
        val release = result.release ?: return CheckResult.Unreachable
        if (release.versionCode > BuildInfo.VERSION_CODE) {
            // Staged rollout, applied locally with the SAME rule the
            // server uses (shared Rollout): the GitHub manifest merged
            // in above never passed through the server's gate. Not in
            // the rollout = no update exists for this machine yet.
            if (!cn.bywave.calendar.update.Rollout.isInRollout(
                    deviceId = deviceId, platform = "desktop",
                    versionCode = release.versionCode, rolloutPercent = release.rolloutPercent,
                    currentVersionCode = BuildInfo.VERSION_CODE,
                    minSupportedVersionCode = release.minSupportedVersionCode,
                )
            ) {
                _available.value = null
                return CheckResult.UpToDate
            }
            // Below the minimum supported version counts as a forced
            // upgrade even when the release itself isn't flagged —
            // that's the point of the floor (retroactively recalling
            // a bad build), same rule the Android checker applies.
            // "Forced" then splits by the grace window (shared
            // Rollout.forceState): inside grace the dialog stays
            // dismissible and carries the deadline; past it, the
            // emitted info is mandatory.
            val hitForce = release.mandatory || BuildInfo.VERSION_CODE < release.minSupportedVersionCode
            val firstSeen = UpdateFirstSeenStore.firstSeenMillis(release.versionCode)
            val forceState = cn.bywave.calendar.update.Rollout.forceState(
                hitForce = hitForce, firstSeenMillis = firstSeen,
                graceDays = release.graceDays, nowMillis = System.currentTimeMillis(),
            )
            val effective = when (forceState) {
                cn.bywave.calendar.update.Rollout.ForceState.FORCED ->
                    release.copy(mandatory = true)
                cn.bywave.calendar.update.Rollout.ForceState.IN_GRACE ->
                    release.copy(
                        mandatory = false,
                        graceDeadlineMillis = cn.bywave.calendar.update.Rollout
                            .graceDeadlineMillis(firstSeen, release.graceDays),
                    )
                cn.bywave.calendar.update.Rollout.ForceState.NOT_FORCED -> release
            }
            if (result.fresh || force) _available.value = effective
            return CheckResult.UpdateAvailable
        }
        _available.value = null
        return CheckResult.UpToDate
    }

    internal fun validManifest(info: DesktopUpdateInfo, platform: String?): Boolean {
        if (info.versionCode <= 0 || info.versionName.isBlank()) return false
        // Same bound the Android policy enforces: a floor outside
        // 1..versionCode is a malformed manifest, not a strong floor.
        if (info.minSupportedVersionCode !in 1..info.versionCode) return false
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
    suspend fun forceCheck(serverUrl: String, deviceId: String? = null) {
        _lastForceCheckOutcome.value = ForceCheckOutcome.Checking
        // check() now returns a tagged result, so we can tell a genuine
        // "already latest" apart from "couldn't reach any update source"
        // (network down / server + GitHub both unreachable). The latter shows
        // an error instead of falsely reassuring the user they're up to date.
        try {
            _lastForceCheckOutcome.value = when (check(serverUrl, deviceId, force = true)) {
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
