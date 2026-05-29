// Decides whether to surface an update sheet on the next opportunity.
//
// Called from MainActivity.onResume, but throttled to once every 6 hours
// per app process — we don't want to hit the server every time the user
// alt-tabs back to the calendar. The "last checked" timestamp lives in
// memory only; cold launch always checks fresh.
//
// When there's no active profile (cold install, signed out), we skip —
// without a logged-in server we don't know where /api/app/android/latest
// even lives.

package cn.bywave.calendar.update

import android.content.Context
import android.content.pm.PackageManager
import cn.bywave.calendar.BywaveApp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed class UpdateState {
    object Idle : UpdateState()
    data class Available(val release: AndroidReleaseDto, val mandatory: Boolean) : UpdateState()
    /** User dismissed the prompt. Don't re-show until the next cold
     *  launch or until a NEW versionCode arrives. */
    data class Dismissed(val versionCode: Int) : UpdateState()
}

/** Outcome surfaced to UI when the user explicitly hits "检查更新".
 *  Distinct from UpdateState because the user-initiated path wants
 *  per-attempt feedback even when the auto-poll state hasn't changed
 *  (e.g. "no update available" silently leaves state Idle). */
sealed class UserCheckResult {
    object UpToDate : UserCheckResult()
    object UpdateFound : UserCheckResult()
    data class Failed(val message: String) : UserCheckResult()
    /** No active profile / no server URL — can't probe anywhere. */
    object NotSignedIn : UserCheckResult()
}

object UpdateChecker {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    private var lastCheckMs: Long = 0
    private const val THROTTLE_MS: Long = 6 * 60 * 60 * 1000L  // 6h

    /** Canonical manifest on GitHub raw. Fallback when the user's own
     *  server returns nothing newer (or is unreachable) — a server that
     *  hasn't been re-deployed since the last release would otherwise lock
     *  users out of newer APKs. Same role as the desktop client's fallback. */
    private const val GITHUB_MANIFEST_URL =
        "https://raw.githubusercontent.com/wuha-like-sleep/by-wave-calendar/main/apps/android/releases/latest.json"

    /** Force a check on the next call regardless of throttle. Used by
     *  the "立即检查更新" button in Settings. */
    fun resetThrottle() { lastCheckMs = 0 }

    suspend fun checkIfDue(context: Context, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastCheckMs < THROTTLE_MS) return
        lastCheckMs = now
        runCatching { doCheck(context) }
    }

    /** Explicit user-initiated check from Settings → 检查更新. Always
     *  bypasses throttle and ALWAYS returns a result the UI can render
     *  as feedback ("已是最新" / "发现新版本" / "检查失败 …"). State
     *  side-effects still happen (Available flips on, etc.) but the
     *  returned value drives the immediate snackbar. */
    suspend fun checkNow(context: Context): UserCheckResult {
        lastCheckMs = System.currentTimeMillis()
        val profile = BywaveApp.instance.profiles.active()
            ?: return UserCheckResult.NotSignedIn
        return try {
            val newer = doCheck(context, profileServerUrlOverride = profile.serverUrl)
            if (newer) UserCheckResult.UpdateFound else UserCheckResult.UpToDate
        } catch (e: retrofit2.HttpException) {
            if (e.code() == 404) {
                // 404 = no release published. Treat as up-to-date —
                // there's nothing newer to install.
                UserCheckResult.UpToDate
            } else {
                UserCheckResult.Failed("服务器返回 ${e.code()}")
            }
        } catch (e: Exception) {
            UserCheckResult.Failed(e.localizedMessage ?: "网络异常")
        }
    }

    /** @return true if a newer (or unsupported-blocking) version was
     *  found and Available state was set, false otherwise. */
    private suspend fun doCheck(
        context: Context,
        profileServerUrlOverride: String? = null,
    ): Boolean {
        val baseUrl = profileServerUrlOverride
            ?: BywaveApp.instance.profiles.active()?.serverUrl
            ?: return false
        val api = UpdateApiFactory.create(baseUrl)
        val localVersionCode = localVersionCode(context)

        // 1) Primary: the user's own server. 2) Fallback: canonical GitHub
        // raw manifest — tried whenever the server gives us nothing newer
        // (or errors), so a stale/unreachable server can't lock users out
        // of newer releases. If BOTH are unreachable we re-throw the server
        // error so the user-initiated "检查更新" path can report a failure.
        val serverResult = runCatching { api.latest() }
        val fromServer = serverResult.getOrNull()
        val serverIsNewer = fromServer != null && fromServer.versionCode > localVersionCode
        val fromGithub =
            if (serverIsNewer) null
            else runCatching { api.fetchManifest(GITHUB_MANIFEST_URL) }.getOrNull()
        val rel = listOfNotNull(fromServer, fromGithub).maxByOrNull { it.versionCode }
        if (rel == null) {
            // Neither source reachable — surface the server error to callers
            // (checkNow turns it into a "检查失败" snackbar). Auto-poll
            // swallows it via its own runCatching.
            serverResult.exceptionOrNull()?.let { throw it }
            _state.value = UpdateState.Idle
            return false
        }

        // Determine if update is needed.
        val newer = rel.versionCode > localVersionCode
        val unsupported = localVersionCode < rel.minSupportedVersionCode
        if (!newer && !unsupported) {
            _state.value = UpdateState.Idle
            return false
        }

        // Treat "below minSupported" as a forced upgrade even if the
        // release manifest itself isn't mandatory — that's the whole
        // point of having a min supported version.
        val mandatory = rel.mandatory || unsupported

        // Respect the user's "稍后" choice — UNLESS this is mandatory,
        // in which case we always re-surface.
        val current = _state.value
        if (!mandatory && current is UpdateState.Dismissed && current.versionCode == rel.versionCode) {
            return false
        }
        _state.value = UpdateState.Available(rel, mandatory)
        return true
    }

    fun onUserDismissed() {
        val s = _state.value
        if (s is UpdateState.Available && !s.mandatory) {
            _state.value = UpdateState.Dismissed(s.release.versionCode)
        }
    }

    /** Clear the dismissal so the next launch surfaces the prompt
     *  again. Called when the user opens Settings → "检查更新". */
    fun clearDismissal() {
        if (_state.value is UpdateState.Dismissed) _state.value = UpdateState.Idle
    }

    @Suppress("DEPRECATION")
    private fun localVersionCode(context: Context): Int {
        val pm = context.packageManager
        val name = context.packageName
        return try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                pm.getPackageInfo(name, 0).longVersionCode.toInt()
            } else {
                pm.getPackageInfo(name, 0).versionCode
            }
        } catch (_: PackageManager.NameNotFoundException) { 0 }
    }
}
