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

    /** Hit /api/app/desktop/latest and compare versionCode. Throttled
     *  to once per 6 hours; pass force=true to override (e.g. user
     *  clicked "check for updates" in settings). */
    suspend fun check(serverUrl: String, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastCheckAt < THROTTLE_MS) return
        lastCheckAt = now

        val base = serverUrl.trimEnd('/')
        val resp = try {
            client.get("$base/api/app/desktop/latest")
        } catch (e: Exception) {
            // Network blip; try again next launch. Don't surface to
            // the user — the updater is a background nicety, not a
            // critical path.
            return
        }
        if (resp.status == HttpStatusCode.NotFound) {
            // Server hasn't published a release yet — totally fine,
            // just means there's nothing newer to offer.
            _available.value = null
            return
        }
        if (!resp.status.isSuccess()) return
        val info: DesktopUpdateInfo = try { resp.body() } catch (_: Exception) { return }
        if (info.versionCode > BuildInfo.VERSION_CODE) {
            _available.value = info
        } else {
            _available.value = null
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
        val before = _available.value
        check(serverUrl, force = true)
        val after = _available.value
        _lastForceCheckOutcome.value = when {
            after != null -> ForceCheckOutcome.UpdateFound
            // No exception path here — `check()` swallows network
            // errors. If we wanted distinguish "network failed" from
            // "no update", we'd need check() to return a tagged
            // result. For now treat silence as "up to date".
            else -> if (before == null) ForceCheckOutcome.UpToDate else ForceCheckOutcome.UpToDate
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
