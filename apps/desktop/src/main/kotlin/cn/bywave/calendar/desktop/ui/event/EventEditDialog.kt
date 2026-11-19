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
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventExtra
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import cn.bywave.calendar.event.duplicateEventRange
import cn.bywave.calendar.event.eventFormDateTime
import cn.bywave.calendar.event.EventFormInstant
import cn.bywave.calendar.event.eventFormIso
import cn.bywave.calendar.event.eventPickerDate
import cn.bywave.calendar.event.eventPickerMillis
import cn.bywave.calendar.event.eventStringField
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

internal data class FormState(
    val isEdit: Boolean,
    val sourceId: String?,
    val sourceRrule: String?,
    val sourceStartsAt: String?,
    val calendarId: String,
    val summary: String,
    val location: String,
    val description: String,
    val url: String,
    val meetingPassword: String,
    val start: LocalDateTime,
    val end: LocalDateTime,
    val allDay: Boolean,
    val rrule: RruleState,
    val attendees: List<String>,
    // Source metadata distinguishes cleared fields from unloaded fields;
    // duplication also copies metadata this editor does not expose.
    val sourceExtra: cn.bywave.calendar.desktop.data.model.EventExtraDTO? = null,
    val originalStart: EventFormInstant? = null,
    val originalEnd: EventFormInstant? = null,
    val displayZone: ZoneId = ZoneId.systemDefault(),
    // Display changes must not redefine a newly drafted recurrence's zone.
    val creationZone: ZoneId = displayZone,
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
    /** Natural-language quick-add (create mode only). Null = feature off. */
    /** 一句话录入的解析动作。返回 Result —— 失败要能说出「为什么」，
     *  以前这里是可空返回值，失败和「解析出来是空的」长得一模一样，
     *  对话框只能什么都不做。 */
    onQuickParse: (suspend (String) -> Result<cn.bywave.calendar.desktop.data.model.ParseEventResult>)? = null,
) {
    // Observe locale so all form labels re-render on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    val displayZone = cn.bywave.calendar.desktop.ui.calendar.rememberDisplayTimeZone()
    var form by remember(mode) {
        mutableStateOf(
            initialState(
                mode, calendars, displayZone,
                lastCalendarId = cn.bywave.calendar.desktop.data.LastCalendarPrefs.get(),
            ),
        )
    }
    // Pristine snapshot for the discard guard below: what the form
    // would submit untouched. Compared through buildBodies so pure
    // display changes (a timezone rebase, the late calendar fill) do
    // not read as edits — the same fingerprint idea the Android editor
    // uses, with the submit body as the fingerprint.
    var pristine by remember(mode) { mutableStateOf(form) }
    LaunchedEffect(calendars) {
        val updated = form.withCalendars(calendars)
        if (buildBodies(form) == buildBodies(pristine)) pristine = updated
        form = updated
    }
    LaunchedEffect(displayZone) { form = form.withDisplayZone(displayZone) }
    var showDiscardConfirm by remember { mutableStateOf(false) }
    val hasUnsavedChanges: Boolean
        get() = buildBodies(form) != buildBodies(pristine)

    // 提交入口抽出来,给「点保存」和「在标题里敲回车」共用。桌面端填完
    // 标题按回车就想存下,以前回车在单行输入框里什么都不做,用户要伸手
    // 去够鼠标。日期/备注这些字段不挂回车:备注是多行的,回车在那里
    // 的意思是换行。
    val submit = {
        if (form.canSubmit && !saving) {
            val (create, update) = buildBodies(form)
            onSave(form.isEdit, form.sourceId, form.sourceRrule, form.sourceStartsAt, create, update)
            // Remember the calendar this save used, so the next create
            // starts there instead of resetting to the first calendar.
            // Written at submit time (the dialog doesn't learn the
            // async result); if the save fails the form stays open and
            // the memory still points at the user's chosen calendar.
            cn.bywave.calendar.desktop.data.LastCalendarPrefs.set(form.calendarId)
        }
    }

    // Every exit path (Cancel button, click-outside, Esc) goes through
    // here: with unsaved changes, ask before throwing the draft away.
    // The Android editor has had this guard; the desktop editor used
    // to drop the draft silently on any of these.
    fun requestClose() {
        if (saving) return
        if (hasUnsavedChanges) showDiscardConfirm = true else onDismiss()
    }

    AlertDialog(
        onDismissRequest = { requestClose() },
        title = {
            Text(
                if (form.isEdit) t("event.edit.titleEdit") else t("event.edit.titleCreate"),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        text = {
            Column(
                modifier = Modifier.width(520.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Natural-language quick-add (create only): type a phrase like
                // "明天 下午3点 牙医", parse it, and fill summary/start/end.
                if (!form.isEdit && onQuickParse != null) {
                    val qScope = rememberCoroutineScope()
                    var quickText by remember { mutableStateOf("") }
                    var parsing by remember { mutableStateOf(false) }
                    // 解析失败时贴在输入框底下的一行说明。以前失败是「什么都不发生」:
                    // 用户输入一句话、点解析、转一下、表单一动不动,也没有任何提示。
                    var quickError by remember { mutableStateOf<String?>(null) }
                    // 解析动作抽出来:按钮和回车走同一条路径。
                    val runParse = {
                        if (quickText.isNotBlank() && !parsing) {
                            qScope.launch {
                                parsing = true
                                quickError = null
                                val parseZone = form.displayZone
                                val r = onQuickParse(quickText)
                                parsing = false
                                r.onSuccess { parsed ->
                                    // 服务端把时间回成本地墙上时间(无时区)。解析不出来
                                    // 就当这次没认出来,别让一个格式问题把整个对话框崩掉。
                                    val start = runCatching { java.time.LocalDateTime.parse(parsed.startsAt) }.getOrNull()
                                    val end = runCatching { java.time.LocalDateTime.parse(parsed.endsAt) }.getOrNull()
                                    if (start == null || end == null) {
                                        quickError = cn.bywave.calendar.desktop.i18n.I18n.t("event.edit.quickadd.failed")
                                    } else {
                                        val first = EventPickerDraft(start, parseZone, form.allDay).withDisplayZone(form.displayZone)
                                        val last = EventPickerDraft(end, parseZone, form.allDay).withDisplayZone(form.displayZone)
                                        form = form.copy(
                                            summary = if (parsed.summary.isNotBlank()) parsed.summary else form.summary,
                                            start = first.value, end = last.value,
                                            originalStart = first.original, originalEnd = last.original,
                                        )
                                    }
                                }.onFailure { e ->
                                    // 老服务端没有这个接口(404)。这时候说「没识别出来」是骗人的,
                                    // 该说的是「这台服务器还不支持」。
                                    val status = (e as? cn.bywave.calendar.desktop.data.api.ApiException)?.status
                                    quickError = if (status == 404) {
                                        cn.bywave.calendar.desktop.i18n.I18n.t("event.edit.quickadd.unsupported")
                                    } else {
                                        cn.bywave.calendar.desktop.util.userFacingError(e, "event.edit.quickadd.failed")
                                    }
                                }
                            }
                            Unit
                        }
                    }
                    OutlinedTextField(
                        value = quickText,
                        onValueChange = { quickText = it },
                        label = { Text(t("event.edit.quickadd")) },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            // 一句话录入完按回车就解析,别让人再去点旁边那个
                            // 小按钮。这里回车只解析、不保存——解析结果还要
                            // 让用户过一眼。
                            .onPreviewKeyEvent { e ->
                                if (e.type == KeyEventType.KeyDown &&
                                    (e.key == Key.Enter || e.key == Key.NumPadEnter) &&
                                    quickText.isNotBlank() && !parsing
                                ) {
                                    runParse(); true
                                } else {
                                    false
                                }
                            },
                        trailingIcon = {
                            if (parsing) {
                                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            } else {
                                TextButton(
                                    onClick = { runParse() },
                                    enabled = quickText.isNotBlank(),
                                ) { Text(t("event.edit.quickadd.parse")) }
                            }
                        },
                    )
                    quickError?.let { msg ->
                        Text(
                            msg,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }

                OutlinedTextField(
                    value = form.summary,
                    onValueChange = { form = form.copy(summary = it) },
                    label = { Text(t("event.edit.summary") + " *") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .onPreviewKeyEvent { e ->
                            if (e.type == KeyEventType.KeyDown &&
                                (e.key == Key.Enter || e.key == Key.NumPadEnter) &&
                                form.canSubmit && !saving
                            ) {
                                submit(); true
                            } else {
                                false
                            }
                        },
                )

                CalendarPicker(
                    calendars = calendars,
                    selectedId = form.calendarId,
                    onSelect = { form = form.copy(calendarId = it) },
                )

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t("event.edit.allDay"), modifier = Modifier.weight(1f))
                    Switch(
                        checked = form.allDay,
                        onCheckedChange = { v ->
                            form = if (v) form.copy(
                                allDay = true,
                                start = form.start.toLocalDate().atStartOfDay(),
                                end = maxOf(form.start.toLocalDate(), form.end.toLocalDate()).atTime(23, 59),
                                originalStart = null, originalEnd = null,
                            ) else form.copy(
                                allDay = false,
                                end = form.start.plusHours(1),
                                originalStart = null, originalEnd = null,
                            )
                        },
                    )
                }

                DateTimePickerRow(
                    label = t("event.edit.start"),
                    value = form.start,
                    allDay = form.allDay,
                    displayZone = form.displayZone,
                    original = form.originalStart,
                    onChange = { newStart, selected -> form = form.withStart(newStart, selected) },
                )
                DateTimePickerRow(
                    label = t("event.edit.end"),
                    value = form.end,
                    allDay = form.allDay,
                    displayZone = form.displayZone,
                    original = form.originalEnd,
                    onChange = { newEnd, selected -> form = form.withEnd(newEnd, selected) },
                )

                if (!form.allDay) {
                    Text(t("event.detail.displayTimezone") + ": " + form.displayZone.id,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }

                OutlinedTextField(
                    value = form.location,
                    onValueChange = { form = form.copy(location = it) },
                    label = { Text(t("event.edit.location")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = form.url,
                    onValueChange = { form = form.copy(url = it) },
                    label = { Text(t("event.edit.url")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = form.meetingPassword,
                    onValueChange = { form = form.copy(meetingPassword = it) },
                    label = { Text(t("event.edit.meetingPassword")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = form.description,
                    onValueChange = { form = form.copy(description = it) },
                    label = { Text(t("event.edit.description")) },
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
                onClick = { submit() },
                enabled = form.canSubmit && !saving,
            ) {
                if (saving) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(if (form.isEdit) t("event.edit.save") else t("event.edit.create"))
            }
        },
        dismissButton = {
            TextButton(onClick = { requestClose() }, enabled = !saving) { Text(t("event.edit.cancel")) }
        },
    )

    if (showDiscardConfirm) {
        AlertDialog(
            onDismissRequest = { showDiscardConfirm = false },
            title = { Text(t("event.discardTitle")) },
            text = { Text(t("event.discardMessage")) },
            confirmButton = {
                Button(
                    onClick = {
                        showDiscardConfirm = false
                        onDismiss()
                    },
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) { Text(t("event.discardConfirm")) }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardConfirm = false }) {
                    Text(t("event.keepEditing"))
                }
            },
        )
    }
}

@Composable
private fun CalendarPicker(
    calendars: List<CalendarMeta>,
    selectedId: String,
    onSelect: (String) -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
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
                Text(
                    remember(locale) { cn.bywave.calendar.desktop.i18n.I18n.t("event.edit.pickCalendar") },
                    modifier = Modifier.weight(1f),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Start,
                )
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
    displayZone: ZoneId,
    original: EventFormInstant?,
    onChange: (LocalDateTime, EventFormInstant?) -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    var dateDraft by remember { mutableStateOf<EventPickerDraft?>(null) }
    var timeDraft by remember { mutableStateOf<EventPickerDraft?>(null) }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.widthIn(min = 56.dp, max = 104.dp), style = MaterialTheme.typography.labelMedium,
             color = MaterialTheme.colorScheme.outline)
        Spacer(Modifier.width(8.dp))
        OutlinedButton(onClick = { dateDraft = EventPickerDraft(value, displayZone, allDay, original) }, modifier = Modifier.weight(1f)) {
            Text(DATE_FMT.format(value))
        }
        if (!allDay) {
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = { timeDraft = EventPickerDraft(value, displayZone, false, original) }, modifier = Modifier.width(110.dp)) {
                Text(TIME_FMT.format(value))
            }
        }
    }

    dateDraft?.let { draft ->
        val dpState = rememberDatePickerState(initialSelectedDateMillis = eventPickerMillis(draft.value.toLocalDate()))
        LaunchedEffect(displayZone) {
            val current = dateDraft ?: return@LaunchedEffect
            if (current.zone == displayZone) return@LaunchedEffect
            val selected = dpState.selectedDateMillis
            // An incomplete text date has no instant to convert. Keep its
            // input and old zone until confirmation instead of erasing it.
            if (selected == null && !current.allDay) return@LaunchedEffect
            val pending = selected?.let { current.withDate(eventPickerDate(it)) } ?: current
            val rebased = pending.withDisplayZone(displayZone)
            dateDraft = rebased
            if (selected != null) {
                dpState.selectedDateMillis = eventPickerMillis(rebased.value.toLocalDate())
                dpState.displayedMonthMillis = eventPickerMillis(rebased.value.toLocalDate().withDayOfMonth(1))
            }
        }
        DatePickerDialog(
            onDismissRequest = { dateDraft = null },
            confirmButton = {
                TextButton(onClick = {
                    val millis = dpState.selectedDateMillis
                    val current = dateDraft
                    if (millis != null && current != null) {
                        // Also convert here: a click can arrive before the
                        // effect handling a new system zone has run.
                        val selected = current.withDate(eventPickerDate(millis)).withDisplayZone(displayZone)
                        onChange(selected.value, selected.original)
                    }
                    dateDraft = null
                }) { Text(t("event.edit.confirm")) }
            },
            dismissButton = {
                TextButton(onClick = { dateDraft = null }) { Text(t("event.edit.cancel")) }
            },
        ) {
            Column {
                if (!allDay) Text(t("event.detail.displayTimezone") + ": " + draft.zone.id,
                    modifier = Modifier.padding(horizontal = 24.dp), style = MaterialTheme.typography.bodySmall)
                DatePicker(state = dpState)
            }
        }
    }

    timeDraft?.let { draft ->
        val tpState = rememberTimePickerState(initialHour = draft.value.hour, initialMinute = draft.value.minute, is24Hour = true)
        LaunchedEffect(displayZone) {
            val current = timeDraft ?: return@LaunchedEffect
            if (current.zone == displayZone) return@LaunchedEffect
            val rebased = current.withTime(tpState.hour, tpState.minute).withDisplayZone(displayZone)
            timeDraft = rebased
            tpState.hour = rebased.value.hour
            tpState.minute = rebased.value.minute
        }
        AlertDialog(
            onDismissRequest = { timeDraft = null },
            title = { Text(t("event.edit.pickTime")) },
            text = {
                Column {
                    Text(t("event.detail.displayTimezone") + ": " + draft.zone.id,
                        style = MaterialTheme.typography.bodySmall)
                    TimePicker(state = tpState)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    timeDraft?.let { current ->
                        val selected = current.withTime(tpState.hour, tpState.minute).withDisplayZone(displayZone)
                        onChange(selected.value, selected.original)
                    }
                    timeDraft = null
                }) { Text(t("event.edit.confirm")) }
            },
            dismissButton = {
                TextButton(onClick = { timeDraft = null }) { Text(t("event.edit.cancel")) }
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
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    var newEmail by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            t("event.edit.attendees"),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        if (attendees.isNotEmpty()) {
            for (email in attendees) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(email, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { onRemove(email) }) {
                        Text(t("event.edit.attendeeRemove"), color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = newEmail,
                onValueChange = { newEmail = it },
                placeholder = { Text(t("event.edit.attendeeEmail")) },
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
            ) { Text(t("event.edit.attendeeAdd")) }
        }
    }
}

// ---- Helpers ----

private val DATE_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")
private val TIME_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

internal fun FormState.withCalendars(calendars: List<CalendarMeta>): FormState =
    if (calendarId.isBlank() && calendars.isNotEmpty()) copy(calendarId = calendars.first().id) else this

internal fun initialState(
    mode: EventEditMode,
    calendars: List<CalendarMeta>,
    displayZone: ZoneId = ZoneId.systemDefault(),
    now: Instant = Instant.now(),
    /** Calendar the user last saved an event into (LastCalendarPrefs);
     *  the create branch prefers it over the list's first entry. */
    lastCalendarId: String? = null,
): FormState {
    fun initialInstant(value: LocalDateTime): Instant = java.time.ZonedDateTime.ofLocal(
        value, displayZone, now.atZone(displayZone).offset).toInstant()
    fun original(value: Instant) = EventFormInstant(value.toString(), value.atZone(displayZone).toLocalDateTime())
    return when (mode) {
        is EventEditMode.Create -> {
            val first = initialInstant(mode.seedStart ?: nextHalfHour(displayZone, now))
            val last = first.plusSeconds(3600)
            FormState(
                isEdit = false,
                sourceId = null,
                sourceRrule = null,
                sourceStartsAt = null,
                calendarId = calendars.firstOrNull { it.id == lastCalendarId }?.id
                    ?: calendars.firstOrNull()?.id.orEmpty(),
                summary = "",
                location = "",
                description = "",
                url = "",
                meetingPassword = "",
                start = first.atZone(displayZone).toLocalDateTime(),
                end = last.atZone(displayZone).toLocalDateTime(),
                originalStart = original(first), originalEnd = original(last),
                displayZone = displayZone,
                allDay = false,
                rrule = RruleState.fromRrule(null),
                attendees = emptyList(),
            )
        }
        is EventEditMode.Edit -> {
            val s = mode.source
            val sourceStart = eventFormDateTime(s.startsAt, s.allDay, displayZone)
            val sourceEnd = eventFormDateTime(s.endsAt, s.allDay, displayZone)
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
                meetingPassword = s.extra?.meetingPassword.orEmpty(),
                start = sourceStart ?: nextHalfHour(displayZone, now),
                end = sourceEnd ?: nextHalfHour(displayZone, now).plusHours(1),
                displayZone = displayZone,
                allDay = s.allDay,
                rrule = RruleState.fromRrule(s.rrule),
                attendees = s.extra?.attendees.orEmpty(),
                sourceExtra = s.extra,
                originalStart = sourceStart?.takeIf { !s.allDay }?.let { EventFormInstant(s.startsAt, it) },
                originalEnd = sourceEnd?.takeIf { !s.allDay }?.let { EventFormInstant(s.endsAt, it) },
            )
        }
        is EventEditMode.Duplicate -> {
            val s = mode.source
            val (civilStart, civilEnd) = duplicateEventRange(s.startsAt, s.endsAt, s.allDay, nextHalfHour(displayZone, now))
            val first = initialInstant(civilStart)
            val duration = runCatching { java.time.Duration.between(Instant.parse(s.startsAt), Instant.parse(s.endsAt)) }
                .getOrDefault(java.time.Duration.ofHours(1)).coerceAtLeast(java.time.Duration.ofMinutes(15))
            val last = first.plus(duration)
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
                meetingPassword = s.extra?.meetingPassword.orEmpty(),
                start = if (s.allDay) civilStart else first.atZone(displayZone).toLocalDateTime(),
                end = if (s.allDay) civilEnd else last.atZone(displayZone).toLocalDateTime(),
                originalStart = if (s.allDay) null else original(first),
                originalEnd = if (s.allDay) null else original(last),
                displayZone = displayZone,
                allDay = s.allDay,
                rrule = RruleState.fromRrule(null),   // intentionally clear
                attendees = s.extra?.attendees.orEmpty(),
                sourceExtra = s.extra,
            )
        }
    }
}

internal fun buildBodies(form: FormState): Pair<EventCreateInput?, EventUpdateInput?> {
    val zone = form.displayZone
    val startIso = if (form.allDay) eventFormIso(form.start, true, isStart = true, zone)
        else draftInstant(form.start, zone, form.originalStart).toString()
    val endIso = if (form.allDay) eventFormIso(form.end, true, isStart = false, zone)
        else draftInstant(form.end, zone, form.originalEnd).toString()

    val urlTrim = form.url.trim()
    val pwTrim = form.meetingPassword.trim()
    val attendees = form.attendees.takeIf { it.isNotEmpty() || form.sourceExtra != null }
    // The server merges extra keys. Only send fields this editor manages on
    // PATCH; replaying source alarms/category could overwrite a concurrent edit.
    val src = form.sourceExtra
    val extra = run {
        val merged = EventExtra(
            // Timed events: keep the event's own zone; fall back to the
            // desktop zone only when the event never had one (create).
            timezone = src?.timezone ?: if (!form.isEdit && !form.allDay) form.creationZone.id else null,
            attendees = attendees,
            category = if (form.isEdit) null else src?.category,
            url = eventStringField(urlTrim, clearWhenEmpty = form.isEdit && src != null),
            meetingPassword = eventStringField(pwTrim, clearWhenEmpty = form.isEdit && src != null),
            alarms = if (form.isEdit) null else src?.alarms,
        )
        val allNull = merged.timezone == null && merged.attendees == null &&
            merged.category == null && merged.url == null &&
            merged.meetingPassword == null && merged.alarms == null
        if (allNull) null else merged
    }

    val rrule = form.rrule.toRrule()

    return if (form.isEdit) {
        null to EventUpdateInput(
            calendarId = form.calendarId,
            summary = form.summary,
            description = form.description,
            location = form.location,
            startsAt = startIso,
            endsAt = endIso,
            allDay = form.allDay,
            rrule = rrule.orEmpty(),
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
internal fun nextHalfHour(zone: ZoneId = ZoneId.systemDefault(), instant: Instant = Instant.now()): LocalDateTime {
    val now = instant.atZone(zone).toLocalDateTime()
    return if (now.minute < 30) now.withMinute(30).withSecond(0).withNano(0)
           else now.plusHours(1).withMinute(0).withSecond(0).withNano(0)
}
