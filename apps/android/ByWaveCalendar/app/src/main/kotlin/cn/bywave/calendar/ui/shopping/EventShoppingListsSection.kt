// EventShoppingListsSection — the shopping-list block inside the
// event editor, placed right after the location field.
//
// This is the one place a list gets LINKED to an event (the overview
// and detail screens only show / cut an existing link — the same
// split as the desktop client): it lists the lists already linked to
// this event with their progress, links an existing list (PATCH its
// eventId), unlinks, and creates a fresh list for the event (POST
// with eventId). An event that has not been saved yet has no id to
// link against, so the section shows the "save first" note instead —
// creating or editing the event itself is untouched by anything here.

package cn.bywave.calendar.ui.shopping

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.ShoppingList
import cn.bywave.calendar.data.model.ShoppingListCreateRequest
import cn.bywave.calendar.data.model.ShoppingListEventField
import cn.bywave.calendar.data.model.ShoppingListUpdateInput
import cn.bywave.calendar.ui.calendar.mutedTextColor
import kotlinx.coroutines.launch

@Composable
fun EventShoppingListsSection(
    eventId: String?,
    onOpenList: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = stringResource(R.string.shopping_title),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        if (eventId == null) {
            Text(
                text = stringResource(R.string.shopping_event_unsaved),
                style = MaterialTheme.typography.bodySmall,
                color = mutedTextColor(),
            )
        } else {
            EventShoppingListsBody(eventId = eventId, onOpenList = onOpenList)
        }
    }
}

@Composable
private fun EventShoppingListsBody(
    eventId: String,
    onOpenList: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var linked by remember { mutableStateOf<List<ShoppingList>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var showLinkPicker by remember { mutableStateOf(false) }
    var newTitle by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var createError by remember { mutableStateOf<String?>(null) }
    val defaultTitle = stringResource(R.string.shopping_default_title)

    suspend fun reload() {
        try {
            linked = shoppingApi().shoppingLists(eventId = eventId)
            error = null
        } catch (e: Exception) {
            error = shoppingErrorText(context, e, R.string.shopping_load_failed)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(eventId) { reload() }

    if (loading) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        }
    }

    error?.let {
        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { scope.launch { loading = true; reload() } }) {
            Text(stringResource(R.string.action_retry))
        }
    }

    if (!loading && error == null) {
        if (linked.isEmpty()) {
            Text(
                text = stringResource(R.string.shopping_event_none),
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
            )
        } else {
            linked.forEach { list ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenList(list.id) }
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = list.title,
                            style = MaterialTheme.typography.bodyLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = stringResource(
                                R.string.shopping_event_progress, list.doneCount, list.totalCount,
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = mutedTextColor(),
                        )
                    }
                    TextButton(onClick = {
                        scope.launch {
                            try {
                                shoppingApi().updateShoppingList(
                                    list.id,
                                    ShoppingListUpdateInput(eventId = ShoppingListEventField(null)),
                                )
                                reload()
                            } catch (e: Exception) {
                                error = shoppingErrorText(context, e, R.string.shopping_action_failed)
                            }
                        }
                    }) {
                        Text(stringResource(R.string.shopping_unlink))
                    }
                }
            }
        }

        TextButton(onClick = { showLinkPicker = true }) {
            Text(stringResource(R.string.shopping_event_link))
        }

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
                            ShoppingListCreateRequest(
                                title = newTitle.trim().ifBlank { defaultTitle },
                                eventId = eventId,
                            ),
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
            enabled = !creating,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (creating) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(stringResource(R.string.shopping_event_create))
        }
    }

    if (showLinkPicker) {
        ShoppingListLinkPickerDialog(
            eventId = eventId,
            onDismiss = { showLinkPicker = false },
            onLinked = {
                showLinkPicker = false
                scope.launch { reload() }
            },
        )
    }
}

/** Pick one of the user's lists and link it to the event (PATCH the
 *  list's eventId). Lists already linked to THIS event are filtered
 *  out; a list linked to another event can still be picked — linking
 *  moves it, which the server's single eventId column makes the only
 *  possible reading. */
@Composable
private fun ShoppingListLinkPickerDialog(
    eventId: String,
    onDismiss: () -> Unit,
    onLinked: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var all by remember { mutableStateOf<List<ShoppingList>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var linkingId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            all = shoppingApi().shoppingLists()
        } catch (e: Exception) {
            error = shoppingErrorText(context, e, R.string.shopping_load_failed)
        }
    }

    AlertDialog(
        onDismissRequest = { if (linkingId == null) onDismiss() },
        title = { Text(stringResource(R.string.shopping_event_link)) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                val candidates = all?.filter { it.eventId != eventId }
                if (all == null && error == null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    }
                }
                if (candidates != null && candidates.isEmpty() && error == null) {
                    Text(
                        text = stringResource(R.string.shopping_event_none),
                        style = MaterialTheme.typography.bodyMedium,
                        color = mutedTextColor(),
                    )
                }
                candidates?.forEach { list ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = list.title,
                                style = MaterialTheme.typography.bodyLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = stringResource(
                                    R.string.shopping_event_progress, list.doneCount, list.totalCount,
                                ),
                                style = MaterialTheme.typography.bodySmall,
                                color = mutedTextColor(),
                            )
                        }
                        TextButton(
                            onClick = {
                                linkingId = list.id
                                scope.launch {
                                    try {
                                        shoppingApi().updateShoppingList(
                                            list.id,
                                            ShoppingListUpdateInput(
                                                eventId = ShoppingListEventField(eventId),
                                            ),
                                        )
                                        onLinked()
                                    } catch (e: Exception) {
                                        error = shoppingErrorText(
                                            context, e, R.string.shopping_action_failed,
                                        )
                                    } finally {
                                        linkingId = null
                                    }
                                }
                            },
                            enabled = linkingId == null,
                        ) {
                            Text(stringResource(R.string.shopping_event_link))
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = linkingId == null) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}
