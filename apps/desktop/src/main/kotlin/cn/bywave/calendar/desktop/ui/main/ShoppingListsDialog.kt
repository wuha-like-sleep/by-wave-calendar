package cn.bywave.calendar.desktop.ui.main

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.api.ApiException
import cn.bywave.calendar.desktop.data.model.ShoppingList
import cn.bywave.calendar.desktop.data.model.ShoppingListCreateInput
import cn.bywave.calendar.desktop.data.model.ShoppingListDetail
import cn.bywave.calendar.desktop.data.model.ShoppingListItem
import cn.bywave.calendar.desktop.data.model.ShoppingListItemCreateInput
import cn.bywave.calendar.desktop.i18n.I18n
import cn.bywave.calendar.desktop.util.userFacingError
import kotlinx.coroutines.launch

/** 把购买清单接口的失败翻成本地化文案。ApiClient 的购物方法照
 *  Token 那套把机器码放在 ApiException.message 里，这里认得的码
 *  给专门文案，其余走通用兜底（机器码不会原样摆给用户）。 */
internal fun shoppingErrorText(e: Throwable, fallbackKey: String): String {
    val code = (e as? ApiException)?.message
    return when (code) {
        "list_limit_reached" -> I18n.t("shopping.errorListLimit")
        "item_limit_reached" -> I18n.t("shopping.errorItemLimit")
        "event_not_found" -> I18n.t("shopping.errorEventNotFound")
        else -> userFacingError(e, fallbackKey)
    }
}

/** 数量显示去掉无意义的尾零：2.0 → "2"，0.5 → "0.5"，2.25 → "2.25"。 */
internal fun formatShoppingQuantity(quantity: Double): String {
    return if (quantity == quantity.toLong().toDouble()) {
        quantity.toLong().toString()
    } else {
        java.math.BigDecimal.valueOf(quantity).stripTrailingZeros().toPlainString()
    }
}

/** 数量输入框解析：空 = 没填（null）；逗号小数点也认。解析不了返回
 *  null 之外还要让调用方知道是「填错了」而不是「没填」，所以非法
 *  输入回 NaN 哨兵，由调用方拦下。 */
internal fun parseShoppingQuantity(text: String): Double? {
    val trimmed = text.trim().replace(',', '.')
    if (trimmed.isEmpty()) return null
    return trimmed.toDoubleOrNull() ?: Double.NaN
}

/**
 * 购买清单 — 一个对话框两态：清单列表与某张清单的详情。
 *
 * 列表态：全部清单（标题、进度、全买齐徽标、关联事件名）+ 新建行。
 * 详情态：条目（勾选 / 数量单位 / 备注 / 上移下移 / 编辑 / 删除）、
 * 加条目表单，以及清单设置（改名、解除关联、删清单带确认）。
 *
 * 关联事件只在这里「解除」：把清单关联到某个事件的动作统一走事件
 * 编辑区的购买清单区（或新建时），这里不做任意事件选择器——拉全部
 * 事件做选择器代价大，也和另外两端的客户端从简口径一致。
 *
 * 所有改动都先走服务端、成功后重拉（详情或列表），不做乐观更新：
 * move / toggle 之后直接重拉详情，顺序与计数以服务端为准。
 *
 * @param initialListId 非空时直接打开该清单的详情（事件编辑区跳入）。
 */
@Composable
fun ShoppingListsDialog(
    client: ApiClient,
    initialListId: String? = null,
    onDismiss: () -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> I18n.t(key) } }
    val tv = remember(locale) { { key: String, vars: Map<String, Any> -> I18n.t(key, vars) } }
    val scope = rememberCoroutineScope()

    var lists by remember { mutableStateOf<List<ShoppingList>?>(null) }
    var listLoading by remember { mutableStateOf(true) }
    var listError by remember { mutableStateOf<String?>(null) }
    var selectedId by remember { mutableStateOf(initialListId) }
    var detail by remember { mutableStateOf<ShoppingListDetail?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    var newTitle by remember { mutableStateOf("") }
    var confirmDeleteList by remember { mutableStateOf(false) }
    var confirmDeleteItem by remember { mutableStateOf<ShoppingListItem?>(null) }
    var editingItem by remember { mutableStateOf<ShoppingListItem?>(null) }

    suspend fun loadLists() {
        listLoading = true
        try {
            lists = client.listShoppingLists()
            listError = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            listError = shoppingErrorText(e, "error.loadFailed")
        } finally {
            listLoading = false
        }
    }

    suspend fun loadDetail(id: String) {
        // 加载中没有单独的状态位：detail 还是 null 时，弹窗那边的
        // pane 推导自然落到加载态（见下方 AnimatedContent 处）。
        try {
            detail = client.getShoppingList(id)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            actionError = shoppingErrorText(e, "error.loadFailed")
            selectedId = null
            detail = null
        }
    }

    LaunchedEffect(client) { loadLists() }
    LaunchedEffect(selectedId) {
        val id = selectedId
        if (id != null) loadDetail(id) else detail = null
    }

    /** 一次改动：防重复点，失败把本地化文案留在当前态里，成功后
     *  由 block 尾部的重拉对齐服务端状态。 */
    fun mutate(fallbackKey: String, block: suspend () -> Unit) {
        if (busy) return
        busy = true
        actionError = null
        scope.launch {
            try {
                block()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                actionError = shoppingErrorText(e, fallbackKey)
            } finally {
                busy = false
            }
        }
    }

    val currentDetail = detail?.takeIf { it.list.id == selectedId }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(t("shopping.title")) },
        text = {
            Column(
                modifier = Modifier.width(560.dp).heightIn(max = 600.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (actionError != null) {
                    Text(
                        actionError!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                // 列表态 ↔ 详情态以前是整块硬换，点进一张清单像跳页，
                // 返回也是。改走 AnimatedContent 淡入淡出，两态之间
                // 有个交代；选了清单但详情还没回来是中间的加载态。
                val pane = when {
                    selectedId == null -> 0
                    currentDetail != null -> 2
                    else -> 1
                }
                AnimatedContent(
                    targetState = pane,
                    transitionSpec = { fadeIn(tween(180)) togetherWith fadeOut(tween(120)) },
                    label = "shopping-pane",
                ) { current ->
                    when (current) {
                        0 -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    // ---- 清单列表态 ----
                    Text(
                        t("shopping.yourLists"),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    when {
                        listLoading && lists == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        }
                        listError != null -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(listError!!, color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { scope.launch { loadLists() } }) { Text(t("error.retry")) }
                        }
                        lists.isNullOrEmpty() -> Text(
                            t("shopping.emptyLists"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        else -> lists!!.forEach { list ->
                            ShoppingListRow(
                                list = list,
                                progressText = tv(
                                    "shopping.progress",
                                    mapOf("done" to list.doneCount, "total" to list.totalCount),
                                ),
                                allDoneText = t("shopping.allDone"),
                                onClick = { selectedId = list.id },
                            )
                            if (list != lists!!.last()) HorizontalDivider()
                        }
                    }

                    HorizontalDivider()
                    Text(
                        t("shopping.newList"),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedTextField(
                            value = newTitle,
                            onValueChange = { newTitle = it },
                            label = { Text(t("shopping.titleLabel")) },
                            placeholder = { Text(t("shopping.titlePlaceholder")) },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        Button(
                            onClick = {
                                val title = newTitle.trim().ifBlank { t("shopping.defaultTitle") }
                                mutate("error.saveFailed") {
                                    val created = client.createShoppingList(
                                        ShoppingListCreateInput(title = title),
                                    )
                                    newTitle = ""
                                    loadLists()
                                    selectedId = created.id
                                }
                            },
                            enabled = !busy,
                        ) { Text(t("shopping.createList")) }
                    }
                        }
                        1 -> Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        }
                        else -> if (currentDetail != null) {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    // ---- 清单详情态 ----
                    ShoppingListDetailContent(
                        detail = currentDetail,
                        busy = busy,
                        onToggle = { item ->
                            mutate("error.saveFailed") {
                                client.updateShoppingListItem(
                                    currentDetail.list.id, item.id, done = !item.done,
                                )
                                loadDetail(currentDetail.list.id)
                            }
                        },
                        onMove = { item, direction ->
                            mutate("error.saveFailed") {
                                client.moveShoppingListItem(currentDetail.list.id, item.id, direction)
                                loadDetail(currentDetail.list.id)
                            }
                        },
                        onEdit = { editingItem = it },
                        onDeleteItem = { confirmDeleteItem = it },
                        onAddItem = { name, quantity, unit, note ->
                            mutate("error.saveFailed") {
                                client.addShoppingListItem(
                                    currentDetail.list.id,
                                    ShoppingListItemCreateInput(
                                        name = name,
                                        quantity = quantity,
                                        unit = unit,
                                        note = note,
                                    ),
                                )
                                loadDetail(currentDetail.list.id)
                            }
                        },
                        onRename = { title ->
                            mutate("error.saveFailed") {
                                client.updateShoppingList(currentDetail.list.id, title = title)
                                loadDetail(currentDetail.list.id)
                                loadLists()
                            }
                        },
                        onUnlink = {
                            mutate("error.saveFailed") {
                                client.updateShoppingList(currentDetail.list.id, clearEvent = true)
                                loadDetail(currentDetail.list.id)
                                loadLists()
                            }
                        },
                        onDeleteList = { confirmDeleteList = true },
                    )
                            }
                        } else {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(
                onClick = { if (selectedId != null) selectedId = null else onDismiss() },
            ) {
                Text(t(if (selectedId != null) "common.back" else "common.close"))
            }
        },
    )

    // 删清单确认：连条目一并删除，先把话说清。
    if (confirmDeleteList && currentDetail != null) {
        AlertDialog(
            onDismissRequest = { confirmDeleteList = false },
            title = { Text(t("shopping.deleteList")) },
            text = { Text(t("shopping.deleteListConfirm")) },
            confirmButton = {
                Button(
                    onClick = {
                        val id = currentDetail.list.id
                        confirmDeleteList = false
                        mutate("error.deleteFailed") {
                            client.deleteShoppingList(id)
                            selectedId = null
                            detail = null
                            loadLists()
                        }
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) { Text(t("settings.calendars.delete")) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDeleteList = false }) { Text(t("common.cancel")) }
            },
        )
    }

    // 删条目确认。
    confirmDeleteItem?.let { item ->
        AlertDialog(
            onDismissRequest = { confirmDeleteItem = null },
            title = { Text(item.name) },
            text = { Text(t("shopping.deleteItemConfirm")) },
            confirmButton = {
                Button(
                    onClick = {
                        confirmDeleteItem = null
                        val listId = selectedId ?: return@Button
                        mutate("error.deleteFailed") {
                            client.deleteShoppingListItem(listId, item.id)
                            loadDetail(listId)
                        }
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) { Text(t("settings.calendars.delete")) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDeleteItem = null }) { Text(t("common.cancel")) }
            },
        )
    }

    // 编辑条目：名称 / 数量 / 单位 / 备注一并改，保存后重拉详情。
    editingItem?.let { item ->
        ShoppingItemEditDialog(
            item = item,
            busy = busy,
            onDismiss = { editingItem = null },
            onSave = { name, quantityText, unit, note ->
                val listId = selectedId ?: return@ShoppingItemEditDialog
                val quantity = parseShoppingQuantity(quantityText)
                if (quantity != null && quantity.isNaN()) return@ShoppingItemEditDialog
                editingItem = null
                mutate("error.saveFailed") {
                    client.updateShoppingListItem(
                        listId, item.id,
                        name = name,
                        quantity = quantity,
                        clearQuantity = quantityText.isBlank(),
                        unit = unit,
                        note = note,
                    )
                    loadDetail(listId)
                }
            },
        )
    }
}

/** 列表态的一行：标题 + 进度（全买齐时换徽标）+ 关联事件名。 */
@Composable
private fun ShoppingListRow(
    list: ShoppingList,
    progressText: String,
    allDoneText: String,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                list.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (list.totalCount > 0 && list.doneCount == list.totalCount) {
                Text(
                    allDoneText,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                )
            } else {
                Text(
                    progressText,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        list.eventSummary?.takeIf { it.isNotBlank() }?.let { summary ->
            Text(
                summary,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** 详情态内容：条目列表 + 加条目表单 + 清单设置。 */
@Composable
private fun ShoppingListDetailContent(
    detail: ShoppingListDetail,
    busy: Boolean,
    onToggle: (ShoppingListItem) -> Unit,
    onMove: (ShoppingListItem, String) -> Unit,
    onEdit: (ShoppingListItem) -> Unit,
    onDeleteItem: (ShoppingListItem) -> Unit,
    onAddItem: (name: String, quantity: Double?, unit: String?, note: String?) -> Unit,
    onRename: (String) -> Unit,
    onUnlink: () -> Unit,
    onDeleteList: () -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> I18n.t(key) } }
    val tv = remember(locale) { { key: String, vars: Map<String, Any> -> I18n.t(key, vars) } }
    val list = detail.list

    Text(
        list.title,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
    )
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            tv("shopping.progress", mapOf("done" to list.doneCount, "total" to list.totalCount)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (list.totalCount > 0 && list.doneCount == list.totalCount) {
            Text(
                t("shopping.allDone"),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }

    // 进度条和上面的数字是同一个数：数字给确切值，条给一眼进度。
    // 勾选后平滑涨过去，不要跳变。动画状态提在条件外面声明，
    // 别让条的出现/消失带着状态一起重建。
    val progressFraction = if (list.totalCount > 0) {
        list.doneCount.toFloat() / list.totalCount.toFloat()
    } else {
        0f
    }
    val animatedProgress by animateFloatAsState(
        targetValue = progressFraction,
        animationSpec = tween(300),
        label = "shopping-progress",
    )
    if (list.totalCount > 0) {
        LinearProgressIndicator(
            progress = animatedProgress,
            modifier = Modifier.fillMaxWidth(),
        )
    }

    if (detail.items.isEmpty()) {
        Text(t("shopping.itemsEmpty"), color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
        detail.items.forEach { item ->
            ShoppingItemRow(
                item = item,
                busy = busy,
                onToggle = { onToggle(item) },
                onMoveUp = { onMove(item, "up") },
                onMoveDown = { onMove(item, "down") },
                onEdit = { onEdit(item) },
                onDelete = { onDeleteItem(item) },
            )
            if (item != detail.items.last()) HorizontalDivider()
        }
    }

    HorizontalDivider()

    // 加条目表单：名称必填，数量 / 单位 / 备注选填。
    var newName by remember(list.id) { mutableStateOf("") }
    var newQuantity by remember(list.id) { mutableStateOf("") }
    var newUnit by remember(list.id) { mutableStateOf("") }
    var newNote by remember(list.id) { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = newName,
            onValueChange = { newName = it },
            label = { Text(t("shopping.itemName")) },
            placeholder = { Text(t("shopping.itemNamePlaceholder")) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = newQuantity,
                onValueChange = { newQuantity = it },
                label = { Text(t("shopping.quantity")) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = newUnit,
                onValueChange = { newUnit = it },
                label = { Text(t("shopping.unit")) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = newNote,
                onValueChange = { newNote = it },
                label = { Text(t("shopping.note")) },
                singleLine = true,
                modifier = Modifier.weight(2f),
            )
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Button(
                onClick = {
                    val quantity = parseShoppingQuantity(newQuantity)
                    if (quantity != null && quantity.isNaN()) return@Button
                    onAddItem(
                        newName.trim(),
                        quantity,
                        newUnit.trim().ifBlank { null },
                        newNote.trim().ifBlank { null },
                    )
                    newName = ""
                    newQuantity = ""
                    newUnit = ""
                    newNote = ""
                },
                enabled = !busy && newName.isNotBlank(),
            ) { Text(t("shopping.addItem")) }
        }
    }

    HorizontalDivider()

    // 清单设置：改名、关联事件（只展示 + 解除）、删除。
    Text(
        t("shopping.listSettings"),
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
    )
    var renameTitle by remember(list.id, list.title) { mutableStateOf(list.title) }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = renameTitle,
            onValueChange = { renameTitle = it },
            label = { Text(t("shopping.titleLabel")) },
            singleLine = true,
            modifier = Modifier.weight(1f),
        )
        OutlinedButton(
            onClick = { onRename(renameTitle.trim()) },
            enabled = !busy && renameTitle.isNotBlank() && renameTitle.trim() != list.title,
        ) { Text(t("shopping.rename")) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            t("shopping.linkEventLabel"),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (list.eventId == null) {
            Text(t("shopping.noEvent"), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    list.eventSummary ?: t("shopping.noEvent"),
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                TextButton(onClick = onUnlink, enabled = !busy) { Text(t("shopping.unlink")) }
            }
        }
    }
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = onDeleteList, enabled = !busy) {
            Text(t("shopping.deleteList"), color = MaterialTheme.colorScheme.error)
        }
    }
}

/** 详情态的一条条目：勾选框、名称（买好后划线）、数量+单位、备注，
 *  以及上移 / 下移 / 编辑 / 删除。 */
@Composable
private fun ShoppingItemRow(
    item: ShoppingListItem,
    busy: Boolean,
    onToggle: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> I18n.t(key) } }
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(
            checked = item.done,
            onCheckedChange = { onToggle() },
            enabled = !busy,
            modifier = Modifier.size(36.dp).semantics { contentDescription = t("shopping.toggleDone") },
        )
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    item.name,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    textDecoration = if (item.done) TextDecoration.LineThrough else null,
                    color = if (item.done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val quantityText = item.quantity?.let { q ->
                    formatShoppingQuantity(q) + (item.unit?.takeIf { it.isNotBlank() }?.let { " $it" } ?: "")
                } ?: item.unit?.takeIf { it.isNotBlank() }
                if (quantityText != null) {
                    Text(
                        quantityText,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            item.note?.takeIf { it.isNotBlank() }?.let { note ->
                Text(
                    note,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        IconButton(onClick = onMoveUp, enabled = !busy, modifier = Modifier.size(32.dp)) {
            Icon(Icons.Default.KeyboardArrowUp, contentDescription = t("shopping.moveUp"), modifier = Modifier.size(18.dp))
        }
        IconButton(onClick = onMoveDown, enabled = !busy, modifier = Modifier.size(32.dp)) {
            Icon(Icons.Default.KeyboardArrowDown, contentDescription = t("shopping.moveDown"), modifier = Modifier.size(18.dp))
        }
        IconButton(onClick = onEdit, enabled = !busy, modifier = Modifier.size(32.dp)) {
            Icon(Icons.Default.Edit, contentDescription = t("shopping.editItem"), modifier = Modifier.size(18.dp))
        }
        IconButton(onClick = onDelete, enabled = !busy, modifier = Modifier.size(32.dp)) {
            Icon(
                Icons.Default.Delete,
                contentDescription = t("settings.calendars.delete"),
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/** 条目编辑小对话框：四个字段一次改完。 */
@Composable
private fun ShoppingItemEditDialog(
    item: ShoppingListItem,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (name: String, quantityText: String, unit: String?, note: String?) -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> I18n.t(key) } }
    var name by remember(item.id) { mutableStateOf(item.name) }
    var quantity by remember(item.id) {
        mutableStateOf(item.quantity?.let { formatShoppingQuantity(it) } ?: "")
    }
    var unit by remember(item.id) { mutableStateOf(item.unit ?: "") }
    var note by remember(item.id) { mutableStateOf(item.note ?: "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(t("shopping.editItem")) },
        text = {
            Column(
                modifier = Modifier.width(420.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(t("shopping.itemName")) },
                    placeholder = { Text(t("shopping.itemNamePlaceholder")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = quantity,
                        onValueChange = { quantity = it },
                        label = { Text(t("shopping.quantity")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = unit,
                        onValueChange = { unit = it },
                        label = { Text(t("shopping.unit")) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(t("shopping.note")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    onSave(
                        name.trim(),
                        quantity,
                        unit.trim().ifBlank { "" },
                        note.trim().ifBlank { "" },
                    )
                },
                enabled = !busy && name.isNotBlank(),
            ) { Text(t("settings.calendars.save")) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text(t("common.cancel")) }
        },
    )
}
