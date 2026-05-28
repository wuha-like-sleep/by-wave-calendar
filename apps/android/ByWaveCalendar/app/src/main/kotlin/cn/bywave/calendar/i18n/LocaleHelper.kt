// LocaleHelper.kt
// Wraps AppCompatDelegate.setApplicationLocales — the universal per-app
// language API on Android. It internally uses the platform LocaleManager
// (added in Android 13 / API 33) and falls back to per-Activity
// context-wrapping on API ≤ 32.
//
// We also keep our own DataStore-backed copy of the user's choice
// because AppCompatDelegate's current locale list is per-process and
// gets rebuilt from scratch on cold start. Without our persistent copy,
// killing the process and re-launching would revert to system locale.
//
// Storage: ~/data/data/cn.bywave.calendar/shared_prefs/bwc_prefs.xml
// (plain SharedPreferences; the saved code is non-sensitive and ~5
// chars long — no need for DataStore overhead just for one field).

package cn.bywave.calendar.i18n

import android.content.Context
import android.content.SharedPreferences
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf

object LocaleHelper {

    /** Supported language tags. Order = order shown in the picker.
     *  "" represents the「跟随系统」option (the user wants whatever the
     *  OS-level language is at the moment). */
    val supported: List<Pair<String, String>> = listOf(
        ""        to "跟随系统",
        "zh-Hans" to "简体中文",
        "en"      to "English",
    )

    private const val PREFS_NAME = "bwc_prefs"
    private const val KEY = "bwc.locale"

    /** Backing mutable state so Compose Settings UI re-renders on
     *  change without us threading a callback through. */
    private val _state = mutableStateOf("")
    val current: State<String> get() = _state

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Call from BywaveApp.onCreate() — restores the user's saved
     *  language choice and tells AppCompat to apply it. Idempotent. */
    fun applyEarly(ctx: Context) {
        val saved = prefs(ctx).getString(KEY, "") ?: ""
        _state.value = saved
        if (saved.isNotEmpty()) {
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(saved))
        }
    }

    /** Switch to a new language. Empty string = "follow system" =
     *  clear the override. AppCompat handles the live config swap
     *  and re-creates the current Activity. */
    fun setLocale(ctx: Context, code: String) {
        if (code == _state.value) return
        prefs(ctx).edit().putString(KEY, code).apply()
        _state.value = code
        if (code.isEmpty()) {
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
        } else {
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(code))
        }
    }

    /** Human-readable label for the current setting. Used by the
     *  Settings row's trailing detail view. */
    fun currentLabel(ctx: Context): String {
        val cur = _state.value
        if (cur.isEmpty()) {
            // "跟随系统" + a hint of what that resolves to right now.
            val sys = ctx.resources.configuration.locales[0]?.language ?: ""
            val sysLabel = if (sys.startsWith("zh")) "简体中文" else if (sys == "en") "English" else sys
            return if (sysLabel.isNotEmpty()) "跟随系统 · $sysLabel" else "跟随系统"
        }
        return supported.firstOrNull { it.first == cur }?.second ?: cur
    }
}
