// EventEditDialog — single-screen form for create / edit. Centered
// AlertDialog with a scrollable body. Pre-fills from an existing
// EventDTO when editing; uses sensible defaults (next half-hour, 1h
// duration) when creating.
//
// v0.4b scope: summary / calendar / all-day / start / end / location /
// description / url. RRULE is shown read-only for recurring events
// (full RRULE editor is a v0.5 thing — server already validates input).
// Attendees deferred to v0.5.
//
// For recurring events, save → pop RecurringScopePicker → PATCH with
// scope + recurrenceId. The picker is owned by the parent (MainScreen),
// not by this dialog, so we can also re-use it from the detail dialog's
// Delete flow.

package cn.bywave.calendar.desktop.ui.event

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventExtra
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

sealed class EventEditMode {
    data class Create(val seedStart: LocalDateTime? = null) : EventEditMode()
    data class Edit(val source: EventDTO) : EventEditMode()
    /** "Copy as new event" — same fields as source but a fresh start
     *  time + brand new id (server-side). Lands as a POST. */
    data class Duplicate(val source: EventDTO) : EventEditMode()
}

private data class FormState(
    val isEdit: Boolean,
    val sourceId: String?,
    val sourceRrule: String?,
    val sourceStartsAt: String?,
    val calendarId: String,
    val summary: String,
    val location: String,
    val description: String,
    val url: String,
    val start: LocalDateTime,
    val end: LocalDateTime,
    val allDay: Boolean,
    val rrule: RruleState,
    val attendees: List<String>,
) {
    val canSubmit: Boolean
        get() = summary.isNotBlank() && calendarId.isNotBlank()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventEditDialog(
    mode: EventEditMode,
    calendars: List<CalendarMeta>,
    saving: Boolean,
    errorMessage: String?,
    /** Caller passes the scope dialog choice (or null for non-recurring) so
     *  the same Save handler can be reused by the detail-dialog Delete. */
    onSave: (
        isEdit: Boolean,
        sourceId: String?,
        sourceRrule: String?,
        sourceStartsAt: String?,
        create: EventCreateInput?,
        update: EventUpdateInput?,
    ) -> Unit,
    onDismiss: () -> Unit,
) {
    val initial = remember(mode, calendars) { initialState(mode, calendars) }
    var form by remember(mode) { mutableStateOf(initial) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (form.isEdit) "编辑事件" else "新建事件",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        text = {
            Column(
                modifier = Modifier.width(520.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = form.summary,
                    onValueChange = { form = form.copy(summary = it) },
                    label = { Text("标题 *") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                CalendarPicker(
                    calendars = calendars,
                    selectedId = form.calendarId,
                    onSelect = { form = form.copy(calendarId = it) },
                )

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("全天", modifier = Modifier.weight(1f))
                    Switch(
                        checked = form.allDay,
                        onCheckedChange = { v ->
                            form = if (v) form.copy(
                                allDay = true,
                                start = form.start.toLocalDate().atStartOfDay(),
                                end = form.start.toLocalDate().atTime(23, 59),
                            ) else form.copy(
                                allDay = false,
                                end = form.start.plusHours(1),
                            )
                        },
                    )
                }

                DateTimePickerRow(
                    label = "开始",
                    value = form.start,
                    allDay = form.allDay,
                    onChange = { newStart ->
                        val durationMin = java.time.Duration.between(form.start, form.end).toMinutes().coerceAtLeast(15L)
                        form = form.copy(start = newStart, end = newStart.plusMinutes(durationMin))
                    },
                )
                DateTimePickerRow(
                    label = "结束",
                    value = form.end,
                    allDay = form.allDay,
                    onChange = { newEnd ->
                        val clamped = if (newEnd.isBefore(form.start)) form.start.plusMinutes(15) else newEnd
                        form = form.copy(end = clamped)
                    },
                )

                OutlinedTextField(
                    value = form.location,
                    onValueChange = { form = form.copy(location = it) },
                    label = { Text("地点") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = form.url,
                    onValueChange = { form = form.copy(url = it) },
                    label = { Text("链接") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = form.description,
                    onValueChange = { form = form.copy(description = it) },
                    label = { Text("描述") },
                    minLines = 2,
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth(),
                )

                RruleEditor(state = form.rrule, onChange = { form = form.copy(rrule = it) })

                AttendeesSection(
                    attendees = form.attendees,
                    onAdd = { email ->
                        val trimmed = email.trim()
                        if (trimmed.isNotEmpty() && trimmed !in form.attendees) {
                            form = form.copy(attendees = form.attendees + trimmed)
                        }
                    },
                    onRemove = { email ->
                        form = form.copy(attendees = form.attendees - email)
                    },
                )

                if (errorMessage != null) {
                    Text(
                        errorMessage,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val (create, update) = buildBodies(form)
                    onSave(
                        form.isEdit,
                        form.sourceId,
                        form.sourceRrule,
                        form.sourceStartsAt,
                        create,
                        update,
                    )
                },
                enabled = form.canSubmit && !saving,
            ) {
                if (saving) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(if (form.isEdit) "保存" else "创建")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !saving) { Text("取消") }
        },
    )
}

@Composable
private fun CalendarPicker(
    calendars: List<CalendarMeta>,
    selectedId: String,
    onSelect: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val selected = calendars.firstOrNull { it.id == selectedId }

    Box {
        OutlinedButton(
            onClick = { open = true },
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (selected != null) {
                Box(
                    Modifier.size(10.dp).clip(CircleShape).background(parseHex(selected.color)),
                )
                Spacer(Modifier.width(10.dp))
                Text(selected.name, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Start)
            } else {
                Text("选择日历", modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Start)
            }
            Text("▾", color = MaterialTheme.colorScheme.outline)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (cal in calendars) {
                DropdownMenuItem(
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(10.dp).clip(CircleShape).background(parseHex(cal.color)))
                            Spacer(Modifier.width(10.dp))
                            Text(cal.name)
                        }
                    },
                    onClick = {
                        onSelect(cal.id)
                        open = false
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateTimePickerRow(
    label: String,
    value: LocalDateTime,
    allDay: Boolean,
    onChange: (LocalDateTime) -> Unit,
) {
    var showDate by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.width(56.dp), style = MaterialTheme.typography.labelMedium,
             color = MaterialTheme.colorScheme.outline)
        Spacer(Modifier.width(8.dp))
        OutlinedButton(onClick = { showDate = true }, modifier = Modifier.weight(1f)) {
            Text(DATE_FMT.format(value))
        }
        if (!allDay) {
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = { showTime = true }, modifier = Modifier.width(110.dp)) {
                Text(TIME_FMT.format(value))
            }
        }
    }

    if (showDate) {
        val dpState = rememberDatePickerState(
            initialSelectedDateMillis = value.toLocalDate()
                .atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli(),
        )
        DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                TextButton(onClick = {
                    val millis = dpState.selectedDateMillis
                    if (millis != null) {
                        val newDate = Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDate()
                        onChange(LocalDateTime.of(newDate, value.toLocalTime()))
                    }
                    showDate = false
                }) { Text("确定") }
            },
            dismissButton = {
                TextButton(onClick = { showDate = false }) { Text("取消") }
            },
        ) {
            DatePicker(state = dpState)
        }
    }

    if (showTime) {
        val tpState = rememberTimePickerState(
            initialHour = value.hour,
            initialMinute = value.minute,
            is24Hour = true,
        )
        AlertDialog(
            onDismissRequest = { showTime = false },
            title = { Text("选择时间") },
            text = { TimePicker(state = tpState) },
            confirmButton = {
                TextButton(onClick = {
                    onChange(LocalDateTime.of(value.toLocalDate(), LocalTime.of(tpState.hour, tpState.minute)))
                    showTime = false
                }) { Text("确定") }
            },
            dismissButton = {
                TextButton(onClick = { showTime = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun AttendeesSection(
    attendees: List<String>,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
) {
    var newEmail by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "邀请人",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        if (attendees.isNotEmpty()) {
            for (email in attendees) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(email, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { onRemove(email) }) {
                        Text("移除", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = newEmail,
                onValueChange = { newEmail = it },
                placeholder = { Text("邮箱地址") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            OutlinedButton(
                onClick = {
                    onAdd(newEmail)
                    newEmail = ""
                },
                enabled = newEmail.isNotBlank(),
            ) { Text("添加") }
        }
    }
}

// ---- Helpers ----

private val ISO_OFFSET: DateTimeFormatter = DateTimeFormatter.ISO_OFFSET_DATE_TIME
private val DATE_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")
private val TIME_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

private fun initialState(mode: EventEditMode, calendars: List<CalendarMeta>): FormState {
    return when (mode) {
        is EventEditMode.Create -> {
            val start = mode.seedStart ?: nextHalfHour()
            FormState(
                isEdit = false,
                sourceId = null,
                sourceRrule = null,
                sourceStartsAt = null,
                calendarId = calendars.firstOrNull()?.id.orEmpty(),
                summary = "",
                location = "",
                description = "",
                url = "",
                start = start,
                end = start.plusHours(1),
                allDay = false,
                rrule = RruleState.fromRrule(null),
                attendees = emptyList(),
            )
        }
        is EventEditMode.Edit -> {
            val s = mode.source
            val zone = ZoneId.systemDefault()
            val startInstant = runCatching { Instant.parse(s.startsAt) }.getOrNull()
            val endInstant = runCatching { Instant.parse(s.endsAt) }.getOrNull()
            FormState(
                isEdit = true,
                sourceId = s.id,
                sourceRrule = s.rrule,
                sourceStartsAt = s.startsAt,
                calendarId = s.calendarId,
                summary = s.summary,
                location = s.location.orEmpty(),
                description = s.description.orEmpty(),
                url = s.extra?.url.orEmpty(),
                start = startInstant?.atZone(zone)?.toLocalDateTime() ?: nextHalfHour(),
                end = endInstant?.atZone(zone)?.toLocalDateTime() ?: nextHalfHour().plusHours(1),
                allDay = s.allDay,
                rrule = RruleState.fromRrule(s.rrule),
                attendees = s.extra?.attendees.orEmpty(),
            )
        }
        is EventEditMode.Duplicate -> {
            val s = mode.source
            val zone = ZoneId.systemDefault()
            // Keep duration but shift start to next half-hour so we don't
            // post in the past. Mirrors Android EventEditViewModel.
            val origStart = runCatching { Instant.parse(s.startsAt) }.getOrNull()
            val origEnd = runCatching { Instant.parse(s.endsAt) }.getOrNull()
            val durationMin = if (origStart != null && origEnd != null) {
                java.time.Duration.between(origStart, origEnd).toMinutes().coerceAtLeast(15L)
            } else 60L
            val newStart = nextHalfHour()
            FormState(
                isEdit = false,                       // POST, not PATCH
                sourceId = null,
                sourceRrule = null,                   // duplicate dropped recurrence
                sourceStartsAt = null,
                calendarId = s.calendarId,
                summary = s.summary,
                location = s.location.orEmpty(),
                description = s.description.orEmpty(),
                url = s.extra?.url.orEmpty(),
                start = newStart,
                end = newStart.plusMinutes(durationMin),
                allDay = s.allDay,
                rrule = RruleState.fromRrule(null),   // intentionally clear
                attendees = s.extra?.attendees.orEmpty(),
            )
        }
    }
}

private fun buildBodies(form: FormState): Pair<EventCreateInput?, EventUpdateInput?> {
    val zone = ZoneId.systemDefault()
    val startIso = ISO_OFFSET.format(form.start.atZone(zone))
    val endIso = ISO_OFFSET.format(form.end.atZone(zone))

    val urlTrim = form.url.trim()
    val attendees = form.attendees.takeIf { it.isNotEmpty() }
    // Always emit timezone for timed events; emit url + attendees when
    // present. allDay events skip the timezone field (it's irrelevant
    // and the server stores allDay times as date-only).
    val extra = when {
        urlTrim.isNotEmpty() || attendees != null -> EventExtra(
            timezone = if (!form.allDay) zone.id else null,
            attendees = attendees,
            url = urlTrim.ifEmpty { null },
        )
        !form.allDay -> EventExtra(timezone = zone.id)
        else -> null
    }

    val rrule = form.rrule.toRrule()

    return if (form.isEdit) {
        null to EventUpdateInput(
            calendarId = form.calendarId,
            summary = form.summary,
            description = form.description.ifBlank { null },
            location = form.location.ifBlank { null },
            startsAt = startIso,
            endsAt = endIso,
            allDay = form.allDay,
            rrule = rrule,
            extra = extra,
        )
    } else {
        EventCreateInput(
            calendarId = form.calendarId,
            summary = form.summary,
            description = form.description.ifBlank { null },
            location = form.location.ifBlank { null },
            startsAt = startIso,
            endsAt = endIso,
            allDay = if (form.allDay) true else null,
            rrule = rrule,
            extra = extra,
        ) to null
    }
}

/** Round current time up to the next :00 or :30. Sane default for
 *  "new event" so users don't have to set a time first. */
internal fun nextHalfHour(): LocalDateTime {
    val now = LocalDateTime.now()
    return if (now.minute < 30) now.withMinute(30).withSecond(0).withNano(0)
           else now.plusHours(1).withMinute(0).withSecond(0).withNano(0)
}
