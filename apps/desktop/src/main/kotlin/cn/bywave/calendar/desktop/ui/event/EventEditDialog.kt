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
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.AlarmDTO
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.ConflictDTO
import cn.bywave.calendar.desktop.data.model.EventAlarmsField
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventExtra
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.desktop.data.notify.alarmsOf
import cn.bywave.calendar.desktop.data.notify.buildAlarms
import cn.bywave.calendar.desktop.data.notify.keptAlarms
import cn.bywave.calendar.desktop.data.notify.mainReminder
import cn.bywave.calendar.desktop.data.notify.nextReminderValue
import cn.bywave.calendar.desktop.data.notify.reminderOptionsFor
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
import java.time.ZoneOffset
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
    /** 提醒下拉当前选中的 trigger（"" = 不提醒）。按 allDay 在
     *  ReminderTriggers 的两组枚举里选，口径见该文件头。 */
    val reminder: String = "",
    /** 打开编辑时事件原有的全部 alarms。保存时枚举外的那些（导入的
     *  自定义提醒）由 keptAlarms 原样带回，不会被下拉吞掉。 */
    val sourceAlarms: List<AlarmDTO> = emptyList(),
    /** 分类下拉的当前值（"" = 无）。取值见 EVENT_CATEGORIES；不在枚举
     *  里的存量值（导入带进来的）原样回显、原样发回，不会被吞。 */
    val category: String = "",
    /** 重复事件「已删除的单次」当前列表（原始 ISO 字符串，逐字保留，
     *  保存时整表发回）。逐条移除 = 恢复那一次。 */
    val exdates: List<String> = emptyList(),
    /** 打开编辑时的 exdates 快照：和 [exdates] 不等才随 PATCH 发
     *  （服务端整表替换语义，不传 = 不动这一列）。 */
    val sourceExdates: List<String> = emptyList(),
    // Source metadata distinguishes cleared fields from unloaded fields;
    // duplication also copies metadata this editor does not expose.
    val sourceExtra: cn.bywave.calendar.desktop.data.model.EventExtraDTO? = null,
    val originalStart: EventFormInstant? = null,
    val originalEnd: EventFormInstant? = null,
    val displayZone: ZoneId = ZoneId.systemDefault(),
    // Display changes must not redefine a newly drafted recurrence's zone.
    val creationZone: ZoneId = displayZone,
    /** 事件的锚定时区（保存时写进 extra.timezone，服务端按它展开重复 /
     *  导出）。表单上的墙上时钟永远按 displayZone 显示，这个字段只决定
     *  「这件事算哪个时区的事」。解析顺序 event → calendar → device，
     *  与 Android / iOS 编辑器一致（见 resolveEventZoneId）。 */
    val eventZone: ZoneId = displayZone,
    /** eventZone 是否已被「定死」：来自事件自带时区，或用户在选择器里
     *  亲手选过。定死后切换日历不再让时区跟着日历走。 */
    val zoneTouched: Boolean = false,
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
    /** 保存前的冲突查询。Null = 不查（直接保存）。查询失败绝不阻断保存：
     *  本对话框把任何异常都当成「没查到冲突」，照常走 onSave。 */
    onCheckConflicts: (suspend (
        calendarId: String,
        startsAt: String,
        endsAt: String,
        excludeId: String?,
    ) -> List<ConflictDTO>)? = null,
    /** 一句话「直接保存」按钮真正提交前调用一次（调用方据此给这次
     *  创建打标，成功后弹「已创建 · 打开 / 撤销」反馈条）。普通保存
     *  不调用。 */
    onQuickSaveDispatched: (() -> Unit)? = null,
    /** 地点联想的本地来源（本地地址簿）：按（输入， 事件标题）同步
     *  返回建议——标题用作上下文加权。 */
    onLocalAddressSuggestions: (String, String) -> List<String> = { _, _ -> emptyList() },
    /** 地点联想的在线兜底：本地命中不足时才调；null = 在线不可用 /
     *  已被用户在设置里关掉。失败由调用方吞成空列表。返回整条建议
     *  （带组件/坐标），选中后要学进地址簿。 */
    onOnlineAddressSuggestions: (suspend (String) -> List<cn.bywave.calendar.desktop.data.model.GeoSuggestion>)? = null,
    /** 选中一条建议时回调：online 非空 = 在线结果（调用方以 online
     *  来源 + 组件学进地址簿）；本地选中也报一声，供保存时的编辑
     *  学习知道「这是从哪条改出来的」。 */
    onSuggestionPicked: (address: String, online: cn.bywave.calendar.desktop.data.model.GeoSuggestion?) -> Unit = { _, _ -> },
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
    // 时区选择器（可搜索 IANA 全表）的开关。
    var showTzPicker by remember { mutableStateOf(false) }
    val hasUnsavedChanges: Boolean
        get() = buildBodies(form) != buildBodies(pristine)

    val scope = rememberCoroutineScope()
    // 冲突查询进行中（保存按钮转圈、不可重复点）。
    var checking by remember { mutableStateOf(false) }
    // 查到冲突、等用户决定「仍要保存 / 取消」的那一次提交。非 null 时
    // 冲突确认框盖在编辑框之上；取消只是把它收掉，编辑框原样留着。
    var pendingConflict by remember { mutableStateOf<PendingConflictSave?>(null) }

    // 提交入口抽出来,给「点保存」和「在标题里敲回车」共用。桌面端填完
    // 标题按回车就想存下,以前回车在单行输入框里什么都不做,用户要伸手
    // 去够鼠标。日期/备注这些字段不挂回车:备注是多行的,回车在那里
    // 的意思是换行。
    //
    // 真正提交前先查一次冲突（新建 + 编辑都查，编辑带 excludeId 排除
    // 自己，定时与全天都查）。有冲突先弹确认框；查询失败绝不阻断保存 ——
    // 查不到不等于有问题，挡住用户存东西才是问题。
    val submit = {
        if (form.canSubmit && !saving && !checking) {
            val (create, update) = buildBodies(form)
            // Remember the calendar a dispatched save used, so the
            // next create starts there instead of resetting to the
            // first calendar. Written at dispatch time (the dialog
            // doesn't learn the async result); if the save fails the
            // form stays open and the memory still points at the
            // user's chosen calendar.
            val dispatchSave = { c: EventCreateInput?, u: EventUpdateInput? ->
                onSave(form.isEdit, form.sourceId, form.sourceRrule, form.sourceStartsAt, c, u)
                cn.bywave.calendar.desktop.data.LastCalendarPrefs.set(form.calendarId)
            }
            val checker = onCheckConflicts
            val calId = create?.calendarId ?: update?.calendarId
            val startsAt = create?.startsAt ?: update?.startsAt
            val endsAt = create?.endsAt ?: update?.endsAt
            if (checker == null || calId == null || startsAt == null || endsAt == null) {
                dispatchSave(create, update)
            } else {
                checking = true
                scope.launch {
                    val conflicts = try {
                        checker(calId, startsAt, endsAt, if (form.isEdit) form.sourceId else null)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        emptyList()
                    }
                    checking = false
                    if (conflicts.isEmpty()) {
                        dispatchSave(create, update)
                    } else {
                        pendingConflict = PendingConflictSave(conflicts, create, update)
                    }
                }
            }
            Unit
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
                modifier = Modifier.width(480.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Natural-language quick-add (create only): type a phrase like
                // "明天 下午3点 牙医", parse it, and fill summary/start/end.
                if (!form.isEdit && onQuickParse != null) {
                    val qScope = rememberCoroutineScope()
                    var quickText by remember { mutableStateOf("") }
                    var parsing by remember { mutableStateOf(false) }
                    // 解析成功过一次后置 true：下面多一个「直接保存」按钮，
                    // 不关表单直接提交当前表单内容（解析后又手改过也以
                    // 眼前表单为准）。改动一句话原文即清掉，免得拿着旧
                    // 解析结果误导。
                    var quickFilled by remember { mutableStateOf(false) }
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
                                        // 地点 / 全天 / 重复与网页端同一口径：
                                        // 解析没说到的字段不覆盖用户已填的
                                        // 内容；说到了就填进去（重复规则走
                                        // RruleState.fromRrule，BYDAY 等编辑
                                        // 器不建模的字段会原样透传）。
                                        val newAllDay = parsed.allDay ?: form.allDay
                                        val first = EventPickerDraft(start, parseZone, newAllDay).withDisplayZone(form.displayZone)
                                        val last = EventPickerDraft(end, parseZone, newAllDay).withDisplayZone(form.displayZone)
                                        form = form.copy(
                                            summary = if (parsed.summary.isNotBlank()) parsed.summary else form.summary,
                                            location = if (!parsed.location.isNullOrBlank()) parsed.location else form.location,
                                            allDay = newAllDay,
                                            rrule = if (parsed.rrule != null) RruleState.fromRrule(parsed.rrule) else form.rrule,
                                            start = first.value, end = last.value,
                                            originalStart = first.original, originalEnd = last.original,
                                        )
                                        // 标题是解析出来的才算「完整」：只有时间
                                        // 没有标题的句子不给直接保存（存下去是
                                        // 个无名事件）。canSubmit 还会再把一道关。
                                        quickFilled = parsed.summary.isNotBlank()
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
                        onValueChange = { quickText = it; quickFilled = false },
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
                    // 直接保存：解析完整后出现。走的还是 submit() 这条路
                    // （冲突检查、clientUid 幂等都一样），只是提交前通知
                    // 调用方打标，成功后主界面弹「已创建」反馈条；有冲突
                    // 时 submit() 自己会弹冲突确认框，不会硬存。
                    if (quickFilled && form.canSubmit && !saving) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.End,
                        ) {
                            TextButton(onClick = {
                                onQuickSaveDispatched?.invoke()
                                submit()
                            }) {
                                Text(t("event.edit.quickadd.saveDirectly"))
                            }
                        }
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
                    onSelect = { form = form.withCalendarSelection(it, calendars) },
                )

                CategoryPicker(
                    selected = form.category,
                    onSelect = { form = form.copy(category = it) },
                )

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t("event.edit.allDay"), modifier = Modifier.weight(1f))
                    Switch(
                        checked = form.allDay,
                        onCheckedChange = { v ->
                            // 全天一换，提醒档位要跟着换组：属于目标组的留着，
                            // 不属于的换成目标组默认档（和网页端口径一致）。
                            form = if (v) form.copy(
                                allDay = true,
                                start = form.start.toLocalDate().atStartOfDay(),
                                end = maxOf(form.start.toLocalDate(), form.end.toLocalDate()).atTime(23, 59),
                                originalStart = null, originalEnd = null,
                                reminder = nextReminderValue(form.reminder, true),
                            ) else form.copy(
                                allDay = false,
                                end = form.start.plusHours(1),
                                originalStart = null, originalEnd = null,
                                reminder = nextReminderValue(form.reminder, false),
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

                // 时长快捷片：点一下把结束设成开始 + 片上时长，省得在结束
                // 时间里手算。全天事件没有「时长」概念，不显示。
                if (!form.allDay) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            t("event.edit.duration"),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        listOf(30L to "event.edit.duration30m", 60L to "event.edit.duration1h", 120L to "event.edit.duration2h")
                            .forEach { (minutes, labelKey) ->
                                OutlinedButton(onClick = {
                                    val startInstant = draftInstant(form.start, form.displayZone, form.originalStart)
                                    val newEnd = startInstant.plus(java.time.Duration.ofMinutes(minutes))
                                        .atZone(form.displayZone).toLocalDateTime()
                                    form = form.withEnd(newEnd)
                                }) { Text(t(labelKey)) }
                            }
                    }
                }

                // 日程时区行（仅定时事件）：表单墙上时钟永远按设备时区
                // 显示，这里选的是事件的锚定时区——服务端按它展开重复、
                // 导出。与设备时区不同时把设备时区写在下面，免得把上面
                // 的时间误读成日程时区的时间。口径与 Android 的
                // TimezoneRow 一致；此前桌面端完全没有这个入口，事件的
                // 时区只能原样保留、永远改不了。
                if (!form.allDay) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                t("event.detail.sourceTimezone"),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                form.eventZone.id,
                                style = MaterialTheme.typography.bodyLarge,
                                maxLines = 1,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            )
                            if (form.eventZone != form.displayZone) {
                                Text(
                                    t("event.detail.displayTimezone") + ": " + form.displayZone.id,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        TextButton(onClick = { showTzPicker = true }) {
                            Text(t("event.edit.timezoneChange"))
                        }
                    }
                }

                ReminderPicker(
                    allDay = form.allDay,
                    selected = form.reminder,
                    onSelect = { form = form.copy(reminder = it) },
                )
                // 枚举外的既有提醒（导入的自定义值）不在下拉里，但保存时会
                // 原样带回去 —— 看不见的东西要说一声，和网页端的提示同理。
                val keptCount = keptAlarms(form.sourceAlarms, form.allDay).size
                if (keptCount > 0) {
                    Text(
                        cn.bywave.calendar.desktop.i18n.I18n.t(
                            "event.edit.reminderExtraKept",
                            mapOf("n" to keptCount),
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                // 地点 + 联想下拉：本地地址簿优先（同步取），本地不足
                // 3 条才防抖查在线兜底。在线结果带分组标题区分，选中
                // 时回调 onAddressPicked 写回本地。下��在表单流里展开
                // （不做浮层）：滚动对话框里浮层定位容易错位，流内展开
                // 简单可靠。
                var locationFocused by remember { mutableStateOf(false) }
                var onlineSuggestions by remember { mutableStateOf<List<cn.bywave.calendar.desktop.data.model.GeoSuggestion>>(emptyList()) }
                val localSuggestions = if (locationFocused) {
                    onLocalAddressSuggestions(form.location, form.summary)
                } else {
                    emptyList()
                }
                LaunchedEffect(form.location, locationFocused) {
                    onlineSuggestions = emptyList()
                    if (!locationFocused || onOnlineAddressSuggestions == null) return@LaunchedEffect
                    val q = form.location.trim()
                    if (q.length < 3 || localSuggestions.size >= 3) return@LaunchedEffect
                    kotlinx.coroutines.delay(300)
                    onlineSuggestions = runCatching { onOnlineAddressSuggestions(q) }
                        .getOrDefault(emptyList())
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    OutlinedTextField(
                        value = form.location,
                        onValueChange = { form = form.copy(location = it) },
                        label = { Text(t("event.edit.location")) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                            .onFocusChanged { locationFocused = it.isFocused },
                    )
                    if (locationFocused && (localSuggestions.isNotEmpty() || onlineSuggestions.isNotEmpty())) {
                        Column(
                            modifier = Modifier.fillMaxWidth()
                                .border(
                                    1.dp,
                                    MaterialTheme.colorScheme.outlineVariant,
                                    RoundedCornerShape(8.dp),
                                )
                                .padding(vertical = 4.dp),
                        ) {
                            localSuggestions.forEach { suggestion ->
                                Text(
                                    suggestion,
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1,
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                    modifier = Modifier.fillMaxWidth()
                                        .clickable {
                                            form = form.copy(location = suggestion)
                                            onSuggestionPicked(suggestion, null)
                                        }
                                        .padding(horizontal = 12.dp, vertical = 8.dp),
                                )
                            }
                            if (onlineSuggestions.isNotEmpty()) {
                                Text(
                                    t("event.edit.locationOnline"),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 2.dp),
                                )
                                onlineSuggestions.forEach { suggestion ->
                                    Column(
                                        modifier = Modifier.fillMaxWidth()
                                            .clickable {
                                                form = form.copy(location = suggestion.label)
                                                onSuggestionPicked(suggestion.label, suggestion)
                                            }
                                            .padding(horizontal = 12.dp, vertical = 8.dp),
                                    ) {
                                        Text(
                                            suggestion.label,
                                            style = MaterialTheme.typography.bodyMedium,
                                            maxLines = 1,
                                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                        )
                                        // 折叠行：label 是不带单元前缀的
                                        // 基础地址，全部单元号挂在副行里；
                                        // 想选具体单元，把单元号打进查询
                                        // 即可命中带 unit 的那一行。unit
                                        // 已点名时 label 自带前缀，不重复。
                                        if (suggestion.unit == null && suggestion.units.isNotEmpty()) {
                                            Text(
                                                cn.bywave.calendar.desktop.i18n.I18n.t(
                                                    "event.edit.locationUnits",
                                                    mapOf("units" to suggestion.units.joinToString(", ")),
                                                ),
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                }
                                // ODbL 署名：在线结果是 OpenStreetMap 数据，
                                // 展示处须带版权声明。版权行是固定文案，
                                // 不走 i18n。
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

                // 复制带重复规则的事件时把话说在前面：桌面端的复制按
                // 设计不带重复规则（避免误开一条平行系列），但以前是
                // 静默丢掉，用户存完才发现新事件只出现一次。
                if (mode is EventEditMode.Duplicate && !mode.source.rrule.isNullOrBlank()) {
                    Text(
                        t("event.edit.duplicateRruleDropped"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                RruleEditor(state = form.rrule, onChange = { form = form.copy(rrule = it) })

                // 「已删除的单次」：重复事件被逐次删掉的那些出现次。
                // 逐条恢复（从列表里移除）后随保存整表发回；这里不提供
                // 手动新增 —— 新增例外就是删单次，走范围选择流程。
                if (form.isEdit && form.sourceRrule != null && form.exdates.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            t("event.edit.exdates"),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.outline,
                        )
                        for (ex in form.exdates) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    formatExdate(ex, form.allDay, form.displayZone),
                                    modifier = Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                TextButton(
                                    onClick = { form = form.copy(exdates = form.exdates - ex) },
                                ) {
                                    Text(t("event.edit.exdates.restore"))
                                }
                            }
                        }
                    }
                }

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
                enabled = form.canSubmit && !saving && !checking,
            ) {
                if (saving || checking) {
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

    if (showTzPicker) {
        TimezonePickerDialog(
            current = form.eventZone,
            deviceZone = form.displayZone,
            onPick = { zone ->
                form = form.withZoneSelection(zone)
                showTzPicker = false
            },
            onDismiss = { showTzPicker = false },
        )
    }

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

    // 冲突确认框：盖在编辑框之上。列最多 3 条，其余折叠成「还有 N 条」；
    // 「仍要保存」把刚才那一次提交原样发出去，「取消」只是收掉本框，
    // 编辑框里的内容一字不动。
    pendingConflict?.let { pending ->
        AlertDialog(
            onDismissRequest = { pendingConflict = null },
            title = {
                Text(
                    t("event.edit.conflict.title"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(t("event.edit.conflict.intro"))
                    for (conflict in pending.conflicts.take(3)) {
                        Text("• " + conflict.summary.ifBlank { t("reminder.untitled") })
                    }
                    if (pending.conflicts.size > 3) {
                        Text(
                            cn.bywave.calendar.desktop.i18n.I18n.t(
                                "event.edit.conflict.more",
                                mapOf("n" to pending.conflicts.size - 3),
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            confirmButton = {
                Button(onClick = {
                    pendingConflict = null
                    onSave(form.isEdit, form.sourceId, form.sourceRrule, form.sourceStartsAt, pending.create, pending.update)
                    cn.bywave.calendar.desktop.data.LastCalendarPrefs.set(form.calendarId)
                }) {
                    Text(t("event.edit.conflict.saveAnyway"))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingConflict = null }) { Text(t("event.edit.cancel")) }
            },
        )
    }
}

/** 一次被冲突拦下来的提交：查到的冲突 + 已经拼好的请求体。
 *  用户点「仍要保存」时原样发出去，不重新拼 —— 重新拼就可能和他刚
 *  确认过的那一份不一样了。 */
private data class PendingConflictSave(
    val conflicts: List<ConflictDTO>,
    val create: EventCreateInput?,
    val update: EventUpdateInput?,
)

/** 提醒下拉：按 allDay 出两组枚举里的一组，形状和 CalendarPicker 一致。 */
@Composable
private fun ReminderPicker(
    allDay: Boolean,
    selected: String,
    onSelect: (String) -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    var open by remember { mutableStateOf(false) }
    val options = reminderOptionsFor(allDay)
    val current = options.firstOrNull { it.value == selected } ?: options.first()

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            t("event.edit.reminder"),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        Box {
            OutlinedButton(
                onClick = { open = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    t(current.labelKey),
                    modifier = Modifier.weight(1f),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Start,
                )
                Text("▾", color = MaterialTheme.colorScheme.outline)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                for (option in options) {
                    DropdownMenuItem(
                        text = { Text(t(option.labelKey)) },
                        onClick = {
                            onSelect(option.value)
                            open = false
                        },
                    )
                }
            }
        }
    }
}

/** 分类取值与网页端编辑器同一组，存 extra.category。 */
internal val EVENT_CATEGORIES: List<String> =
    listOf("work", "personal", "family", "health", "travel", "meeting")

/** 分类下拉：形状和 ReminderPicker 一致。存量值不在枚举里（导入带
 *  进来的）时把它作为额外选项原样回显 — 不显示就会在保存时被换掉。 */
@Composable
private fun CategoryPicker(
    selected: String,
    onSelect: (String) -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    var open by remember { mutableStateOf(false) }
    val options = listOf("") + EVENT_CATEGORIES +
        if (selected.isNotEmpty() && selected !in EVENT_CATEGORIES) listOf(selected) else emptyList()

    fun label(value: String): String = when {
        value.isEmpty() -> t("event.edit.category.none")
        value in EVENT_CATEGORIES -> t("event.edit.category.$value")
        else -> value
    }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            t("event.edit.category"),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
        Box {
            OutlinedButton(
                onClick = { open = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    label(selected),
                    modifier = Modifier.weight(1f),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Start,
                )
                Text("▾", color = MaterialTheme.colorScheme.outline)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                for (option in options) {
                    DropdownMenuItem(
                        text = { Text(label(option)) },
                        onClick = {
                            onSelect(option)
                            open = false
                        },
                    )
                }
            }
        }
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
private val EXDATE_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

/** 「已删除的单次」列表里一条的显示文本。exdates 存的是 canonical
 *  ISO 时刻：全天事件按 UTC 日期读（全天一律 UTC 展开），定时事件按
 *  编辑框当前的显示时区读。解析不了就原样显示字符串，不丢信息。 */
internal fun formatExdate(iso: String, allDay: Boolean, zone: ZoneId): String {
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return iso
    return if (allDay) {
        instant.atZone(ZoneOffset.UTC).toLocalDate().format(DATE_FMT)
    } else {
        instant.atZone(zone).format(EXDATE_FMT)
    }
}

internal fun FormState.withCalendars(calendars: List<CalendarMeta>): FormState {
    val filled = if (calendarId.isBlank() && calendars.isNotEmpty()) {
        copy(calendarId = calendars.first().id)
    } else {
        this
    }
    // 日历列表是后到的（对话框打开时可能还没加载完）：时区没被定死时，
    // 按填好的日历重新解析一次，不然新建事件会一直用设备时区，
    // 错过它所在日历的时区。
    if (filled.zoneTouched || calendars.isEmpty()) return filled
    val calTz = calendars.firstOrNull { it.id == filled.calendarId }?.timezone
    return filled.copy(eventZone = resolveEventZoneId(null, calTz, filled.displayZone))
}

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
            val initialCalendar = calendars.firstOrNull { it.id == lastCalendarId }
                ?: calendars.firstOrNull()
            FormState(
                isEdit = false,
                sourceId = null,
                sourceRrule = null,
                sourceStartsAt = null,
                calendarId = initialCalendar?.id.orEmpty(),
                // 新事件的时区：初始日历的时区，没有就设备时区。
                eventZone = resolveEventZoneId(null, initialCalendar?.timezone, displayZone),
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
            val sourceAlarms = alarmsOf(s.extra)
            val sourceStart = eventFormDateTime(s.startsAt, s.allDay, displayZone)
            val sourceEnd = eventFormDateTime(s.endsAt, s.allDay, displayZone)
            FormState(
                isEdit = true,
                sourceId = s.id,
                sourceRrule = s.rrule,
                sourceStartsAt = s.startsAt,
                calendarId = s.calendarId,
                // 事件自带时区优先，其次日历、最后设备；事件自带时视为
                // 已定死（zoneTouched），切换日历不许把它冲掉。
                eventZone = resolveEventZoneId(
                    s.extra?.timezone,
                    calendars.firstOrNull { it.id == s.calendarId }?.timezone,
                    displayZone,
                ),
                zoneTouched = s.extra?.timezone?.let {
                    runCatching { ZoneId.of(it) }.isSuccess
                } ?: false,
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
                reminder = mainReminder(sourceAlarms, s.allDay),
                sourceAlarms = sourceAlarms,
                category = s.extra?.category.orEmpty(),
                exdates = s.exdates.orEmpty(),
                sourceExdates = s.exdates.orEmpty(),
                sourceExtra = s.extra,
                originalStart = sourceStart?.takeIf { !s.allDay }?.let { EventFormInstant(s.startsAt, it) },
                originalEnd = sourceEnd?.takeIf { !s.allDay }?.let { EventFormInstant(s.endsAt, it) },
            )
        }
        is EventEditMode.Duplicate -> {
            val s = mode.source
            val sourceAlarms = alarmsOf(s.extra)
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
                // 复制带上原事件的时区口径（解析顺序同编辑）：复制的是
                // 同一件事的新副本，换时区才是意外。
                eventZone = resolveEventZoneId(
                    s.extra?.timezone,
                    calendars.firstOrNull { it.id == s.calendarId }?.timezone,
                    displayZone,
                ),
                zoneTouched = s.extra?.timezone?.let {
                    runCatching { ZoneId.of(it) }.isSuccess
                } ?: false,
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
                reminder = mainReminder(sourceAlarms, s.allDay),
                sourceAlarms = sourceAlarms,
                category = s.extra?.category.orEmpty(),
                // exdates 不复制：复制出来的是新事件，例外列表没有意义，
                // 且建事件接口本来就不收 exdates。
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
    // The server shallow-merges extra keys: an omitted key keeps its stored
    // value, an explicit null deletes it. Only send fields this editor
    // manages. Category used to be replayed only on create/duplicate —
    // replaying a value the form never showed could overwrite a concurrent
    // edit. The form now has a real category picker, so it sends the
    // user's current selection like every other managed field (and an
    // explicit null when they pick "none" on an event that had one).
    val src = form.sourceExtra
    // Alarms ARE managed by this editor now (the reminder dropdown), with
    // one exception: editing a partial event whose extra was never loaded
    // (src == null, e.g. promoted from search results) must not touch
    // alarms at all — sending the explicit null there would delete
    // reminders this form never saw. Otherwise the field always goes out:
    // the built list, or an explicit null when the user picked "none"
    // and no custom alarms remain (omitting it would keep the old value,
    // so "no reminder" could never be saved).
    val managesAlarms = !form.isEdit || src != null
    val alarmsField = if (managesAlarms) {
        val built = buildAlarms(form.reminder, form.summary, form.sourceAlarms, form.allDay)
        EventAlarmsField(if (built.isEmpty()) null else built)
    } else {
        null
    }
    val extra = run {
        val merged = EventExtra(
            // 事件时区（extra.timezone）：表单解析出的 eventZone，口径与
            // Android / iOS 一致（event → calendar → device）。两个例外：
            //  · 全天事件保持旧口径：事件自己的时区原样保留、新建不写
            //    （全天按日历日走，锚定时区在全天语义里不参与展开）；
            //  · 编辑一个 extra 没加载进来的事件（如搜索提升桩）且用户
            //    没亲手改过时区时，一个字都不发——解析出的时区只是
            //    猜测，发出去会覆盖事件真正存着的时区，和 alarms 的
            //    未加载保护同一条规矩。
            timezone = when {
                form.allDay -> src?.timezone
                form.isEdit && src == null && !form.zoneTouched -> null
                else -> form.eventZone.id
            },
            attendees = attendees,
            category = eventStringField(form.category, clearWhenEmpty = form.isEdit && src != null),
            url = eventStringField(urlTrim, clearWhenEmpty = form.isEdit && src != null),
            meetingPassword = eventStringField(pwTrim, clearWhenEmpty = form.isEdit && src != null),
            alarms = alarmsField,
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
            // 整表替换语义：只有用户真的移除过条目才发（发当时的完整
            // 剩余列表，字符串逐字保留）；没动过就不带这个字段，
            // 服务端不会碰这一列。若同一次保存还改了系列起点/时区，
            // 服务端会先把这份列表按新时间线平移再落库。
            exdates = if (form.exdates != form.sourceExdates) form.exdates else null,
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

/** 可搜索的 IANA 全表时区选择器，与 Android 的 TimezonePickerDialog
 *  同一形状：搜索按 id 子串匹配（下划线也当空格），每行带当前 UTC
 *  偏移，设备时区额外标注，当前时区打勾。只提交真实存在的 ZoneId —
 *  野值会被服务端静默回落，绝不能让用户「选」出一个野值来。 */
@Composable
private fun TimezonePickerDialog(
    current: ZoneId,
    deviceZone: ZoneId,
    onPick: (ZoneId) -> Unit,
    onDismiss: () -> Unit,
) {
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }
    var query by remember { mutableStateOf("") }
    val allZones = remember { ZoneId.getAvailableZoneIds().sorted() }
    val filtered = remember(query, allZones) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) {
            allZones
        } else {
            allZones.filter { it.lowercase().contains(q) || it.lowercase().replace('_', ' ').contains(q) }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(t("event.detail.sourceTimezone")) },
        text = {
            Column {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    placeholder = { Text(t("event.edit.timezoneSearch")) },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                LazyColumn(modifier = Modifier.heightIn(max = 360.dp)) {
                    items(filtered, key = { it }) { id ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    runCatching { ZoneId.of(id) }.getOrNull()?.let(onPick)
                                }
                                .padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(id, style = MaterialTheme.typography.bodyLarge)
                                val offset = zoneOffsetLabel(id)
                                val caption = when {
                                    id == deviceZone.id && offset.isNotEmpty() ->
                                        offset + " · " + t("event.detail.displayTimezone")
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
                            if (id == current.id) {
                                Text("✓", color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(t("common.cancel")) }
        },
    )
}

/** "UTC+10:00" 形式的当前偏移标注（与 Android zoneOffsetLabel 同口径）。 */
private fun zoneOffsetLabel(id: String): String {
    val offset = runCatching { ZoneId.of(id).rules.getOffset(Instant.now()) }.getOrNull() ?: return ""
    val total = offset.totalSeconds
    val sign = if (total < 0) "-" else "+"
    val absTotal = kotlin.math.abs(total)
    val hh = (absTotal / 3600).toString().padStart(2, '0')
    val mm = ((absTotal % 3600) / 60).toString().padStart(2, '0')
    return "UTC$sign$hh:$mm"
}

/** Round current time up to the next :00 or :30. Sane default for
 *  "new event" so users don't have to set a time first. */
internal fun nextHalfHour(zone: ZoneId = ZoneId.systemDefault(), instant: Instant = Instant.now()): LocalDateTime {
    val now = instant.atZone(zone).toLocalDateTime()
    return if (now.minute < 30) now.withMinute(30).withSecond(0).withNano(0)
           else now.plusHours(1).withMinute(0).withSecond(0).withNano(0)
}
