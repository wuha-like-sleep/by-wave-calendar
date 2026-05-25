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

object UpdateChecker {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    private var lastCheckMs: Long = 0
    private const val THROTTLE_MS: Long = 6 * 60 * 60 * 1000L  // 6h

    /** Force a check on the next call regardless of throttle. Used by
     *  the "立即检查更新" button in Settings. */
    fun resetThrottle() { lastCheckMs = 0 }

    suspend fun checkIfDue(context: Context, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastCheckMs < THROTTLE_MS) return
        lastCheckMs = now
        runCatching { doCheck(context) }
    }

    private suspend fun doCheck(context: Context) {
        val profile = BywaveApp.instance.profiles.active() ?: return
        val api = UpdateApiFactory.create(profile.serverUrl)
        val rel = api.latest()
        val localVersionCode = localVersionCode(context)

        // Determine if update is needed.
        val newer = rel.versionCode > localVersionCode
        val unsupported = localVersionCode < rel.minSupportedVersionCode
        if (!newer && !unsupported) {
            _state.value = UpdateState.Idle
            return
        }

        // Treat "below minSupported" as a forced upgrade even if the
        // release manifest itself isn't mandatory — that's the whole
        // point of having a min supported version.
        val mandatory = rel.mandatory || unsupported

        // Respect the user's "稍后" choice — UNLESS this is mandatory,
        // in which case we always re-surface.
        val current = _state.value
        if (!mandatory && current is UpdateState.Dismissed && current.versionCode == rel.versionCode) {
            return
        }
        _state.value = UpdateState.Available(rel, mandatory)
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
