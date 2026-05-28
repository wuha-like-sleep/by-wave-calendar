// Lightweight RRULE editor. Covers the 90% case: pick a FREQ (none /
// daily / weekly / monthly / yearly), set INTERVAL, optionally cap with
// UNTIL or COUNT. Anything more exotic (BYDAY, BYMONTHDAY, BYSETPOS,
// EXDATE) still passes through verbatim — we keep the raw RRULE string
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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

enum class RruleFreq(val wire: String, val label: String) {
    None("", "不重复"),
    Daily("DAILY", "每天"),
    Weekly("WEEKLY", "每周"),
    Monthly("MONTHLY", "每月"),
    Yearly("YEARLY", "每年"),
}

enum class RruleEnd { Forever, Until, Count }

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
     *  so we don't accidentally drop BYDAY / EXDATE etc. */
    val passthrough: String?,
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
            // If the RRULE has any "exotic" key we don't model, keep
            // the original around so we don't lose data on save.
            val known = setOf("FREQ", "INTERVAL", "UNTIL", "COUNT")
            val hasExotic = parts.keys.any { it !in known }
            return RruleState(freq, interval, end, until, count, if (hasExotic) rrule else null)
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
    var freqOpen by remember { mutableStateOf(false) }
    var endOpen by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // FREQ row
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "重复",
                modifier = Modifier.width(56.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.outline,
            )
            Spacer(Modifier.width(8.dp))
            Box {
                OutlinedButton(onClick = { freqOpen = true }) {
                    Text(state.freq.label)
                    Spacer(Modifier.width(8.dp))
                    Text("▾", color = MaterialTheme.colorScheme.outline)
                }
                DropdownMenu(expanded = freqOpen, onDismissRequest = { freqOpen = false }) {
                    for (f in RruleFreq.entries) {
                        DropdownMenuItem(
                            text = { Text(f.label) },
                            onClick = {
                                onChange(state.copy(freq = f, passthrough = null))
                                freqOpen = false
                            },
                        )
                    }
                }
            }
        }

        if (state.passthrough != null) {
            Text(
                "包含未支持字段（如 BYDAY / EXDATE），保存时会保留原始规则。如需改写请先把「重复」选成「不重复」再设置。",
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
                "间隔",
                modifier = Modifier.width(56.dp),
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

        // END row
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "结束",
                modifier = Modifier.width(56.dp),
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
                    Text("次", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

private fun intervalSuffix(f: RruleFreq): String = when (f) {
    RruleFreq.Daily -> "天"
    RruleFreq.Weekly -> "周"
    RruleFreq.Monthly -> "月"
    RruleFreq.Yearly -> "年"
    RruleFreq.None -> ""
}

private fun endLabel(e: RruleEnd): String = when (e) {
    RruleEnd.Forever -> "永远"
    RruleEnd.Until -> "截止日期"
    RruleEnd.Count -> "重复 N 次"
}
