// RruleEditor — RRULE form state (parse / build) + the editor section.
//
// Modelled on the desktop RruleEditor.kt (freq / interval / end), and
// extended with BYDAY because the task requires it and the server's
// expansion (src/lib/rrule_expand.ts, the `rrule` library) supports
// the full RFC 5545 range — weekly weekday sets and monthly ordinal
// weekdays (BYDAY=2MO, BYDAY=-1FR) included.
//
// Round-trip discipline (the desktop rule, kept verbatim in spirit):
// anything the form does NOT model — BYSETPOS, BYMONTHDAY, BYMONTH,
// HOURLY/MINUTELY/SECONDLY freqs, ordinal BYDAY in a WEEKLY rule,
// several BYDAY entries in a MONTHLY rule, UNTIL+COUNT together —
// parses to `passthrough = <original string>` and is sent back
// byte-for-byte unless the user deliberately picks a different
// frequency (which clears passthrough, like the desktop editor).
// A rule is NEVER silently dropped or rewritten.

package cn.bywave.calendar.ui.event

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.ui.calendar.mutedTextColor
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

enum class RruleFreq(val wire: String) {
    None(""), Daily("DAILY"), Weekly("WEEKLY"), Monthly("MONTHLY"), Yearly("YEARLY"),
}

enum class RruleEnd { Forever, Until, Count }

data class RruleFormState(
    val freq: RruleFreq = RruleFreq.None,
    val interval: Int = 1,
    val end: RruleEnd = RruleEnd.Forever,
    /** End date for RruleEnd.Until (the rule's last day, local). */
    val until: LocalDate? = null,
    val count: Int = 10,
    /** WEEKLY: the BYDAY weekday set. Empty = the rule carries no
     *  BYDAY (server falls back to the start's weekday). */
    val byDay: Set<DayOfWeek> = emptySet(),
    /** MONTHLY: null = same day of month (no BYDAY); 1..4 / -1 =
     *  ordinal weekday mode using [monthlyWeekday]. */
    val monthlyOrdinal: Int? = null,
    val monthlyWeekday: DayOfWeek = DayOfWeek.MONDAY,
    /** Verbatim original RRULE when it has parts we don't model. */
    val passthrough: String? = null,
) {
    /** The RRULE to put on the wire, or null for "does not repeat".
     *  A passthrough state returns the original string untouched. */
    fun effectiveRrule(): String? {
        if (freq == RruleFreq.None) return null
        if (passthrough != null) return passthrough
        val sb = StringBuilder("FREQ=").append(freq.wire)
        if (interval > 1) sb.append(";INTERVAL=").append(interval)
        when (freq) {
            RruleFreq.Weekly -> if (byDay.isNotEmpty()) {
                sb.append(";BYDAY=").append(
                    byDay.sorted().joinToString(",") { WEEKDAY_CODES.getValue(it) },
                )
            }
            RruleFreq.Monthly -> if (monthlyOrdinal != null) {
                sb.append(";BYDAY=").append(monthlyOrdinal)
                    .append(WEEKDAY_CODES.getValue(monthlyWeekday))
            }
            else -> Unit
        }
        when (end) {
            RruleEnd.Until -> until?.let {
                // Same convention as desktop: the picked date is the
                // last day, encoded as end-of-day UTC.
                sb.append(";UNTIL=").append(it.format(DateTimeFormatter.BASIC_ISO_DATE))
                    .append("T235959Z")
            }
            RruleEnd.Count -> if (count > 0) sb.append(";COUNT=").append(count)
            RruleEnd.Forever -> Unit
        }
        return sb.toString()
    }

    companion object {
        private val WEEKDAY_CODES: Map<DayOfWeek, String> = mapOf(
            DayOfWeek.MONDAY to "MO", DayOfWeek.TUESDAY to "TU",
            DayOfWeek.WEDNESDAY to "WE", DayOfWeek.THURSDAY to "TH",
            DayOfWeek.FRIDAY to "FR", DayOfWeek.SATURDAY to "SA",
            DayOfWeek.SUNDAY to "SU",
        )
        private val CODE_WEEKDAYS: Map<String, DayOfWeek> =
            WEEKDAY_CODES.entries.associate { (k, v) -> v to k }

        /** Parse a stored RRULE into form state. [startWeekday] seeds
         *  the monthly ordinal weekday default (the occurrence the
         *  user is looking at). Unmodelable input → passthrough. */
        fun parse(rrule: String?, startWeekday: DayOfWeek = DayOfWeek.MONDAY): RruleFormState {
            if (rrule.isNullOrBlank()) return RruleFormState(monthlyWeekday = startWeekday)
            val fallback = RruleFormState(
                freq = RruleFreq.Daily, // freq is ignored while passthrough is set
                monthlyWeekday = startWeekday,
                passthrough = rrule,
            )
            val parts = LinkedHashMap<String, String>()
            for (piece in rrule.split(";")) {
                val eq = piece.indexOf('=')
                if (eq <= 0) return fallback
                parts[piece.substring(0, eq).uppercase()] = piece.substring(eq + 1)
            }
            val freq = RruleFreq.entries.firstOrNull { it.wire == parts["FREQ"] }
                ?: return fallback
            if (freq == RruleFreq.None) return fallback
            val known = setOf("FREQ", "INTERVAL", "UNTIL", "COUNT", "BYDAY")
            if (parts.keys.any { it !in known }) return fallback
            if (parts.containsKey("UNTIL") && parts.containsKey("COUNT")) return fallback

            val interval = parts["INTERVAL"]?.let { it.toIntOrNull() ?: return fallback } ?: 1
            if (interval < 1) return fallback
            val count = parts["COUNT"]?.let { it.toIntOrNull() ?: return fallback } ?: 10
            if (parts.containsKey("COUNT") && count < 1) return fallback
            val until = parts["UNTIL"]?.let { parseUntilDate(it) ?: return fallback }
            val end = when {
                until != null -> RruleEnd.Until
                parts.containsKey("COUNT") -> RruleEnd.Count
                else -> RruleEnd.Forever
            }

            var byDay: Set<DayOfWeek> = emptySet()
            var monthlyOrdinal: Int? = null
            var monthlyWeekday = startWeekday
            val byDayRaw = parts["BYDAY"]
            if (byDayRaw != null) {
                val entries = byDayRaw.split(",").map { it.trim().uppercase() }
                when (freq) {
                    RruleFreq.Weekly -> {
                        val days = entries.map { CODE_WEEKDAYS[it] ?: return fallback }
                        byDay = days.toSet()
                    }
                    RruleFreq.Monthly -> {
                        if (entries.size != 1) return fallback
                        val m = Regex("^([+-]?\\d)(MO|TU|WE|TH|FR|SA|SU)$")
                            .matchEntire(entries[0]) ?: return fallback
                        val ordinal = m.groupValues[1].toInt()
                        if (ordinal !in listOf(1, 2, 3, 4, -1)) return fallback
                        monthlyOrdinal = ordinal
                        monthlyWeekday = CODE_WEEKDAYS.getValue(m.groupValues[2])
                    }
                    else -> return fallback
                }
            }
            return RruleFormState(
                freq = freq,
                interval = interval,
                end = end,
                until = until,
                count = count,
                byDay = byDay,
                monthlyOrdinal = monthlyOrdinal,
                monthlyWeekday = monthlyWeekday,
            )
        }

        /** UNTIL arrives as YYYYMMDD, YYYYMMDDTHHMMSSZ, or the same
         *  without Z — only the date part is ours to edit. */
        private fun parseUntilDate(raw: String): LocalDate? {
            val ymd = raw.trim().removeSuffix("Z").substringBefore("T")
            if (ymd.length != 8 || !ymd.all { it.isDigit() }) return null
            return runCatching {
                LocalDate.of(
                    ymd.substring(0, 4).toInt(),
                    ymd.substring(4, 6).toInt(),
                    ymd.substring(6, 8).toInt(),
                )
            }.getOrNull()
        }
    }
}

// ---- Editor UI ----

private fun freqLabelRes(freq: RruleFreq): Int = when (freq) {
    RruleFreq.None -> R.string.rrule_none
    RruleFreq.Daily -> R.string.rrule_daily
    RruleFreq.Weekly -> R.string.rrule_weekly
    RruleFreq.Monthly -> R.string.rrule_monthly
    RruleFreq.Yearly -> R.string.rrule_yearly
}

private fun endLabelRes(end: RruleEnd): Int = when (end) {
    RruleEnd.Forever -> R.string.rrule_end_forever
    RruleEnd.Until -> R.string.rrule_end_until
    RruleEnd.Count -> R.string.rrule_end_count
}

private fun ordinalLabelRes(ordinal: Int): Int = when (ordinal) {
    1 -> R.string.rrule_ordinal_1
    2 -> R.string.rrule_ordinal_2
    3 -> R.string.rrule_ordinal_3
    4 -> R.string.rrule_ordinal_4
    else -> R.string.rrule_ordinal_last
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RruleEditorSection(
    state: RruleFormState,
    onChange: (RruleFormState) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // Frequency
        PickerRow(
            label = stringResource(R.string.event_rrule_label),
            current = stringResource(freqLabelRes(state.freq)),
            options = RruleFreq.entries.map { stringResource(freqLabelRes(it)) },
            onPick = { idx ->
                val picked = RruleFreq.entries[idx]
                // Picking a frequency is the deliberate act that drops
                // a passthrough rule (desktop semantics); re-picking
                // the same one keeps everything else as-is.
                onChange(state.copy(freq = picked, passthrough = null))
            },
        )

        if (state.passthrough != null) {
            Text(
                text = stringResource(R.string.rrule_passthrough_note),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )
            return
        }
        if (state.freq == RruleFreq.None) return

        // Interval
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.rrule_interval), modifier = Modifier.width(96.dp))
            OutlinedTextField(
                value = state.interval.toString(),
                onValueChange = { txt ->
                    val v = txt.filter { it.isDigit() }.take(3).toIntOrNull() ?: 1
                    onChange(state.copy(interval = v.coerceAtLeast(1)))
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(96.dp),
            )
        }

        // WEEKLY: BYDAY multi-select chips (Mon..Sun display order).
        if (state.freq == RruleFreq.Weekly) {
            Text(
                text = stringResource(R.string.rrule_byday_label),
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                DayOfWeek.entries.forEach { day ->
                    val selected = day in state.byDay
                    FilterChip(
                        selected = selected,
                        onClick = {
                            onChange(
                                state.copy(
                                    byDay = if (selected) state.byDay - day else state.byDay + day,
                                ),
                            )
                        },
                        label = {
                            Text(day.getDisplayName(TextStyle.SHORT, Locale.getDefault()))
                        },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        // MONTHLY: same-day vs ordinal weekday.
        if (state.freq == RruleFreq.Monthly) {
            PickerRow(
                label = stringResource(R.string.rrule_monthly_mode_label),
                current = stringResource(
                    if (state.monthlyOrdinal == null) R.string.rrule_monthly_sameday
                    else R.string.rrule_monthly_ordinal,
                ),
                options = listOf(
                    stringResource(R.string.rrule_monthly_sameday),
                    stringResource(R.string.rrule_monthly_ordinal),
                ),
                onPick = { idx ->
                    onChange(
                        if (idx == 0) state.copy(monthlyOrdinal = null)
                        else state.copy(monthlyOrdinal = state.monthlyOrdinal ?: 1),
                    )
                },
            )
            if (state.monthlyOrdinal != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PickerRow(
                        label = "",
                        current = stringResource(ordinalLabelRes(state.monthlyOrdinal)),
                        options = listOf(1, 2, 3, 4, -1).map { stringResource(ordinalLabelRes(it)) },
                        onPick = { idx ->
                            onChange(state.copy(monthlyOrdinal = listOf(1, 2, 3, 4, -1)[idx]))
                        },
                        modifier = Modifier.weight(1f),
                    )
                    PickerRow(
                        label = "",
                        current = state.monthlyWeekday.getDisplayName(
                            TextStyle.FULL, Locale.getDefault(),
                        ),
                        options = DayOfWeek.entries.map {
                            it.getDisplayName(TextStyle.FULL, Locale.getDefault())
                        },
                        onPick = { idx ->
                            onChange(state.copy(monthlyWeekday = DayOfWeek.entries[idx]))
                        },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        // End condition
        PickerRow(
            label = stringResource(R.string.rrule_end_label),
            current = stringResource(endLabelRes(state.end)),
            options = RruleEnd.entries.map { stringResource(endLabelRes(it)) },
            onPick = { idx -> onChange(state.copy(end = RruleEnd.entries[idx])) },
        )
        when (state.end) {
            RruleEnd.Forever -> Unit
            RruleEnd.Until -> {
                var text by remember(state.until) {
                    mutableStateOf(state.until?.toString().orEmpty())
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = { v ->
                        text = v
                        runCatching { LocalDate.parse(v.trim()) }
                            .getOrNull()?.let { onChange(state.copy(until = it)) }
                    },
                    label = { Text(stringResource(R.string.rrule_end_until)) },
                    placeholder = { Text("YYYY-MM-DD") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            RruleEnd.Count -> Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = state.count.toString(),
                    onValueChange = { txt ->
                        val v = txt.filter { it.isDigit() }.take(4).toIntOrNull() ?: 1
                        onChange(state.copy(count = v.coerceAtLeast(1)))
                    },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.width(96.dp),
                )
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.rrule_count_suffix))
            }
        }
    }
}

/** Label + current value + dropdown, the same shape as the reminder
 *  and lead-time pickers elsewhere in the app. */
@Composable
private fun PickerRow(
    label: String,
    current: String,
    options: List<String>,
    onPick: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = true }
                .padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (label.isNotEmpty()) {
                Text(label, modifier = Modifier.width(96.dp))
            }
            Text(text = current, color = mutedTextColor(), modifier = Modifier.weight(1f))
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = mutedTextColor())
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEachIndexed { idx, text ->
                DropdownMenuItem(
                    text = { Text(text) },
                    onClick = {
                        onPick(idx)
                        expanded = false
                    },
                )
            }
        }
    }
}
