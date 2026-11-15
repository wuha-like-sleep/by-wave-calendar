package cn.bywave.calendar.sync

import java.time.Instant

/** Only use after the server has accepted this exact delete. A failed fetch or
 * missing event in a partial response is never a deletion acknowledgement. */
data class ConfirmedEventDeletion(
    val eventId: String,
    val scope: String? = null,
    val recurrenceId: String? = null,
) {
    private val boundary = recurrenceId?.let { runCatching { Instant.parse(it) }.getOrNull() }

    fun removes(id: String, startsAt: String): Boolean {
        if (id != eventId) return false
        return when (scope) {
            null, "series" -> true
            "instance", "future" -> {
                val from = boundary ?: return false
                val occurrence = runCatching { Instant.parse(startsAt) }.getOrNull() ?: return false
                if (scope == "instance") occurrence == from else occurrence >= from
            }
            else -> false
        }
    }
}
