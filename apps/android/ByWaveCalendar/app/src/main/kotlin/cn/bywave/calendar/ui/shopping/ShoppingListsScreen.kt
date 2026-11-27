// ShoppingListsScreen — the shopping-list overview and detail.
//
// Server contract (src/routes/shopping_lists.ts, device-bearer auth):
//   GET    /shopping-lists                  → [list rows with counts]
//   POST   /shopping-lists                  → 201 list row
//          (409 list_limit_reached, 400 event_not_found)
//   GET    /shopping-lists/{id}             → { list, items }
//   PATCH  /shopping-lists/{id}             → list row (rename / link /
//          unlink — eventId absent leaves the link, explicit null cuts it)
//   DELETE /shopping-lists/{id}             → { ok: true }
//   POST   /shopping-lists/{id}/items       → 201 item (409 item_limit_reached)
//   PATCH  /shopping-lists/{id}/items/{itemId} → item
//   DELETE /shopping-lists/{id}/items/{itemId} → { ok: true }
//   POST   /shopping-lists/{id}/items/{itemId}/move → item
//
// Linking a list to an event deliberately does NOT happen here beyond
// unlinking: picking an event lives in the event editor's shopping
// section (same split as the desktop client), so this screen only
// shows the current link and can cut it. After a move or a done
// toggle the detail is re-fetched whole, so item order and the
// list's counts always match the server instead of drifting through
// local arithmetic.

package cn.bywave.calendar.ui.shopping

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.ShoppingList
import cn.bywave.calendar.data.model.ShoppingListCreateRequest
import cn.bywave.calendar.data.model.ShoppingListDetail
import cn.bywave.calendar.data.model.ShoppingListEventField
import cn.bywave.calendar.data.model.ShoppingListItem
import cn.bywave.calendar.data.model.ShoppingListItemCreateRequest
import cn.bywave.calendar.data.model.ShoppingListItemMoveRequest
import cn.bywave.calendar.data.model.ShoppingListItemUpdateInput
import cn.bywave.calendar.data.model.ShoppingQuantityField
import cn.bywave.calendar.data.model.ShoppingListUpdateInput
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.components.rememberReduceMotion
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShoppingListsScreen(
    onBack: () -> Unit,
    onOpenList: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var lists by remember { mutableStateOf<List<ShoppingList>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var newTitle by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var createError by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        try {
            lists = shoppingApi().shoppingLists()
            error = null
        } catch (e: Exception) {
            error = shoppingErrorText(context, e, R.string.shopping_load_failed)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { reload() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.shopping_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.nav_back))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Spacer(Modifier.size(4.dp))
            Text(
                text = stringResource(R.string.shopping_your_lists),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )

            if (loading) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            }

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { scope.launch { loading = true; reload() } }) {
                    Text(stringResource(R.string.action_retry))
                }
            }

            if (!loading && error == null) {
                if (lists.isEmpty()) {
                    Text(
                        text = stringResource(R.string.shopping_empty_lists),
                        style = MaterialTheme.typography.bodyMedium,
                        color = mutedTextColor(),
                    )
                } else {
                    lists.forEach { list ->
                        ShoppingListRow(list = list, onClick = { onOpenList(list.id) })
                    }
                }
            }

            // Create — title only. Linking to an event happens in the
            // event editor (or not at all); a list made here starts
            // unlinked, like the Web page's "no linked event" default.
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = stringResource(R.string.shopping_new_list),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                OutlinedTextField(
                    value = newTitle,
                    onValueChange = { newTitle = it },
                    label = { Text(stringResource(R.string.shopping_title_label)) },
                    placeholder = { Text(stringResource(R.string.shopping_title_placeholder)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                createError?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                Button(
                    onClick = {
                        creating = true
                        createError = null
                        scope.launch {
                            try {
                                shoppingApi().createShoppingList(
                                    ShoppingListCreateRequest(title = newTitle.trim()),
                                )
                                newTitle = ""
                                reload()
                            } catch (e: Exception) {
                                createError = shoppingErrorText(context, e, R.string.shopping_action_failed)
                            } finally {
                                creating = false
                            }
                        }
                    },
                    enabled = !creating && newTitle.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (creating) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(8.dp))
                    }
                    Text(stringResource(R.string.shopping_create_list))
                }
            }

            Spacer(Modifier.size(24.dp))
        }
    }
}

/** One overview row: title, progress, the all-bought badge, and the
 *  linked event's name when there is one. */
@Composable
private fun ShoppingListRow(
    list: ShoppingList,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onClick)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = list.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (list.totalCount > 0 && list.doneCount == list.totalCount) {
                Spacer(Modifier.size(8.dp))
                Text(
                    text = stringResource(R.string.shopping_all_done),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        Text(
            text = stringResource(R.string.shopping_progress, list.doneCount, list.totalCount),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        if (!list.eventSummary.isNullOrBlank()) {
            Text(
                text = list.eventSummary,
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShoppingListDetailScreen(
    listId: String,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val reduceMotion = rememberReduceMotion()
    var detail by remember { mutableStateOf<ShoppingListDetail?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var editingItem by remember { mutableStateOf<ShoppingListItem?>(null) }
    var deletingItem by remember { mutableStateOf<ShoppingListItem?>(null) }
    var showDeleteList by remember { mutableStateOf(false) }
    // Add-item form.
    var itemName by remember { mutableStateOf("") }
    var itemQuantity by remember { mutableStateOf("") }
    var itemUnit by remember { mutableStateOf("") }
    var itemNote by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }
    var addError by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        try {
            detail = shoppingApi().shoppingList(listId)
            error = null
        } catch (e: Exception) {
            error = shoppingErrorText(context, e, R.string.shopping_load_failed)
        } finally {
            loading = false
        }
    }

    /** Run one mutating call, then re-fetch the whole detail so item
     *  order and counts match the server (the move / toggle rule). */
    fun mutate(block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
                actionError = null
                reload()
            } catch (e: Exception) {
                actionError = shoppingErrorText(context, e, R.string.shopping_action_failed)
            }
        }
    }

    LaunchedEffect(listId) { reload() }

    val list = detail?.list
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(list?.title ?: stringResource(R.string.shopping_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.nav_back))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Spacer(Modifier.size(4.dp))

            if (loading) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            }

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { scope.launch { loading = true; reload() } }) {
                    Text(stringResource(R.string.action_retry))
                }
            }

            actionError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            val d = detail
            if (!loading && d != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.shopping_progress, d.list.doneCount, d.list.totalCount),
                        style = MaterialTheme.typography.bodyMedium,
                        color = mutedTextColor(),
                    )
                    if (d.list.totalCount > 0 && d.list.doneCount == d.list.totalCount) {
                        Spacer(Modifier.size(8.dp))
                        Text(
                            text = stringResource(R.string.shopping_all_done),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }

                // 进度条和上面的「x/y」是同一个数：数字给确切值，
                // 条给一眼进度。勾选后平滑涨过去，不要跳变；减弱
                // 动态时直接落到新值。动画状态提在条件外面声明，
                // 别让条的出现/消失带着状态一起重建。
                val progressFraction = if (d.list.totalCount > 0) {
                    d.list.doneCount.toFloat() / d.list.totalCount.toFloat()
                } else {
                    0f
                }
                val animatedFraction by animateFloatAsState(
                    targetValue = progressFraction,
                    animationSpec = if (reduceMotion) snap() else tween(300),
                    label = "shopping-progress",
                )
                if (d.list.totalCount > 0) {
                    LinearProgressIndicator(
                        progress = { animatedFraction },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                if (d.items.isEmpty()) {
                    Text(
                        text = stringResource(R.string.shopping_items_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = mutedTextColor(),
                    )
                } else {
                    d.items.forEachIndexed { index, item ->
                        ShoppingItemRow(
                            item = item,
                            isFirst = index == 0,
                            isLast = index == d.items.lastIndex,
                            onToggle = {
                                mutate {
                                    shoppingApi().updateShoppingListItem(
                                        listId, item.id,
                                        ShoppingListItemUpdateInput(done = !item.done),
                                    )
                                }
                            },
                            onMoveUp = {
                                mutate {
                                    shoppingApi().moveShoppingListItem(
                                        listId, item.id,
                                        ShoppingListItemMoveRequest(direction = "up"),
                                    )
                                }
                            },
                            onMoveDown = {
                                mutate {
                                    shoppingApi().moveShoppingListItem(
                                        listId, item.id,
                                        ShoppingListItemMoveRequest(direction = "down"),
                                    )
                                }
                            },
                            onEdit = { editingItem = item },
                            onDelete = { deletingItem = item },
                        )
                    }
                }

                // Add-item form.
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    OutlinedTextField(
                        value = itemName,
                        onValueChange = { itemName = it },
                        label = { Text(stringResource(R.string.shopping_item_name)) },
                        placeholder = { Text(stringResource(R.string.shopping_item_name_placeholder)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedTextField(
                            value = itemQuantity,
                            onValueChange = { itemQuantity = it },
                            label = { Text(stringResource(R.string.shopping_quantity)) },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedTextField(
                            value = itemUnit,
                            onValueChange = { itemUnit = it },
                            label = { Text(stringResource(R.string.shopping_unit)) },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    OutlinedTextField(
                        value = itemNote,
                        onValueChange = { itemNote = it },
                        label = { Text(stringResource(R.string.shopping_note)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    addError?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    Button(
                        onClick = {
                            adding = true
                            addError = null
                            scope.launch {
                                try {
                                    shoppingApi().addShoppingListItem(
                                        listId,
                                        ShoppingListItemCreateRequest(
                                            name = itemName.trim(),
                                            quantity = parseShoppingQuantity(itemQuantity),
                                            unit = itemUnit.trim().ifBlank { null },
                                            note = itemNote.trim().ifBlank { null },
                                        ),
                                    )
                                    itemName = ""
                                    itemQuantity = ""
                                    itemUnit = ""
                                    itemNote = ""
                                    reload()
                                } catch (e: Exception) {
                                    addError = shoppingErrorText(context, e, R.string.shopping_action_failed)
                                } finally {
                                    adding = false
                                }
                            }
                        },
                        enabled = !adding && itemName.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (adding) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.size(8.dp))
                        }
                        Text(stringResource(R.string.shopping_add_item))
                    }
                }

                ShoppingListSettings(
                    list = d.list,
                    onRename = { newTitle ->
                        mutate {
                            shoppingApi().updateShoppingList(
                                listId,
                                ShoppingListUpdateInput(title = newTitle),
                            )
                        }
                    },
                    onUnlink = {
                        mutate {
                            shoppingApi().updateShoppingList(
                                listId,
                                ShoppingListUpdateInput(eventId = ShoppingListEventField(null)),
                            )
                        }
                    },
                    onDeleteList = { showDeleteList = true },
                )
            }

            Spacer(Modifier.size(24.dp))
        }
    }

    editingItem?.let { item ->
        ShoppingItemEditDialog(
            item = item,
            onDismiss = { editingItem = null },
            onSave = { name, quantityText, unit, note ->
                editingItem = null
                mutate {
                    shoppingApi().updateShoppingListItem(
                        listId, item.id,
                        ShoppingListItemUpdateInput(
                            name = name,
                            quantity = when {
                                quantityText.isBlank() -> ShoppingQuantityField(null)
                                else -> parseShoppingQuantity(quantityText)
                                    ?.let { ShoppingQuantityField(it) }
                            },
                            unit = unit,
                            note = note,
                        ),
                    )
                }
            },
        )
    }

    deletingItem?.let { item ->
        var working by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!working) deletingItem = null },
            title = { Text(item.name) },
            text = { Text(stringResource(R.string.shopping_delete_item_confirm)) },
            confirmButton = {
                Button(
                    onClick = {
                        working = true
                        scope.launch {
                            try {
                                shoppingApi().deleteShoppingListItem(listId, item.id)
                                deletingItem = null
                                reload()
                            } catch (e: Exception) {
                                actionError = shoppingErrorText(context, e, R.string.shopping_action_failed)
                                deletingItem = null
                            } finally {
                                working = false
                            }
                        }
                    },
                    enabled = !working,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) {
                    Text(stringResource(R.string.action_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { deletingItem = null }, enabled = !working) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    if (showDeleteList && list != null) {
        var working by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!working) showDeleteList = false },
            title = { Text(list.title) },
            text = { Text(stringResource(R.string.shopping_delete_list_confirm)) },
            confirmButton = {
                Button(
                    onClick = {
                        working = true
                        scope.launch {
                            try {
                                shoppingApi().deleteShoppingList(listId)
                                showDeleteList = false
                                onBack()
                            } catch (e: Exception) {
                                actionError = shoppingErrorText(context, e, R.string.shopping_action_failed)
                                showDeleteList = false
                            } finally {
                                working = false
                            }
                        }
                    },
                    enabled = !working,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) {
                    Text(stringResource(R.string.action_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteList = false }, enabled = !working) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

/** One item row: done checkbox, name (+ quantity / unit / note), and
 *  the move / edit / delete actions. Boundary move buttons disable
 *  instead of silently no-opping against the server's ordering. */
@Composable
private fun ShoppingItemRow(
    item: ShoppingListItem,
    isFirst: Boolean,
    isLast: Boolean,
    onToggle: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 4.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The checkbox itself is the toggle; the description is
        // what screen readers announce for it.
        val toggleDescription = stringResource(R.string.shopping_toggle_done)
        val haptic = LocalHapticFeedback.current
        Checkbox(
            checked = item.done,
            onCheckedChange = {
                // 只在「勾上」时震一下（口径同 CalendarScreen 的
                // LongPress 轻触觉），取消勾选不震，别滥用。
                if (!item.done) haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onToggle()
            },
            modifier = Modifier.semantics { contentDescription = toggleDescription },
        )
        Column(modifier = Modifier.weight(1f)) {
            // 勾选后名字变灰是瞬时翻转，删除线也是；颜色这一维能
            // 平滑就平滑，让整行状态变化看起来是一口气完成的。
            val nameColor by animateColorAsState(
                targetValue = if (item.done) mutedTextColor() else MaterialTheme.colorScheme.onSurface,
                animationSpec = tween(200),
                label = "shopping-item-name",
            )
            Text(
                text = item.name,
                style = MaterialTheme.typography.bodyLarge,
                textDecoration = if (item.done) TextDecoration.LineThrough else null,
                color = nameColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            val quantityText = item.quantity?.let { formatShoppingQuantity(it) }
            val amount = listOfNotNull(quantityText, item.unit?.takeIf { it.isNotBlank() })
                .joinToString(" ")
            if (amount.isNotEmpty()) {
                Text(
                    text = amount,
                    style = MaterialTheme.typography.bodySmall,
                    color = mutedTextColor(),
                )
            }
            if (!item.note.isNullOrBlank()) {
                Text(
                    text = item.note,
                    style = MaterialTheme.typography.bodySmall,
                    color = mutedTextColor(),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        IconButton(onClick = onMoveUp, enabled = !isFirst) {
            Icon(Icons.Default.KeyboardArrowUp, contentDescription = stringResource(R.string.shopping_move_up))
        }
        IconButton(onClick = onMoveDown, enabled = !isLast) {
            Icon(Icons.Default.KeyboardArrowDown, contentDescription = stringResource(R.string.shopping_move_down))
        }
        TextButton(onClick = onEdit) {
            Text(stringResource(R.string.shopping_edit_item))
        }
        IconButton(onClick = onDelete) {
            Icon(
                Icons.Default.Delete,
                contentDescription = stringResource(R.string.action_delete),
                tint = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/** The detail's settings block: rename, the current event link (with
 *  unlink), and the destructive delete entry. */
@Composable
private fun ShoppingListSettings(
    list: ShoppingList,
    onRename: (String) -> Unit,
    onUnlink: () -> Unit,
    onDeleteList: () -> Unit,
) {
    var title by remember(list.id, list.title) { mutableStateOf(list.title) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = stringResource(R.string.shopping_list_settings),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            label = { Text(stringResource(R.string.shopping_title_label)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = { onRename(title.trim()) },
            enabled = title.isNotBlank() && title.trim() != list.title,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.shopping_rename))
        }
        Text(
            text = stringResource(R.string.shopping_link_event_label),
            style = MaterialTheme.typography.bodySmall,
            color = mutedTextColor(),
        )
        if (list.eventId != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = list.eventSummary ?: list.eventId,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onUnlink) {
                    Text(stringResource(R.string.shopping_unlink))
                }
            }
        } else {
            Text(
                text = stringResource(R.string.shopping_no_event),
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
            )
        }
        TextButton(onClick = onDeleteList) {
            Text(
                stringResource(R.string.shopping_delete_list),
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/** Edit one item: the full field set the row displays. A cleared
 *  unit / note goes out as "" and the server stores null. Quantity
 *  travels as raw text so the caller can tell "cleared" (blank →
 *  explicit null on the wire, the server clears it) apart from
 *  "typed something unparseable" (field omitted, old value kept). */
@Composable
private fun ShoppingItemEditDialog(
    item: ShoppingListItem,
    onDismiss: () -> Unit,
    onSave: (name: String, quantityText: String, unit: String?, note: String?) -> Unit,
) {
    var name by remember(item.id) { mutableStateOf(item.name) }
    var quantity by remember(item.id) {
        mutableStateOf(item.quantity?.let { formatShoppingQuantity(it) } ?: "")
    }
    var unit by remember(item.id) { mutableStateOf(item.unit ?: "") }
    var note by remember(item.id) { mutableStateOf(item.note ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.shopping_edit_item)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.shopping_item_name)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = quantity,
                        onValueChange = { quantity = it },
                        label = { Text(stringResource(R.string.shopping_quantity)) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = unit,
                        onValueChange = { unit = it },
                        label = { Text(stringResource(R.string.shopping_unit)) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(stringResource(R.string.shopping_note)) },
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
                        unit.trim(),
                        note.trim(),
                    )
                },
                enabled = name.isNotBlank(),
            ) {
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}
