// In-app update checker. Polls /api/app/desktop/latest on the user's
// own server (whichever they're paired to) — same endpoint Android +
// iOS use the equivalent of, so server-side ops are unified.
//
// Anonymous endpoint (no Bearer needed), so we can hit it as soon as
// the app has a serverUrl, even before bearer-auth is established.
// 6-hour throttle in-process so we don't pelt the server during a
// long session; also runs at app start.
//
// Update install model: simple "download in browser" — we open the
// .dmg / .msi URL via Desktop.browse. Future v0.8+ could in-app
// download + auto-relaunch via JNA on macOS, but that's a lot of
// platform-specific machinery for marginal UX gain over the manual
// flow (mount DMG → drag to Applications is muscle-memory for Mac
// users; double-click MSI is the same for Windows).

package cn.bywave.calendar.desktop.data.update

import cn.bywave.calendar.desktop.BuildInfo
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

    private var lastCheckAt: Long = 0L
    private val THROTTLE_MS = 6L * 60 * 60 * 1000   // 6 hours

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

    /** Hit /api/app/desktop/latest and compare versionCode. If the
     *  user's server check fails OR returns a versionCode that's not
     *  newer than the running build, ALSO try the canonical GitHub raw
     *  manifest as a fallback. Throttled to once per 6 hours; pass
     *  force=true to override (e.g. user clicked "check for updates"
     *  in settings). */
    /** Outcome of a check: an update is available, we're confirmed
     *  up-to-date (reached ≥1 manifest source, nothing newer), or we
     *  couldn't reach ANY source. The last case must NEVER be surfaced
     *  to the user as 「已是最新版本」 — that's the bug this type fixes. */
    enum class CheckResult { UpdateAvailable, UpToDate, Unreachable }

    suspend fun check(serverUrl: String, force: Boolean = false): CheckResult {
        val now = System.currentTimeMillis()
        if (!force && now - lastCheckAt < THROTTLE_MS) return CheckResult.UpToDate
        lastCheckAt = now

        // 1) Primary: user's own ByWave server.
        val fromServer = fetchManifest("${serverUrl.trimEnd('/')}/api/app/desktop/latest", "server")
        if (fromServer != null && fromServer.versionCode > BuildInfo.VERSION_CODE) {
            _available.value = fromServer
            System.err.println("[ByWave Updater] update found via server: v${fromServer.versionName} (code ${fromServer.versionCode})")
            return CheckResult.UpdateAvailable
        }

        // 2) Fallback: GitHub raw manifest. We try this on EVERY check
        //    (not just when server returns nothing) because a stale
        //    server can hand back an older manifest and lock users out
        //    of newer releases. The fallback is well-behaved when the
        //    user is offline — fetchManifest returns null silently.
        val fromGithub = fetchManifest(GITHUB_MANIFEST_URL, "github")
        if (fromGithub != null && fromGithub.versionCode > BuildInfo.VERSION_CODE) {
            _available.value = fromGithub
            System.err.println("[ByWave Updater] update found via github fallback: v${fromGithub.versionName} (code ${fromGithub.versionCode})")
            return CheckResult.UpdateAvailable
        }

        // Clear any previously-surfaced prompt (e.g. a stale "0.7.3 → 0.7.4").
        _available.value = null
        // fetchManifest returns null for BOTH a network error AND a legit 404.
        // So if NEITHER source yielded a manifest we CANNOT confirm we're
        // current — report a check FAILURE rather than falsely claim
        // 「已是最新版本」. Only when ≥1 source actually answered is it truly latest.
        val reached = fromServer != null || fromGithub != null
        System.err.println("[ByWave Updater] ${if (reached) "up to date" else "UNREACHABLE"} — server=${fromServer?.versionCode ?: "null"}, github=${fromGithub?.versionCode ?: "null"}, running ${BuildInfo.VERSION_CODE}")
        return if (reached) CheckResult.UpToDate else CheckResult.Unreachable
    }

    /** Fetch + parse manifest from one source. Returns null on network
     *  error / non-2xx / JSON parse fail. Logs the failure reason for
     *  debugging (visible in Console.app on macOS, stderr elsewhere). */
    private suspend fun fetchManifest(url: String, sourceTag: String): DesktopUpdateInfo? {
        val resp = try {
            client.get(url)
        } catch (e: Exception) {
            System.err.println("[ByWave Updater] $sourceTag fetch failed: ${e::class.simpleName}: ${e.message}")
            return null
        }
        if (resp.status == HttpStatusCode.NotFound) {
            // 404 is a legitimate "no release yet" answer from the
            // user's server. We don't log it (would spam stderr on
            // every check) but still try the next source.
            return null
        }
        if (!resp.status.isSuccess()) {
            System.err.println("[ByWave Updater] $sourceTag returned ${resp.status}")
            return null
        }
        return try {
            resp.body<DesktopUpdateInfo>()
        } catch (e: Exception) {
            System.err.println("[ByWave Updater] $sourceTag JSON parse failed: ${e::class.simpleName}: ${e.message}")
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
        _lastForceCheckOutcome.value = when (check(serverUrl, force = true)) {
            CheckResult.UpdateAvailable -> ForceCheckOutcome.UpdateFound
            CheckResult.UpToDate -> ForceCheckOutcome.UpToDate
            CheckResult.Unreachable -> ForceCheckOutcome.Error(
                cn.bywave.calendar.desktop.i18n.I18n.t("update.check.unreachable"),
            )
        }
    }

    private fun detectPlatform(): String? {
        val os = System.getProperty("os.name").orEmpty().lowercase()
        return when {
            os.contains("mac") || os.contains("darwin") -> "mac"
            os.contains("win") -> "win"
            os.contains("nux") || os.contains("nix") || os.contains("aix") -> "linux"
            else -> null
        }
    }
}
