// Reminder preferences — whether desktop event reminders are on, and how
// many minutes before an event's start to fire. Persisted to
// ~/.bywave-calendar/reminders (single line "enabled:leadMinutes", e.g.
// "true:10"), mirroring the lightweight plain-file persistence I18n uses.
//
// Exposed as StateFlows so the Settings toggle re-renders reactively and
// the ReminderScheduler reads the live values each tick.

package cn.bywave.calendar.desktop.data.notify

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

object ReminderPrefs {
    private val storeDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar")
    private val storeFile: Path = storeDir.resolve("reminders")

    private val _enabled = MutableStateFlow(true)
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    private val _leadMinutes = MutableStateFlow(10)
    val leadMinutes: StateFlow<Int> = _leadMinutes.asStateFlow()

    /** Lead-time options offered in Settings (minutes before start). */
    val leadOptions: List<Int> = listOf(0, 5, 10, 15, 30, 60)

    /** Call once at boot. Reads the saved prefs; silently keeps defaults
     *  (on, 10 min) when the file is missing or malformed. */
    fun init() {
        runCatching {
            if (Files.exists(storeFile)) {
                val parts = Files.readString(storeFile).trim().split(":")
                if (parts.size == 2) {
                    _enabled.value = parts[0].toBoolean()
                    parts[1].toIntOrNull()?.let { if (it in 0..1440) _leadMinutes.value = it }
                }
            }
        }
    }

    fun setEnabled(on: Boolean) {
        if (_enabled.value == on) return
        _enabled.value = on
        persist()
    }

    fun setLeadMinutes(min: Int) {
        if (_leadMinutes.value == min) return
        _leadMinutes.value = min
        persist()
    }

    private fun persist() {
        runCatching {
            Files.createDirectories(storeDir)
            Files.writeString(storeFile, "${_enabled.value}:${_leadMinutes.value}")
        }.onFailure {
            System.err.println("[ReminderPrefs] failed to persist: ${it.message}")
        }
    }
}
