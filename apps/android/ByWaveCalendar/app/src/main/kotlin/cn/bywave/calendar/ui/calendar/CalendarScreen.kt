// Top-level calendar screen. View-mode tabs (Day/Week/Month) + nav
// bar (prev / today / next + refresh + settings) + FAB to create
// events. Event tap opens EventDetailSheet; "edit" from there →
// EventEditScreen; FAB → EventEditScreen in create mode.
//
// Navigation between detail sheet and edit screen / settings is owned
// by the parent (MainActivity NavHost) via callbacks; CalendarScreen
// stays declarative.

package cn.bywave.calendar.ui.calendar

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import cn.bywave.calendar.ui.offline.PendingSyncBar
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.TextButton
import androidx.compose.ui.draw.clip
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SnackbarDuration
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.auth.SignedOutNotice
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.ui.event.EventActionsSheet
import cn.bywave.calendar.ui.event.EventDetailSheet
import cn.bywave.calendar.ui.event.RecurringAction
import cn.bywave.calendar.ui.event.RecurringScope
import cn.bywave.calendar.ui.event.RecurringScopePicker
import cn.bywave.calendar.ui.components.rememberReduceMotion
import cn.bywave.calendar.ui.profile.ProfileSwitcherDialog
import cn.bywave.calendar.ui.theme.MultiAccountGreen
import cn.bywave.calendar.ui.theme.Sizing

/** 主区域当前是哪一「页」：首拉加载态，或日/周/月之一。AnimatedContent
 *  以它为 targetState 做过渡，加载完成和切视图都走同一条淡入淡出。 */
private enum class CalendarPane { Loading, Day, Week, Month }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(
    onOpenSettings: () -> Unit,
    onCreateEvent: () -> Unit,
    onEditEvent: (EventDTO) -> Unit,
    onDuplicateEvent: (EventDTO) -> Unit,
    onOpenAttendees: (EventDTO) -> Unit,
    onAddAccount: () -> Unit,
    /** 「某账号已被登出」提示条上的「重新登录」：登录页要预填这个账号，不是一张空白页。 */
    onSignInAgain: (SignedOutNotice) -> Unit,
    onOpenSearch: () -> Unit,
    onOpenInvitations: () -> Unit,
    /** 购买清单页入口（顶栏购物车图标，与设置同层级）。 */
    onOpenShoppingLists: () -> Unit = {},
    /** 离线队列页：待同步指示条点进去逐条看 / 裁决待处理。 */
    onOpenOfflineQueue: () -> Unit,
    vm: CalendarViewModel = viewModel(),
) {
    val profiles = remember { BywaveApp.instance.profiles }
    val profilesList by profiles.profiles.collectAsState()
    val activeId by profiles.activeId.collectAsState()
    val active = profilesList.firstOrNull { it.id == activeId }
    // 被服务端登出、而本机还登着别的账号时的说明（一次显示一条）。见 SignedOutBanner。
    val signedOutNotices by profiles.signedOutNotices.collectAsState()

    val state by vm.state.collectAsState()
    val pendingOps by vm.pendingOps.collectAsState()
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(vm, lifecycleOwner, activeId) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            vm.refreshIfIdle()
            while (true) {
                kotlinx.coroutines.delay(15_000)
                vm.refreshIfIdle()
            }
        }
    }
    // Subtle haptic on primary (FAB create) + destructive (delete confirm)
    // taps, to match the iOS app's feel. Long-press already buzzes via
    // Compose's built-in combinedClickable haptic.
    val haptic = LocalHapticFeedback.current
    var selectedEvent by remember { mutableStateOf<EventDTO?>(null) }
    var actionsForEvent by remember { mutableStateOf<EventDTO?>(null) }
    var pendingDelete by remember { mutableStateOf<EventDTO?>(null) }
    // Separate state for "delete confirmed, but it's a recurring event,
    // need to ask which scope". The AlertDialog is intentionally still
    // shown for non-recurring events as a safety net; recurring events
    // skip the dialog and go straight to the scope picker since picking
    // a scope IS the confirmation.
    var pendingRecurringDelete by remember { mutableStateOf<EventDTO?>(null) }
    var showSwitcher by remember { mutableStateOf(false) }

    // 外部请求打开某个事件的详情（搜索结果点开、快速添加后点「打开」）。
    // selectedEvent 是本屏自己的状态，VM 只负责把请求递进来。
    LaunchedEffect(state.detailRequest) {
        val req = state.detailRequest ?: return@LaunchedEffect
        selectedEvent = req
        vm.clearDetailRequest()
    }

    // Undo-delete snackbar (parity with web). deleteEvent sets undoDeleteId for
    // non-recurring deletes; act on it → restore, dismiss → clear the one-shot.
    val snackbarHostState = remember { SnackbarHostState() }
    val undoLabel = stringResource(R.string.action_undo)
    val deletedMsg = stringResource(R.string.event_deleted)
    LaunchedEffect(state.undoDeleteId) {
        if (state.undoDeleteId != null) {
            val result = snackbarHostState.showSnackbar(
                message = deletedMsg,
                actionLabel = undoLabel,
                duration = SnackbarDuration.Short,
            )
            if (result == SnackbarResult.ActionPerformed) vm.restoreLastDelete() else vm.clearUndo()
        }
    }

    // 一句话直接保存后的反馈：「已创建：标题 · 撤销」。撤销走 deleteEvent，
    // 删完它自己还会再给一次恢复入口（和普通删除同一条链）。
    //
    // Snackbar 只有一个动作位，撤销与「查看」的取舍：撤销是限时的——
    // 提示消失就没了，而一句话直存没经过表单复核，误解析的逃生口必须
    // 在这几秒里够得着；查看不是限时的——事件就在身后的日历格子里，
    // 随时点得开。所以动作位留给撤销，作为补偿把标题本身做成可点：
    // 点标题经 detailRequest 打开详情（与搜索结果同一条路）。为此这条
    // 提示用自己的 host + 自定义 Snackbar 渲染（消息区可点、动作按钮
    // 照旧），删除撤销的那条仍走默认渲染，互不影响。
    val createdSnackbarHostState = remember { SnackbarHostState() }
    var createdTapTarget by remember { mutableStateOf<EventDTO?>(null) }
    val createdMsgTemplate = stringResource(R.string.event_created_notice)
    LaunchedEffect(state.createdNotice) {
        val notice = state.createdNotice ?: return@LaunchedEffect
        createdTapTarget = notice
        val result = createdSnackbarHostState.showSnackbar(
            message = createdMsgTemplate.replace("%1\$s", notice.summary),
            actionLabel = undoLabel,
            duration = SnackbarDuration.Short,
        )
        if (result == SnackbarResult.ActionPerformed) vm.deleteEvent(notice.id)
        createdTapTarget = null
        vm.clearCreatedNotice()
    }

    Scaffold(
        snackbarHost = {
            Column {
                SnackbarHost(createdSnackbarHostState) { data ->
                    val target = createdTapTarget
                    Snackbar(
                        action = {
                            TextButton(onClick = { data.performAction() }) {
                                Text(undoLabel)
                            }
                        },
                    ) {
                        Text(
                            data.visuals.message,
                            if (target != null) {
                                Modifier.clickable {
                                    vm.requestDetail(target)
                                    data.dismiss()
                                }
                            } else {
                                Modifier
                            },
                        )
                    }
                }
                SnackbarHost(snackbarHostState)
            }
        },
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(stringResource(R.string.calendar_title)) },
                navigationIcon = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.Settings, contentDescription = stringResource(R.string.settings_title))
                    }
                },
                actions = {
                    // 购买清单 — 与左上角的设置同层级的一级入口。
                    IconButton(onClick = onOpenShoppingLists) {
                        Icon(Icons.Default.ShoppingCart, contentDescription = stringResource(R.string.shopping_title))
                    }
                    // 我收到的邀请 — 徽章数 = 未处理数（待回复且未取消、
                    // 未过期），由 CalendarViewModel 随事件刷新同节拍更新。
                    BadgedBox(
                        badge = {
                            if (state.pendingInvitations > 0) {
                                Badge { Text(state.pendingInvitations.toString()) }
                            }
                        },
                    ) {
                        IconButton(onClick = onOpenInvitations) {
                            Icon(
                                Icons.Outlined.Email,
                                contentDescription = stringResource(R.string.invitations_title),
                            )
                        }
                    }
                    IconButton(onClick = onOpenSearch) {
                        Icon(Icons.Default.Search, contentDescription = stringResource(R.string.cal_cd_search))
                    }
                    IconButton(onClick = { vm.reload() }, enabled = !state.loading) {
                        Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.cal_cd_refresh))
                    }
                    // Avatar badge — opens the profile switcher. Shows
                    // a small green dot when there's more than one
                    // profile to hint the multi-account feature.
                    //
                    // The visible circle is 36dp, but we wrap it in a
                    // 48dp clickable IconButton-sized box so the touch
                    // target meets the accessibility minimum and the
                    // ripple reads like the other top-bar actions.
                    Box(
                        modifier = Modifier
                            .padding(end = 4.dp)
                            .size(Sizing.minTouchTarget)
                            .clip(CircleShape)
                            .clickable(
                                onClickLabel = stringResource(R.string.cal_switch_account),
                            ) { showSwitcher = true },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(Sizing.avatar)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = active?.initial ?: "?",
                                color = MaterialTheme.colorScheme.onPrimary,
                                fontWeight = FontWeight.SemiBold,
                            )
                            if (profilesList.size > 1) {
                                Box(
                                    modifier = Modifier
                                        .align(Alignment.BottomEnd)
                                        .size(Sizing.calendarDotSmall)
                                        .clip(CircleShape)
                                        .background(MaterialTheme.colorScheme.surface),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(7.dp)
                                            .clip(CircleShape)
                                            .background(MultiAccountGreen),
                                    )
                                }
                            }
                        }
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onCreateEvent()
            }) {
                Icon(Icons.Default.Add, contentDescription = stringResource(R.string.event_new))
            }
        },
    ) { innerPadding ->
        CalendarBody(
            state = state,
            innerPadding = innerPadding,
            onModeChange = vm::setMode,
            onPrev = { vm.shiftAnchor(-1) },
            onNext = { vm.shiftAnchor(+1) },
            onToday = { vm.goToday() },
            onRetry = { vm.reload() },
            onEventClick = { selectedEvent = it },
            onEventLongPress = { actionsForEvent = it },
            onDayClick = { day ->
                vm.setMode(ViewMode.Day)
                vm.setAnchor(day)
            },
            eventsForDay = { vm.eventsForDay(it) },
            topNotice = {
                val notice = signedOutNotices.firstOrNull()
                if (notice != null) {
                    SignedOutBanner(
                        notice = notice,
                        currentEmail = active?.email,
                        onSignInAgain = { onSignInAgain(notice) },
                        onDismiss = { profiles.dismissSignedOutNotice(notice) },
                    )
                }
                if (pendingOps.isNotEmpty()) {
                    PendingSyncBar(
                        pendingCount = pendingOps.count {
                            it.state == cn.bywave.calendar.sync.PendingOpState.PENDING
                        },
                        attentionCount = pendingOps.count {
                            it.state == cn.bywave.calendar.sync.PendingOpState.ATTENTION
                        },
                        onClick = onOpenOfflineQueue,
                    )
                }
            },
        )
    }

    if (showSwitcher) {
        ProfileSwitcherDialog(
            profiles = profilesList,
            activeId = activeId,
            onPick = { p ->
                showSwitcher = false
                if (p.id != activeId) profiles.setActive(p.id)
            },
            onAddAccount = {
                showSwitcher = false
                onAddAccount()
            },
            onDismiss = { showSwitcher = false },
        )
    }

    val ev = selectedEvent
    if (ev != null) {
        EventDetailSheet(
            event = ev,
            calendars = state.calendars,
            onDismiss = { selectedEvent = null },
            onEdit = {
                selectedEvent = null
                onEditEvent(ev)
            },
            onOpenAttendees = {
                selectedEvent = null
                onOpenAttendees(ev)
            },
        )
    }

    val actionsEv = actionsForEvent
    if (actionsEv != null) {
        EventActionsSheet(
            event = actionsEv,
            calendars = state.calendars,
            onEdit = {
                actionsForEvent = null
                onEditEvent(actionsEv)
            },
            onDuplicate = {
                actionsForEvent = null
                onDuplicateEvent(actionsEv)
            },
            onDelete = {
                actionsForEvent = null
                // Recurring events route to the scope picker — without
                // it, the server defaults to "series" and wipes the
                // entire repeating set. Non-recurring events use the
                // simple confirm dialog.
                if (!actionsEv.rrule.isNullOrBlank()) {
                    pendingRecurringDelete = actionsEv
                } else {
                    pendingDelete = actionsEv
                }
            },
            onOpenAttendees = {
                actionsForEvent = null
                onOpenAttendees(actionsEv)
            },
            onDismiss = { actionsForEvent = null },
        )
    }

    val pd = pendingDelete
    if (pd != null) {
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text(stringResource(R.string.event_delete_confirm_title)) },
            text = { Text(stringResource(R.string.cal_delete_message, pd.summary)) },
            confirmButton = {
                TextButton(onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    pendingDelete = null
                    vm.deleteEvent(pd.id)
                }) { Text(stringResource(R.string.action_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }

    // Recurring-event delete: bottom sheet with 仅此次 / 此后 / 整个系列.
    // The user's pick IS the confirmation — no separate AlertDialog
    // needed (the choice is destructive but explicit). Mirrors iOS
    // RecurringScopePicker + the web modal.
    val pdr = pendingRecurringDelete
    if (pdr != null) {
        RecurringScopePicker(
            action = RecurringAction.Delete,
            onPick = { scope ->
                // Server's `recurrenceId` is the original occurrence's
                // ISO startsAt — that's what the row carries. For
                // scope=series we still pass it (server ignores) so
                // the call site stays one shape.
                pendingRecurringDelete = null
                vm.deleteEvent(
                    id = pdr.id,
                    scope = scope.wire,
                    recurrenceId = pdr.startsAt,
                )
            },
            onDismiss = { pendingRecurringDelete = null },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CalendarBody(
    state: CalendarUiState,
    innerPadding: PaddingValues,
    onModeChange: (ViewMode) -> Unit,
    onPrev: () -> Unit,
    onNext: () -> Unit,
    onToday: () -> Unit,
    onRetry: () -> Unit,
    onEventClick: (EventDTO) -> Unit,
    onEventLongPress: (EventDTO) -> Unit,
    onDayClick: (java.time.LocalDate) -> Unit,
    eventsForDay: (java.time.LocalDate) -> List<EventDTO>,
    /** 顶在最上面的提示（账号被服务端登出之类），没有就不占地方。 */
    topNotice: @Composable () -> Unit = {},
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(innerPadding),
    ) {
        topNotice()

        // View mode tabs
        SingleChoiceSegmentedButtonRow(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            val options = listOf(
                ViewMode.Day to stringResource(R.string.calendar_day),
                ViewMode.Week to stringResource(R.string.calendar_week),
                ViewMode.Month to stringResource(R.string.calendar_month),
            )
            options.forEachIndexed { index, (mode, label) ->
                SegmentedButton(
                    selected = state.mode == mode,
                    onClick = { onModeChange(mode) },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                ) { Text(label) }
            }
        }

        // Date navigation header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onPrev) {
                Icon(Icons.Default.ChevronLeft, contentDescription = stringResource(R.string.cal_cd_prev))
            }
            // 日期按钮吃掉中间所有剩余宽度，两个箭头永远留在原位。
            // 之前是「Spacer(weight) + 按钮 + Spacer(weight)」，德语/法语的
            // 完整星期+月份名（Donnerstag, 25. September 2026）会把「下一个」
            // 箭头顶出屏幕右边——窄屏上就再也翻不到下一天。
            TextButton(
                onClick = onToday,
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    text = formatAnchor(state.mode, state.anchor, rememberCalendarFormats()),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
            IconButton(onClick = onNext) {
                Icon(Icons.Default.ChevronRight, contentDescription = stringResource(R.string.cal_cd_next))
            }
        }

        val retryLabel = stringResource(R.string.action_retry)
        val statusText = when {
            state.loading -> stringResource(R.string.calendar_syncing)
            // Sync failed — surface it AND make the whole line a tap-to-retry
            // affordance (previously the error just sat there, dead).
            state.errorMessage != null -> "${state.errorMessage} · $retryLabel"
            else -> stringResource(R.string.calendar_synced)
        }
        Text(
            text = statusText,
            style = MaterialTheme.typography.bodySmall,
            color = if (state.errorMessage != null) MaterialTheme.colorScheme.error
                    else mutedTextColor(),
            modifier = Modifier
                .fillMaxWidth()
                .then(if (state.errorMessage != null) Modifier.clickable { onRetry() } else Modifier)
                .padding(horizontal = 16.dp, vertical = 2.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )

        Spacer(Modifier.size(4.dp))

        val deviceZone = rememberDeviceTimeZone()
        androidx.compose.runtime.key(deviceZone.id) {
        // 加载态和日/周/月以前都是硬切：转圈啪地换成内容、切个视图
        // 整屏跳变。统一走 AnimatedContent 淡入淡出；系统动画缩放
        // 关到 0（减弱动态）时直接切换，不给动画。
        val reduceMotion = rememberReduceMotion()
        val pane = when {
            state.loading && state.events.isEmpty() -> CalendarPane.Loading
            state.mode == ViewMode.Day -> CalendarPane.Day
            state.mode == ViewMode.Week -> CalendarPane.Week
            else -> CalendarPane.Month
        }
        AnimatedContent(
            targetState = pane,
            transitionSpec = {
                if (reduceMotion) {
                    EnterTransition.None togetherWith ExitTransition.None
                } else {
                    fadeIn(tween(200)) togetherWith fadeOut(tween(150))
                }
            },
            modifier = Modifier.fillMaxSize().weight(1f),
            label = "calendar-pane",
        ) { current ->
            when (current) {
                CalendarPane.Loading -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
                CalendarPane.Day -> DayView(
                    anchor = state.anchor,
                    events = eventsForDay(state.anchor),
                    calendars = state.calendars,
                    onEventClick = onEventClick,
                    onEventLongPress = onEventLongPress,
                    onCreateEvent = onCreateEvent,
                )
                CalendarPane.Week -> WeekView(
                    weekStart = startOfWeek(state.anchor),
                    events = state.events,
                    calendars = state.calendars,
                    onEventClick = onEventClick,
                    onEventLongPress = onEventLongPress,
                )
                CalendarPane.Month -> MonthView(
                    anchor = state.anchor,
                    events = state.events,
                    calendars = state.calendars,
                    onDayClick = onDayClick,
                )
            }
        }
        }
    }
}
