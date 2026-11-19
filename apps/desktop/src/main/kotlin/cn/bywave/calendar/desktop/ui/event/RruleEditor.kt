// Lightweight RRULE editor. Covers the 90% case: pick a FREQ (none /
// daily / weekly / monthly / yearly), set INTERVAL, optionally cap with
// UNTIL or COUNT. BYDAY is modeled in the two shapes the server's
// expansion (rrule library, full RFC 5545) and the other clients
// actually produce: WEEKLY with plain weekday codes (MO..SU, picked
// via checkboxes) and MONTHLY with a single ordinal weekday (2TU,
// -1FR — "second Tuesday" / "last Friday", picked via two dropdowns).
// Anything more exotic (BYMONTHDAY, BYSETPOS, BYDAY in any other
// shape) still passes through verbatim — we keep the raw RRULE string
// in the form state and only rebuild it if the user actually edits.
//
// Why we own this (vs iOS/Android): iOS/Android treat rrule as opaque
// and never expose UI to set it. Desktop has more screen real estate
// and keyboard input, so a presets dropdown + 2-3 fields fits naturally
// in the edit dialog without dominating it.

package cn.bywave.calendar.desktop.ui.event

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

enum class RruleFreq(val wire: String, val labelKey: String) {
    None("", "rrule.freq.none"),
    Daily("DAILY", "rrule.freq.daily"),
    Weekly("WEEKLY", "rrule.freq.weekly"),
    Monthly("MONTHLY", "rrule.freq.monthly"),
    Yearly("YEARLY", "rrule.freq.yearly"),
}

/** Resolve an [RruleFreq]'s display label via i18n. Read at call time so
 *  it follows the current UI language (the caller observes I18n.current). */
private fun RruleFreq.label(): String = cn.bywave.calendar.desktop.i18n.I18n.t(labelKey)

enum class RruleEnd { Forever, Until, Count }

/** Weekday codes in RFC order (week starts Monday for display). */
val WEEKDAY_CODES: List<String> = listOf("MO", "TU", "WE", "TH", "FR", "SA", "SU")

/** Ordinal BYDAY token for MONTHLY rules: 2TU, -1FR. The editor only
 *  offers ordinals 1..4 and -1 (last) — the shapes the web / mobile
 *  clients and typical imports use; anything else stays passthrough. */
private val ORDINAL_BYDAY = Regex("^([1-4]|-1)(MO|TU|WE|TH|FR|SA|SU)$")

/** Whether [byday] (raw tokens from a BYDAY part) is a shape this
 *  editor models for [freq]. Kept next to the state so the parse /
 *  serialize round-trip and the tests share one definition. */
internal fun bydayIsModeled(freq: RruleFreq, byday: List<String>): Boolean = when (freq) {
    RruleFreq.Weekly -> byday.isNotEmpty() && byday.all { it in WEEKDAY_CODES }
    RruleFreq.Monthly -> byday.size == 1 && ORDINAL_BYDAY.matches(byday[0])
    else -> false
}

/** Canonical BYDAY token order for the wire: weekday order for WEEKLY
 *  (so MO,WE stays MO,WE regardless of click order); MONTHLY's single
 *  ordinal token goes out as-is. */
internal fun orderedByday(freq: RruleFreq, byday: List<String>): List<String> =
    if (freq == RruleFreq.Weekly) {
        WEEKDAY_CODES.filter { it in byday }
    } else {
        byday
    }

/** Stable state object — owner (EventEditDialog) keeps one in remember
 *  and passes it down. Edit operations mutate fields and the caller
 *  rebuilds the RRULE via [toRrule] before save. */
data class RruleState(
    val freq: RruleFreq,
    val interval: Int,
    val end: RruleEnd,
    val until: String,        // ISO date YYYY-MM-DD
    val count: Int,
    /** Verbatim original RRULE if it has fields we don't understand —
     *  we surface a warning + send the original instead of rebuilding,
     *  so we don't accidentally drop BYMONTHDAY / BYSETPOS etc. */
    val passthrough: String?,
    /** Raw BYDAY tokens ("MO", "2TU", "-1FR"), modeled only in the
     *  shapes [bydayIsModeled] accepts; empty = no BYDAY part. */
    val byday: List<String> = emptyList(),
) {
    companion object {
        fun fromRrule(rrule: String?): RruleState {
            if (rrule.isNullOrBlank()) {
                return RruleState(RruleFreq.None, 1, RruleEnd.Forever, "", 10, null)
            }
            val parts = rrule.split(";").associate {
                val (k, v) = it.split("=", limit = 2).let { p -> p[0].uppercase() to p.getOrElse(1) { "" } }
                k to v
            }
            val freqWire = parts["FREQ"].orEmpty()
            val freq = RruleFreq.entries.firstOrNull { it.wire == freqWire } ?: RruleFreq.None
            val interval = parts["INTERVAL"]?.toIntOrNull() ?: 1
            val until = parts["UNTIL"]?.let { isoFromUntil(it) }.orEmpty()
            val count = parts["COUNT"]?.toIntOrNull() ?: 10
            val end = when {
                until.isNotBlank() -> RruleEnd.Until
                parts["COUNT"] != null -> RruleEnd.Count
                else -> RruleEnd.Forever
            }
            val byday = parts["BYDAY"]
                ?.split(",")
                ?.map { it.trim().uppercase() }
                ?.filter { it.isNotEmpty() }
                .orEmpty()
            val bydayModeled = byday.isNotEmpty() && bydayIsModeled(freq, byday)
            // If the RRULE has any "exotic" key we don't model, keep
            // the original around so we don't lose data on save. BYDAY
            // counts as modeled only in the shapes bydayIsModeled
            // accepts — an unmodeled BYDAY keeps the whole rule on the
            // passthrough path, verbatim.
            val known = setOf("FREQ", "INTERVAL", "UNTIL", "COUNT") +
                (if (bydayModeled) setOf("BYDAY") else emptySet())
            val hasExotic = parts.keys.any { it !in known }
            return RruleState(
                freq, interval, end, until, count,
                if (hasExotic) rrule else null,
                if (bydayModeled) orderedByday(freq, byday) else emptyList(),
            )
        }
    }
}

/** Build an RRULE string from current state. Returns null when freq is
 *  None (event should be non-recurring). */
fun RruleState.toRrule(): String? {
    if (freq == RruleFreq.None) return null
    // If passthrough is set we have BYDAY/EXDATE etc. we don't model —
    // send original to avoid silent data loss. The user can still toggle
    // freq to None to clear it explicitly.
    if (passthrough != null) return passthrough
    val sb = StringBuilder("FREQ=").append(freq.wire)
    if (interval > 1) sb.append(";INTERVAL=").append(interval)
    val bydayOut = orderedByday(freq, byday)
    if (bydayOut.isNotEmpty()) sb.append(";BYDAY=").append(bydayOut.joinToString(","))
    when (end) {
        RruleEnd.Until -> if (until.isNotBlank()) {
            // RRULE UNTIL wants YYYYMMDDTHHMMSSZ. We accept YYYY-MM-DD
            // and treat as end-of-day UTC for safety.
            sb.append(";UNTIL=").append(toRruleUntil(until))
        }
        RruleEnd.Count -> if (count > 0) sb.append(";COUNT=").append(count)
        RruleEnd.Forever -> {}
    }
    return sb.toString()
}

private fun isoFromUntil(until: String): String {
    // until is "YYYYMMDDTHHMMSSZ" or "YYYYMMDD" — extract date part.
    val s = until.replace("Z", "")
    val ymd = s.substringBefore("T")
    if (ymd.length != 8) return ""
    return "${ymd.substring(0, 4)}-${ymd.substring(4, 6)}-${ymd.substring(6, 8)}"
}

private fun toRruleUntil(iso: String): String {
    val parts = iso.split("-")
    if (parts.size != 3) return iso
    return "${parts[0]}${parts[1]}${parts[2]}T235959Z"
}

@Composable
fun RruleEditor(
    state: RruleState,
    onChange: (RruleState) -> Unit,
) {
    // Observe locale so all labels/dropdowns re-render on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    var freqOpen by remember { mutableStateOf(false) }
    var endOpen by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // FREQ row
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                t("rrule.repeat"),
                modifier = Modifier.widthIn(min = 56.dp, max = 104.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.outline,
            )
            Spacer(Modifier.width(8.dp))
            Box {
                OutlinedButton(onClick = { freqOpen = true }) {
                    Text(state.freq.label())
                    Spacer(Modifier.width(8.dp))
                    Text("▾", color = MaterialTheme.colorScheme.outline)
                }
                DropdownMenu(expanded = freqOpen, onDismissRequest = { freqOpen = false }) {
                    for (f in RruleFreq.entries) {
                        DropdownMenuItem(
                            text = { Text(f.label()) },
                            onClick = {
                                // BYDAY tokens only make sense in the
                                // shape the new FREQ models — drop what
                                // doesn't carry over instead of emitting
                                // a rule the editor can't show.
                                val keptByday = when (f) {
                                    RruleFreq.Weekly -> state.byday.filter { it in WEEKDAY_CODES }
                                    RruleFreq.Monthly -> state.byday.filter { ORDINAL_BYDAY.matches(it) }.take(1)
                                    else -> emptyList()
                                }
                                onChange(state.copy(freq = f, passthrough = null, byday = keptByday))
                                freqOpen = false
                            },
                        )
                    }
                }
            }
        }

        if (state.passthrough != null) {
            Text(
                t("rrule.passthrough"),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.padding(start = 64.dp),
            )
            return
        }

        if (state.freq == RruleFreq.None) return

        // INTERVAL row
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                t("rrule.interval"),
                modifier = Modifier.widthIn(min = 56.dp, max = 104.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.outline,
            )
            Spacer(Modifier.width(8.dp))
            OutlinedTextField(
                value = state.interval.toString(),
                onValueChange = { txt ->
                    val v = txt.toIntOrNull()?.coerceAtLeast(1) ?: 1
                    onChange(state.copy(interval = v))
                },
                modifier = Modifier.width(72.dp),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            Spacer(Modifier.width(8.dp))
            Text(intervalSuffix(state.freq), style = MaterialTheme.typography.bodyMedium)
        }

        // BYDAY: WEEKLY picks any set of weekdays; MONTHLY picks one
        // ordinal weekday ("second Tuesday", "last Friday"). An empty
        // BYDAY is valid for both — the series then follows DTSTART's
        // weekday / day-of-month, like a rule without BYDAY at all.
        if (state.freq == RruleFreq.Weekly) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    t("rrule.byday"),
                    modifier = Modifier.widthIn(min = 56.dp, max = 104.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.outline,
                )
                Spacer(Modifier.width(8.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    for ((idx, code) in WEEKDAY_CODES.withIndex()) {
                        val picked = code in state.byday
                        val label = t("weekday.medium.${idx + 1}")
                        if (picked) {
                            Button(
                                onClick = { onChange(state.copy(byday = state.byday - code)) },
                                modifier = Modifier.weight(1f),
                                contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp),
                            ) { Text(label) }
                        } else {
                            OutlinedButton(
                                onClick = { onChange(state.copy(byday = state.byday + code)) },
                                modifier = Modifier.weight(1f),
                                contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp),
                            ) { Text(label) }
                        }
                    }
                }
            }
        }
        if (state.freq == RruleFreq.Monthly) {
            MonthlyBydayRow(state = state, onChange = onChange)
        }

        // END row
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                t("rrule.end"),
                modifier = Modifier.widthIn(min = 56.dp, max = 104.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.outline,
            )
            Spacer(Modifier.width(8.dp))
            Box {
                OutlinedButton(onClick = { endOpen = true }) {
                    Text(endLabel(state.end))
                    Spacer(Modifier.width(8.dp))
                    Text("▾", color = MaterialTheme.colorScheme.outline)
                }
                DropdownMenu(expanded = endOpen, onDismissRequest = { endOpen = false }) {
                    for (e in RruleEnd.entries) {
                        DropdownMenuItem(
                            text = { Text(endLabel(e)) },
                            onClick = {
                                onChange(state.copy(end = e))
                                endOpen = false
                            },
                        )
                    }
                }
            }
            Spacer(Modifier.width(8.dp))
            when (state.end) {
                RruleEnd.Forever -> Unit
                RruleEnd.Until -> OutlinedTextField(
                    value = state.until,
                    onValueChange = { onChange(state.copy(until = it)) },
                    placeholder = { Text("YYYY-MM-DD") },
                    modifier = Modifier.width(140.dp),
                    singleLine = true,
                )
                RruleEnd.Count -> Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = state.count.toString(),
                        onValueChange = { txt ->
                            val v = txt.toIntOrNull()?.coerceAtLeast(1) ?: 1
                            onChange(state.copy(count = v))
                        },
                        modifier = Modifier.width(72.dp),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(t("rrule.times"), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

// Non-composable label helpers: resolve through I18n.t() at call time so
// they follow the current UI language. Safe because every call site is a
// composable that observes I18n.current (so a switch triggers recomposition).
private fun intervalSuffix(f: RruleFreq): String = when (f) {
    RruleFreq.Daily -> cn.bywave.calendar.desktop.i18n.I18n.t("rrule.suffix.day")
    RruleFreq.Weekly -> cn.bywave.calendar.desktop.i18n.I18n.t("rrule.suffix.week")
    RruleFreq.Monthly -> cn.bywave.calendar.desktop.i18n.I18n.t("rrule.suffix.month")
    RruleFreq.Yearly -> cn.bywave.calendar.desktop.i18n.I18n.t("rrule.suffix.year")
    RruleFreq.None -> ""
}

private fun endLabel(e: RruleEnd): String = when (e) {
    RruleEnd.Forever -> cn.bywave.calendar.desktop.i18n.I18n.t("rrule.end.forever")
    RruleEnd.Until -> cn.bywave.calendar.desktop.i18n.I18n.t("rrule.end.until")
    RruleEnd.Count -> cn.bywave.calendar.desktop.i18n.I18n.t("rrule.end.count")
}

private val ORDINAL_TOKEN = Regex("^(-?\\d+)(MO|TU|WE|TH|FR|SA|SU)$")

/** MONTHLY BYDAY editor: an ordinal dropdown (none / 1st / 2nd / 3rd /
 *  4th / last) plus a weekday dropdown. "None" clears BYDAY entirely —
 *  the series then repeats on DTSTART's day-of-month. */
@Composable
private fun MonthlyBydayRow(
    state: RruleState,
    onChange: (RruleState) -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    var ordinalOpen by remember { mutableStateOf(false) }
    var weekdayOpen by remember { mutableStateOf(false) }

    val parsed = state.byday.firstOrNull()?.let { ORDINAL_TOKEN.matchEntire(it) }
    val ordinal: String? = parsed?.groupValues?.get(1)
    val weekday: String = parsed?.groupValues?.get(2) ?: "MO"

    fun ordinalLabel(ord: String?): String = when (ord) {
        null -> t("rrule.ordinal.none")
        "-1" -> t("rrule.ordinal.last")
        else -> t("rrule.ordinal.$ord")
    }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            t("rrule.byday"),
            modifier = Modifier.widthIn(min = 56.dp, max = 104.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        Spacer(Modifier.width(8.dp))
        Box {
            OutlinedButton(onClick = { ordinalOpen = true }) {
                Text(ordinalLabel(ordinal))
                Spacer(Modifier.width(8.dp))
                Text("▾", color = MaterialTheme.colorScheme.outline)
            }
            DropdownMenu(expanded = ordinalOpen, onDismissRequest = { ordinalOpen = false }) {
                for (ord in listOf<String?>(null, "1", "2", "3", "4", "-1")) {
                    DropdownMenuItem(
                        text = { Text(ordinalLabel(ord)) },
                        onClick = {
                            onChange(
                                state.copy(
                                    byday = if (ord == null) emptyList() else listOf(ord + weekday),
                                ),
                            )
                            ordinalOpen = false
                        },
                    )
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        Box {
            OutlinedButton(
                onClick = { weekdayOpen = true },
                enabled = ordinal != null,
            ) {
                Text(t("weekday.medium.${WEEKDAY_CODES.indexOf(weekday) + 1}"))
                Spacer(Modifier.width(8.dp))
                Text("▾", color = MaterialTheme.colorScheme.outline)
            }
            DropdownMenu(expanded = weekdayOpen, onDismissRequest = { weekdayOpen = false }) {
                for ((idx, code) in WEEKDAY_CODES.withIndex()) {
                    DropdownMenuItem(
                        text = { Text(t("weekday.medium.${idx + 1}")) },
                        onClick = {
                            val ord = ordinal
                            if (ord != null) {
                                onChange(state.copy(byday = listOf(ord + code)))
                            }
                            weekdayOpen = false
                        },
                    )
                }
            }
        }
    }
}
