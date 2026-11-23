// EventEditScreen — Compose form mirroring iOS EventEditView.
//
// All fields stack in a LazyColumn with sectioned cards. Date and time
// pickers open as Material 3 dialogs (DatePickerDialog + TimePicker).
// We don't use Android's old DatePickerDialog/TimePickerDialog because
// Material 3 has native Compose versions with the right look.

package cn.bywave.calendar.ui.event

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
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
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.calendar.parseHex
import cn.bywave.calendar.ui.calendar.rememberCalendarFormats
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.abs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventEditScreen(
    initialMode: EventEditMode,
    calendars: List<CalendarMeta>,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
    /** 一句话「直接保存」成功时改走这里（带回建好的事件），由调用方
     *  弹「已创建 · 撤销」反馈。null = 当普通保存处理。 */
    onQuickSaved: ((cn.bywave.calendar.data.model.EventDTO) -> Unit)? = null,
    /** 日历列表没拿到时，给用户一条能自己重试的路。null = 不显示重试。 */
    onRetryCalendars: (() -> Unit)? = null,
    /** 购买清单区里点开一张已关联清单时跳详情页。null = 点了没反应，
     *  所以调用方（事件编辑路由）应当传。新建态用不到（未保存先提示）。 */
    onOpenShoppingList: ((String) -> Unit)? = null,
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
    // bootstrapKey 里**不含** calendars（含了的话日历一到就整份重建，用户
    // 填了一半的内容会被冲掉）。所以日历后到这件事单独接一下：只补列表和
    // 还没选中时的默认日历。
    LaunchedEffect(calendars) { vm.onCalendarsChanged(calendars) }
    LaunchedEffect(state.finished) {
        if (!state.finished) return@LaunchedEffect
        val created = state.savedEvent
        if (state.savedViaQuick && created != null && onQuickSaved != null) {
            onQuickSaved(created)
        } else {
            onSaved()
        }
    }

    var showDeleteDialog by remember { mutableStateOf(false) }
    // 「填了一半按返回」原来是直接丢弃，一点提示都没有。用户分不清是
    // 自己按错了还是 APP 把内容弄丢了，只能重填一遍。
    var showDiscardConfirm by remember { mutableStateOf(false) }
    fun requestClose() {
        if (state.saving || state.deleting) return
        if (state.hasUnsavedChanges) showDiscardConfirm = true else onDismiss()
    }
    // 系统返回键/手势和左上角的 X 必须走同一条路，否则「点 X 会问、
    // 按返回键不会问」，等于没拦。
    BackHandler { requestClose() }
    // Pop the scope picker before save when editing a recurring event.
    // Non-recurring events save directly (sourceRrule is null).
    var showScopePicker by remember { mutableStateOf(false) }
    var showTzPicker by remember { mutableStateOf(false) }

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
                    IconButton(onClick = { requestClose() }, enabled = !state.saving && !state.deleting) {
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
        // 这个表单一共十来个字段，加起来 700dp 打底，而普通手机的内容区
        // 只有 600 出头 —— 之前它是一个不滚动的 Column（文件头注释写着
        // "All fields stack in a LazyColumn"，但代码里并没有），后果是
        // 备注框被切掉一半、编辑态最底下那个「删除」按钮在多数机器上
        // 根本点不到；系统字号调大或者横屏之后连开始/结束时间都够不着。
        // imePadding 让键盘弹起时输入框自己让位，不用用户先收键盘再滚动。
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Spacer(Modifier.size(4.dp))

            // 保存按钮是个纯图标，灰掉之后不会说话 —— 用户只看到「点了没反应」。
            // 冷启动头两秒 / 离线首启时日历列表是空的，那时候这个按钮**永远**
            // 不会亮。把原因摆出来，并给一条能自己动手的路。
            if (!state.saving && !state.deleting) {
                if (state.calendars.isEmpty()) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = stringResource(R.string.eventedit_need_calendar),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.weight(1f),
                        )
                        if (onRetryCalendars != null) {
                            TextButton(onClick = onRetryCalendars) {
                                Text(stringResource(R.string.eventedit_retry))
                            }
                        }
                    }
                } else if (state.summary.isBlank()) {
                    Text(
                        text = stringResource(R.string.eventedit_need_title),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Natural-language quick-add (create only) — type a phrase like
            // "明天 下午3点 牙医", tap 识别, and summary/start/end fill in via the
            // shared server parser (server ≥ 1.6.4; older servers fail softly).
            if (!state.isEdit) {
                var quickText by remember { mutableStateOf("") }
                OutlinedTextField(
                    value = quickText,
                    onValueChange = { quickText = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text(stringResource(R.string.quickadd_hint)) },
                    trailingIcon = {
                        if (state.parsing) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            TextButton(
                                onClick = { vm.quickParse(quickText) },
                                enabled = quickText.isNotBlank(),
                            ) { Text(stringResource(R.string.quickadd_cd)) }
                        }
                    },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { vm.quickParse(quickText) }),
                )
                // 直接保存：解析完整（标题/时间都解析出来、关键字段没再
                // 被手改）时出现，不必再点一次普通保存。和普通保存走
                // 同一条路（冲突检查在内），成功后由调用方弹「已创建」。
                if (state.quickParsed && state.canSubmit) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                    ) {
                        TextButton(onClick = { vm.saveDirectly() }) {
                            Text(stringResource(R.string.quickadd_save_directly))
                        }
                    }
                }
            }

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

            // Category — the web editor's value set, stored in
            // extra.category. "" is an explicit "none" (sends null).
            CategoryRow(
                selected = state.category,
                onSelected = vm::onCategory,
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

            // 时长快捷片：点一下把结束设成开始 + 片上时长。全天事件
            // 没有「时长」概念，不显示（与时区行同一显隐口径）。
            if (!state.allDay) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        stringResource(R.string.eventedit_duration),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    FilterChip(
                        selected = false,
                        onClick = { vm.onDurationMinutes(30) },
                        label = { Text(stringResource(R.string.eventedit_duration_30m)) },
                    )
                    FilterChip(
                        selected = false,
                        onClick = { vm.onDurationMinutes(60) },
                        label = { Text(stringResource(R.string.eventedit_duration_1h)) },
                    )
                    FilterChip(
                        selected = false,
                        onClick = { vm.onDurationMinutes(120) },
                        label = { Text(stringResource(R.string.eventedit_duration_2h)) },
                    )
                }
            }

            // Timezone (timed events only, same as iOS — for all-day
            // events the field would be misleading). The wall clock
            // above stays in the device zone; this is the event's
            // anchor zone, which the server expands recurrences and
            // exports against. Until this row existed the editor had
            // no way to see or change it at all: an event created on
            // the web for another city kept its zone invisibly, and a
            // new event silently inherited whatever buildExtra chose.
            if (!state.allDay) {
                TimezoneRow(
                    zoneId = state.zoneId,
                    onClick = { showTzPicker = true },
                )
            }

            // Reminder — event-level (extra.alarms), value sets differ
            // for timed vs all-day; see EventEditViewModel's trigger
            // lists (copied from the server's reminder_triggers.ts).
            ReminderRow(
                allDay = state.allDay,
                selected = state.reminder,
                onSelected = vm::onReminder,
            )

            // 复制事件时把重复规则的去向说在前面：Android 的复制是连
            // 重复一起复制的（修「复制丢重复」的老 bug 时定的），规则
            // 虽然就在下面编辑器里摆着，还是明说一句，免得用户以为
            // 复制出来的只是单次。
            if (initialMode is EventEditMode.Duplicate &&
                !initialMode.source.rrule.isNullOrBlank()
            ) {
                Text(
                    stringResource(R.string.eventedit_duplicate_rrule_copied),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Recurrence — RRULE editor (freq / interval / end / BYDAY).
            // A quick-add parse lands here too (the ViewModel seeds
            // rruleState from the parsed rule), so a mis-parsed 每周
            // is visible and removable instead of silently minting a
            // series on save. Unmodelable rules pass through
            // untouched; see RruleEditor.kt. On edit saves the scope
            // picker still applies first (it decides series vs
            // instance vs future); the rule itself only goes out when
            // it actually changed.
            RruleEditorSection(
                state = state.rruleState,
                onChange = vm::onRruleChange,
            )

            // Deleted occurrences of this series (edit mode) — each
            // can be restored, which removes it from exdates on save.
            if (state.isEdit && state.exdates.isNotEmpty()) {
                ExdatesSection(
                    exdates = state.exdates,
                    onRestore = vm::onRestoreExdate,
                )
            }

            // 地点 + 联想下拉：本地地址簿优先，在线兜底分组在下方、
            // 带标题区分。下拉在表单流里展开（不做浮层），点行回填；
            // 行本身不抢焦点，输入框不会因为点选先失焦把列表收掉。
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                OutlinedTextField(
                    value = state.location,
                    onValueChange = vm::onLocation,
                    label = { Text(stringResource(R.string.event_location)) },
                    placeholder = { Text(stringResource(R.string.event_location_hint)) },
                    modifier = Modifier.fillMaxWidth()
                        .onFocusChanged { vm.onLocationFocusChanged(it.isFocused) },
                    singleLine = true,
                )
                if (state.localSuggestions.isNotEmpty() || state.onlineSuggestions.isNotEmpty()) {
                    Column(
                        modifier = Modifier.fillMaxWidth()
                            .border(
                                1.dp,
                                MaterialTheme.colorScheme.outlineVariant,
                                RoundedCornerShape(8.dp),
                            )
                            .padding(vertical = 4.dp),
                    ) {
                        state.localSuggestions.forEach { suggestion ->
                            Text(
                                suggestion,
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.fillMaxWidth()
                                    .clickable { vm.onSuggestionPicked(suggestion) }
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                            )
                        }
                        if (state.onlineSuggestions.isNotEmpty()) {
                            Text(
                                stringResource(R.string.location_online_suggestions),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 2.dp),
                            )
                            state.onlineSuggestions.forEach { suggestion ->
                                Column(
                                    modifier = Modifier.fillMaxWidth()
                                        .clickable { vm.onSuggestionPicked(suggestion.label, online = suggestion) }
                                        .padding(horizontal = 12.dp, vertical = 10.dp),
                                ) {
                                    Text(
                                        suggestion.label,
                                        style = MaterialTheme.typography.bodyMedium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    // 折叠行：label 是不带单元前缀的基础
                                    // 地址，全部单元号挂在副行里；想选具体
                                    // 单元，把单元号打进查询即可命中带
                                    // unit 的那一行。unit 已点名时 label
                                    // 自带前缀，不再重复展示。
                                    if (suggestion.unit == null && suggestion.units.isNotEmpty()) {
                                        Text(
                                            stringResource(R.string.location_units, suggestion.units.joinToString(", ")),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                            // ODbL 署名：在线结果是 OpenStreetMap 数据，
                            // 展示处须带版权声明。版权行是固定文案，
                            // 不走资源本地化。
                            Text(
                                "© OpenStreetMap contributors",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 4.dp),
                            )
                        }
                    }
                }
            }

            // 购买清单区（紧跟地点之后）：已保存事件显示已关联清单 +
            // 关联已有 / 为这个事件新建；未保存（新建 / 复制）只显示
            // 「先保存」提示。关联动作统一在这里发生，见
            // ui/shopping/EventShoppingListsSection.kt。
            cn.bywave.calendar.ui.shopping.EventShoppingListsSection(
                eventId = if (state.isEdit) state.sourceId else null,
                onOpenList = { listId -> onOpenShoppingList?.invoke(listId) },
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

    if (showTzPicker) {
        TimezonePickerDialog(
            current = state.zoneId,
            onPick = { id ->
                vm.onZoneChange(id)
                showTzPicker = false
            },
            onDismiss = { showTzPicker = false },
        )
    }

    if (showDiscardConfirm) {
        AlertDialog(
            onDismissRequest = { showDiscardConfirm = false },
            title = { Text(stringResource(R.string.eventedit_discard_title)) },
            text = { Text(stringResource(R.string.eventedit_discard_message)) },
            confirmButton = {
                TextButton(onClick = {
                    showDiscardConfirm = false
                    onDismiss()
                }) { Text(stringResource(R.string.eventedit_discard_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardConfirm = false }) {
                    Text(stringResource(R.string.eventedit_keep_editing))
                }
            },
        )
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

    // Conflict confirmation — the save is paused in the VM
    // (state.pendingConflicts) and nothing has been written yet.
    // List at most 3 titles and fold the rest into a count, matching
    // the web editor's prompt.
    if (state.pendingConflicts.isNotEmpty()) {
        val conflicts = state.pendingConflicts
        val formats = rememberCalendarFormats()
        AlertDialog(
            onDismissRequest = { vm.dismissConflicts() },
            title = { Text(stringResource(R.string.conflict_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(stringResource(R.string.conflict_intro))
                    conflicts.take(3).forEach { c ->
                        val range = runCatching {
                            val start = java.time.Instant.parse(c.startsAt)
                                .atZone(ZoneId.systemDefault()).toLocalDateTime()
                            val end = java.time.Instant.parse(c.endsAt)
                                .atZone(ZoneId.systemDefault()).toLocalDateTime()
                            formats.monthDayYear.format(start.toLocalDate()) + " " +
                                formats.time.format(start) + " – " + formats.time.format(end)
                        }.getOrNull()
                        Column {
                            Text(c.summary, style = MaterialTheme.typography.bodyMedium)
                            if (range != null) {
                                Text(
                                    range,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    if (conflicts.size > 3) {
                        Text(
                            stringResource(R.string.conflict_more, conflicts.size - 3),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { vm.confirmSaveDespiteConflicts() }) {
                    Text(stringResource(R.string.conflict_save_anyway))
                }
            },
            dismissButton = {
                TextButton(onClick = { vm.dismissConflicts() }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
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
    val context = LocalContext.current
    // 日期原来写死 "yyyy 年 M 月 d 日"、时间写死 "HH:mm"，切到别的语言
    // 照样是中文年月日，手机设成 12 小时制也还是 24 小时。
    val formats = rememberCalendarFormats()
    val use24Hour = remember(context) { DateFormat.is24HourFormat(context) }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        TextButton(onClick = { showDate = true }) {
            Text(formats.monthDayYear.format(value.toLocalDate()), maxLines = 1)
        }
        if (!allDay) {
            TextButton(onClick = { showTime = true }) {
                Text(formats.time.format(value), maxLines = 1)
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
            // 跟随系统的 12/24 小时开关，而不是一律 24 小时。
            is24Hour = use24Hour,
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



/** Label resource for one reminder trigger value. Both value sets
 *  (timed + all-day) share this one mapping — the trigger literals
 *  don't overlap except "", which is "none" in both. */
private fun reminderLabelRes(trigger: String): Int = when (trigger) {
    "-PT0M" -> R.string.reminder_at_start
    "-PT5M" -> R.string.reminder_5m
    "-PT15M" -> R.string.reminder_15m
    "-PT30M" -> R.string.reminder_30m
    "-PT1H" -> R.string.reminder_1h
    "-PT2H" -> R.string.reminder_2h
    "-P1D" -> R.string.reminder_1d
    "-P1W" -> R.string.reminder_1w
    "PT9H" -> R.string.reminder_allday_same
    "-PT15H" -> R.string.reminder_allday_before
    "-P1DT15H" -> R.string.reminder_allday_2d
    "-P6DT15H" -> R.string.reminder_allday_week
    else -> R.string.reminder_none
}

@Composable
private fun ReminderRow(
    allDay: Boolean,
    selected: String,
    onSelected: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val options = reminderTriggersFor(allDay)
    Box(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = true }
                .padding(vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.event_reminder_label), modifier = Modifier.weight(1f))
            Text(text = stringResource(reminderLabelRes(selected)), color = mutedTextColor())
            Spacer(Modifier.size(8.dp))
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = mutedTextColor())
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            for (trigger in options) {
                DropdownMenuItem(
                    text = { Text(stringResource(reminderLabelRes(trigger))) },
                    onClick = {
                        onSelected(trigger)
                        expanded = false
                    },
                )
            }
        }
    }
}


/** The web editor's category values (extra.category). "" = none. */
private val CATEGORY_OPTIONS: List<Pair<String, Int>> = listOf(
    "" to R.string.category_none,
    "work" to R.string.category_work,
    "personal" to R.string.category_personal,
    "family" to R.string.category_family,
    "health" to R.string.category_health,
    "travel" to R.string.category_travel,
    "meeting" to R.string.category_meeting,
)

@Composable
private fun CategoryRow(
    selected: String,
    onSelected: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    // An unknown stored value (set by another client) still displays —
    // as itself — instead of pretending the event has no category.
    val currentLabel = CATEGORY_OPTIONS.firstOrNull { it.first == selected }
        ?.let { stringResource(it.second) }
        ?: selected.ifBlank { stringResource(R.string.category_none) }
    Box(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = true }
                .padding(vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.event_category_label), modifier = Modifier.weight(1f))
            Text(text = currentLabel, color = mutedTextColor())
            Spacer(Modifier.size(8.dp))
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = mutedTextColor())
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            for ((value, labelRes) in CATEGORY_OPTIONS) {
                DropdownMenuItem(
                    text = { Text(stringResource(labelRes)) },
                    onClick = {
                        onSelected(value)
                        expanded = false
                    },
                )
            }
        }
    }
}

/** 「已删除的单次」— occurrences the user deleted one by one from this
 *  series (the master's exdates). Restoring removes the entry from the
 *  list; the change is sent with the next save. */
@Composable
private fun ExdatesSection(
    exdates: List<String>,
    onRestore: (String) -> Unit,
) {
    val formats = rememberCalendarFormats()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = stringResource(R.string.exdates_title),
            style = MaterialTheme.typography.bodyMedium,
            color = mutedTextColor(),
        )
        exdates.forEach { iso ->
            val label = runCatching {
                val ldt = java.time.Instant.parse(iso)
                    .atZone(ZoneId.systemDefault()).toLocalDateTime()
                formats.monthDayYear.format(ldt.toLocalDate()) + " " + formats.time.format(ldt)
            }.getOrDefault(iso)
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, modifier = Modifier.weight(1f))
                TextButton(onClick = { onRestore(iso) }) {
                    Text(stringResource(R.string.exdates_restore))
                }
            }
        }
    }
}

/** The event's anchor-zone row. Shows the zone the server will expand
 *  recurrences / export against; when it differs from the device zone
 *  the device zone is spelled out underneath, so the wall clock above
 *  (which is always device-zone) can't be misread as event-zone time.
 *  Mirrors the two rows the detail sheet already shows. */
@Composable
private fun TimezoneRow(
    zoneId: String,
    onClick: () -> Unit,
) {
    val deviceZoneId = remember { ZoneId.systemDefault().id }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                stringResource(R.string.event_detail_source_timezone),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                zoneId.ifBlank { deviceZoneId },
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (zoneId.isNotBlank() && zoneId != deviceZoneId) {
                Text(
                    stringResource(R.string.event_detail_display_timezone) + ": " + deviceZoneId,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(
            stringResource(R.string.eventedit_timezone_change),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}

/** Searchable full-IANA zone picker. The web uses a curated list with
 *  search; Android's calendar form is free text, but for events a
 *  typo'd zone would be silently dropped by the server's fallback, so
 *  the picker only ever commits a real ZoneId. */
@Composable
private fun TimezonePickerDialog(
    current: String,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val allZones = remember { ZoneId.getAvailableZoneIds().sorted() }
    val deviceZoneId = remember { ZoneId.systemDefault().id }
    val filtered = remember(query, allZones) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) allZones
        else allZones.filter { it.lowercase().contains(q) || it.lowercase().replace('_', ' ').contains(q) }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.event_detail_source_timezone)) },
        text = {
            Column {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    placeholder = { Text(stringResource(R.string.eventedit_timezone_search_hint)) },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.size(8.dp))
                LazyColumn(modifier = Modifier.heightIn(max = 400.dp)) {
                    items(filtered, key = { it }) { id ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onPick(id) }
                                .padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(id, style = MaterialTheme.typography.bodyLarge)
                                val offset = zoneOffsetLabel(id)
                                val caption = when {
                                    id == deviceZoneId && offset.isNotEmpty() ->
                                        offset + " · " + stringResource(R.string.event_detail_display_timezone)
                                    else -> offset
                                }
                                if (caption.isNotEmpty()) {
                                    Text(
                                        caption,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                            if (id == current) {
                                Icon(Icons.Default.Check, contentDescription = null)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}

/** "UTC+11:00" for the zone's offset right now (DST-aware via the
 *  zone's own rules). Blank when the id doesn't resolve. */
private fun zoneOffsetLabel(id: String): String {
    val offset = runCatching { ZoneId.of(id).rules.getOffset(Instant.now()) }.getOrNull() ?: return ""
    val total = offset.totalSeconds
    val sign = if (total < 0) "-" else "+"
    val absTotal = abs(total)
    val hh = (absTotal / 3600).toString().padStart(2, '0')
    val mm = ((absTotal % 3600) / 60).toString().padStart(2, '0')
    return "UTC$sign$hh:$mm"
}
