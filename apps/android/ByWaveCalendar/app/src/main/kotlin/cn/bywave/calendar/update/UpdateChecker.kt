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

import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

import android.content.Context
import android.content.pm.PackageManager
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed class UpdateState {
    object Idle : UpdateState()
    /** mandatory=true means the sheet is non-dismissible RIGHT NOW.
     *  A forced upgrade still inside its grace window arrives with
     *  mandatory=false plus a non-null graceDeadlineMillis: the sheet
     *  stays dismissible but shows the deadline after which it turns
     *  mandatory. Keeping the two apart is what lets one state drive
     *  both the "remind me later" and the "no way out" UI. */
    data class Available(
        val release: AndroidReleaseDto,
        val mandatory: Boolean,
        val graceDeadlineMillis: Long? = null,
    ) : UpdateState()
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

    private val lookup = ReleaseLookup<AndroidReleaseDto>({ it.versionCode }, ::validReleaseDownload)
    private var forceNext = false

    /** Background auto-downloads live here, not in the sheet's scope:
     *  the whole point is the APK lands while the user is elsewhere.
     *  One download per versionCode per process — the disk cache makes
     *  repeats pointless anyway. */
    private val downloadScope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO,
    )
    @Volatile private var autoDownloadStartedFor = -1

    /** Canonical manifest on GitHub raw. Fallback when the user's own
     *  server returns nothing newer (or is unreachable) — a server that
     *  hasn't been re-deployed since the last release would otherwise lock
     *  users out of newer APKs. Same role as the desktop client's fallback. */
    private const val GITHUB_MANIFEST_URL =
        "https://raw.githubusercontent.com/wuha-like-sleep/by-wave-calendar/main/apps/android/releases/latest.json"

    /** Force a check on the next call regardless of throttle. Used by
     *  the "立即检查更新" button in Settings. */
    fun resetThrottle() { forceNext = true }

    suspend fun checkIfDue(context: Context, force: Boolean = false) {
        val forceCheck = force || forceNext
        forceNext = false
        try { doCheck(context, force = forceCheck) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { /* The next automatic attempt retries after one minute. */ }
    }

    /** Explicit user-initiated check from Settings → 检查更新. Always
     *  bypasses throttle and ALWAYS returns a result the UI can render
     *  as feedback ("已是最新" / "发现新版本" / "检查失败 …"). State
     *  side-effects still happen (Available flips on, etc.) but the
     *  returned value drives the immediate snackbar. */
    suspend fun checkNow(context: Context): UserCheckResult {
        val profile = BywaveApp.instance.profiles.active()
            ?: return UserCheckResult.NotSignedIn
        return try {
            val newer = doCheck(context, profileServerUrlOverride = profile.serverUrl, force = true)
            if (newer) UserCheckResult.UpdateFound else UserCheckResult.UpToDate
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            UserCheckResult.Failed(context.getString(R.string.update_err_network))
        }
    }

    /** @return true if a newer (or unsupported-blocking) version was
     *  found and Available state was set, false otherwise. */
    private suspend fun doCheck(
        context: Context,
        profileServerUrlOverride: String? = null,
        force: Boolean = false,
    ): Boolean {
        val baseUrl = profileServerUrlOverride
            ?: BywaveApp.instance.profiles.active()?.serverUrl
            ?: return false
        val api = UpdateApiFactory.create(baseUrl)
        val localVersionCode = localVersionCode(context)
        val deviceId = cn.bywave.calendar.util.ClientDeviceId.get(context)

        val result = lookup.check(baseUrl, force, listOf(
            { api.latest(deviceId, localVersionCode) }, { api.fetchManifest(GITHUB_MANIFEST_URL) },
        ))
        kotlinx.coroutines.currentCoroutineContext().ensureActive()
        if (BywaveApp.instance.profiles.active()?.serverUrl != baseUrl) throw CancellationException("Profile changed")
        // A 404 combined with an unreachable mirror is not proof that we are current.
        val rel = result.release ?: throw java.io.IOException("No valid update manifest")

        // Staged rollout, applied locally with the SAME rule the server
        // uses (shared Rollout): the server gate only covers the server
        // source — the GitHub manifest merged in above never passed
        // through it. Not in the rollout = this release does not exist
        // for this device yet.
        if (!Rollout.isInRollout(
                deviceId = deviceId, platform = "android",
                versionCode = rel.versionCode, rolloutPercent = rel.rolloutPercent,
                currentVersionCode = localVersionCode,
                minSupportedVersionCode = rel.minSupportedVersionCode,
            )
        ) {
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
        // point of having a min supported version. "Forced" then splits
        // by the grace window (shared Rollout.forceState, same rule as
        // desktop): inside grace the prompt is dismissible and carries
        // a deadline; past it, it is mandatory right now.
        val hitForce = rel.mandatory || unsupported
        val firstSeen = UpdateStateStore.firstSeenMillis(context, rel.versionCode)
        val forceState = Rollout.forceState(
            hitForce = hitForce, firstSeenMillis = firstSeen,
            graceDays = rel.graceDays, nowMillis = System.currentTimeMillis(),
        )
        val mandatoryNow = forceState == Rollout.ForceState.FORCED
        val graceDeadline = if (forceState == Rollout.ForceState.IN_GRACE) {
            Rollout.graceDeadlineMillis(firstSeen, rel.graceDays)
        } else null

        // Respect the user's "稍后" choice — UNLESS this is mandatory
        // right now, in which case we always re-surface. (Grace counts
        // as not-mandatory here on purpose: postponing is the point.)
        val current = _state.value
        if (!force && !mandatoryNow && current is UpdateState.Dismissed && current.versionCode == rel.versionCode) {
            return false
        }
        _state.value = UpdateState.Available(rel, mandatoryNow, graceDeadline)
        startAutoDownload(context, rel)
        return true
    }

    /** Desktop parity: download in the background as soon as an update
     *  is known, so the install prompt is instant when the user acts.
     *  Android cannot take the last step silently — the system
     *  installer always needs the user's tap — so when the APK is
     *  verified-ready we post a notification instead (UpdateNotifier);
     *  tapping it lands on the sheet, which finds the verified cache
     *  and offers "立即安装" directly. A failed auto-download is
     *  silent: the sheet's manual download path is unchanged. */
    private fun startAutoDownload(context: Context, rel: AndroidReleaseDto) {
        if (autoDownloadStartedFor == rel.versionCode) return
        autoDownloadStartedFor = rel.versionCode
        val appContext = context.applicationContext
        downloadScope.launch {
            ApkDownloader.download(appContext, rel).collect { p ->
                if (p is DownloadProgress.Done) UpdateNotifier.notifyReady(appContext, rel)
            }
        }
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
