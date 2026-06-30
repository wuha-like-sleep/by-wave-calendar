// EventEditScreen — Compose form mirroring iOS EventEditView.
//
// All fields stack in a LazyColumn with sectioned cards. Date and time
// pickers open as Material 3 dialogs (DatePickerDialog + TimePicker).
// We don't use Android's old DatePickerDialog/TimePickerDialog because
// Material 3 has native Compose versions with the right look.

package cn.bywave.calendar.ui.event

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.calendar.parseHex
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventEditScreen(
    initialMode: EventEditMode,
    calendars: List<CalendarMeta>,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
    vm: EventEditViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()
    // Subtle haptic on the destructive delete confirm (matches iOS).
    val haptic = LocalHapticFeedback.current

    // bootstrap once — keyed on a stable identity (source id or "create").
    val bootstrapKey = when (initialMode) {
        is EventEditMode.Create -> "create-${initialMode.seedStart}"
        is EventEditMode.Edit -> "edit-${initialMode.source.id}"
        is EventEditMode.Duplicate -> "duplicate-${initialMode.source.id}"
    }
    LaunchedEffect(bootstrapKey) { vm.bootstrap(initialMode, calendars) }
    LaunchedEffect(state.finished) { if (state.finished) onSaved() }

    var showDeleteDialog by remember { mutableStateOf(false) }
    // Pop the scope picker before save when editing a recurring event.
    // Non-recurring events save directly (sourceRrule is null).
    var showScopePicker by remember { mutableStateOf(false) }

    fun attemptSave() {
        if (state.isEdit && !state.sourceRrule.isNullOrBlank()) {
            showScopePicker = true
        } else {
            vm.save()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(if (state.isEdit) stringResource(R.string.event_edit) else stringResource(R.string.event_new))
                },
                navigationIcon = {
                    IconButton(onClick = onDismiss, enabled = !state.saving && !state.deleting) {
                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.action_cancel))
                    }
                },
                actions = {
                    IconButton(
                        onClick = { attemptSave() },
                        enabled = state.canSubmit,
                    ) {
                        if (state.saving) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Default.Check, contentDescription = stringResource(R.string.action_save))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Spacer(Modifier.size(4.dp))

            // Title
            OutlinedTextField(
                value = state.summary,
                onValueChange = vm::onSummary,
                label = { Text(stringResource(R.string.event_summary)) },
                placeholder = { Text(stringResource(R.string.event_summary_hint)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            // Calendar picker
            CalendarDropdown(
                calendars = state.calendars,
                selected = state.calendarId,
                onSelected = vm::onCalendar,
                modifier = Modifier.fillMaxWidth(),
            )

            // All-day toggle
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(stringResource(R.string.event_allday), modifier = Modifier.weight(1f))
                Switch(checked = state.allDay, onCheckedChange = vm::onAllDay)
            }

            // Start
            DateTimeRow(
                label = stringResource(R.string.event_start),
                value = state.start,
                allDay = state.allDay,
                onChange = { date, time -> vm.onStart(date, time) },
            )
            // End
            DateTimeRow(
                label = stringResource(R.string.event_end),
                value = state.end,
                allDay = state.allDay,
                onChange = { date, time -> vm.onEnd(date, time) },
            )

            OutlinedTextField(
                value = state.location,
                onValueChange = vm::onLocation,
                label = { Text(stringResource(R.string.event_location)) },
                placeholder = { Text(stringResource(R.string.event_location_hint)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            OutlinedTextField(
                value = state.url,
                onValueChange = vm::onUrl,
                label = { Text(stringResource(R.string.event_link)) },
                placeholder = { Text(stringResource(R.string.event_link_hint)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )

            OutlinedTextField(
                value = state.meetingPassword,
                onValueChange = vm::onMeetingPassword,
                label = { Text(stringResource(R.string.event_meeting_password)) },
                placeholder = { Text(stringResource(R.string.event_meeting_password_hint)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            OutlinedTextField(
                value = state.description,
                onValueChange = vm::onDescription,
                label = { Text(stringResource(R.string.event_description)) },
                placeholder = { Text(stringResource(R.string.event_description_hint)) },
                modifier = Modifier.fillMaxWidth().height(120.dp),
            )

            // Kotlin doesn't smart-cast through a delegated property
            // (state is a property delegate via collectAsState), so we
            // copy into a local val before nullability narrows.
            val errMsg = state.errorMessage
            if (errMsg != null) {
                Text(
                    text = errMsg,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            // Delete (only in edit mode)
            if (state.isEdit) {
                Spacer(Modifier.size(8.dp))
                Button(
                    onClick = { showDeleteDialog = true },
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                    enabled = !state.saving && !state.deleting,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (state.deleting) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(8.dp))
                        Text(stringResource(R.string.eventedit_deleting))
                    } else {
                        Icon(Icons.Default.Delete, contentDescription = null)
                        Spacer(Modifier.size(8.dp))
                        Text(stringResource(R.string.action_delete))
                    }
                }
            }
            Spacer(Modifier.size(24.dp))
        }
    }

    // Two distinct destruction paths:
    //   - non-recurring: plain AlertDialog confirm
    //   - recurring:    skip the AlertDialog (the picker IS the
    //                   confirmation since it forces a deliberate
    //                   choice) and pop the scope picker directly
    var showDeleteScopePicker by remember { mutableStateOf(false) }
    if (showDeleteDialog) {
        if (!state.sourceRrule.isNullOrBlank()) {
            // First time through for a recurring event: jump straight
            // to the scope picker. We use the dialog flag as the trigger
            // but never actually show the dialog itself.
            LaunchedEffect(Unit) {
                showDeleteDialog = false
                showDeleteScopePicker = true
            }
        } else {
            AlertDialog(
                onDismissRequest = { showDeleteDialog = false },
                title = { Text(stringResource(R.string.event_delete_confirm_title)) },
                text = { Text(stringResource(R.string.event_delete_confirm_message)) },
                confirmButton = {
                    TextButton(onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        showDeleteDialog = false
                        vm.delete()
                    }) { Text(stringResource(R.string.action_delete)) }
                },
                dismissButton = {
                    TextButton(onClick = { showDeleteDialog = false }) {
                        Text(stringResource(R.string.action_cancel))
                    }
                },
            )
        }
    }

    // Recurring-event scope picker for SAVE.
    if (showScopePicker) {
        RecurringScopePicker(
            action = RecurringAction.Edit,
            onPick = { scope ->
                showScopePicker = false
                vm.save(scope = scope.wire, recurrenceId = state.sourceStartsAt)
            },
            onDismiss = { showScopePicker = false },
        )
    }

    // Recurring-event scope picker for DELETE.
    if (showDeleteScopePicker) {
        RecurringScopePicker(
            action = RecurringAction.Delete,
            onPick = { scope ->
                showDeleteScopePicker = false
                vm.delete(scope = scope.wire, recurrenceId = state.sourceStartsAt)
            },
            onDismiss = { showDeleteScopePicker = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CalendarDropdown(
    calendars: List<CalendarMeta>,
    selected: String,
    onSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val current = calendars.firstOrNull { it.id == selected }
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = modifier,
    ) {
        OutlinedTextField(
            value = current?.name.orEmpty(),
            onValueChange = {},
            label = { Text(stringResource(R.string.event_calendar)) },
            readOnly = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(androidx.compose.material3.MenuAnchorType.PrimaryNotEditable, enabled = true)
                .fillMaxWidth(),
            leadingIcon = {
                if (current != null) {
                    Box(
                        modifier = Modifier
                            .size(12.dp)
                            .clip(CircleShape)
                            .background(parseHex(current.color)),
                    )
                }
            },
        )
        // ExposedDropdownMenu is a member of ExposedDropdownMenuBoxScope —
        // calling it via FQN resolves to a non-existent top-level
        // function. Drop the qualifier and let the receiver scope provide it.
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            for (c in calendars) {
                DropdownMenuItem(
                    text = { Text(c.name) },
                    leadingIcon = {
                        Box(
                            modifier = Modifier
                                .size(12.dp)
                                .clip(CircleShape)
                                .background(parseHex(c.color)),
                        )
                    },
                    onClick = {
                        onSelected(c.id)
                        expanded = false
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateTimeRow(
    label: String,
    value: LocalDateTime,
    allDay: Boolean,
    onChange: (LocalDate, LocalTime) -> Unit,
) {
    var showDate by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        TextButton(onClick = { showDate = true }) {
            Text(DATE_FMT.format(value.toLocalDate()))
        }
        if (!allDay) {
            TextButton(onClick = { showTime = true }) {
                Text(TIME_FMT.format(value.toLocalTime()))
            }
        }
    }

    if (showDate) {
        val initMillis = value.toLocalDate()
            .atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val state = rememberDatePickerState(initialSelectedDateMillis = initMillis)
        DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                TextButton(onClick = {
                    val ms = state.selectedDateMillis ?: initMillis
                    val picked = java.time.Instant.ofEpochMilli(ms)
                        .atZone(ZoneOffset.UTC).toLocalDate()
                    onChange(picked, value.toLocalTime())
                    showDate = false
                }) { Text(stringResource(R.string.eventedit_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showDate = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        ) { DatePicker(state = state) }
    }

    if (showTime) {
        val state = rememberTimePickerState(
            initialHour = value.hour,
            initialMinute = value.minute,
            is24Hour = true,
        )
        AlertDialog(
            onDismissRequest = { showTime = false },
            title = { Text(label) },
            text = { TimePicker(state = state) },
            confirmButton = {
                TextButton(onClick = {
                    onChange(value.toLocalDate(), LocalTime.of(state.hour, state.minute))
                    showTime = false
                }) { Text(stringResource(R.string.eventedit_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showTime = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
}

private val DATE_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy 年 M 月 d 日")
private val TIME_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
