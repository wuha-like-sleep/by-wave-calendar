// ImportIcsScreen — confirmation UI for a .ics file handed over by
// another app ("Open with ByWave" / share sheet). Pick the target
// calendar, preview the counts, confirm, see the result — the same
// two-step shape as the web import dialog.

package cn.bywave.calendar.ui.importics

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.bywave.calendar.R
import cn.bywave.calendar.ui.calendar.mutedTextColor
import cn.bywave.calendar.ui.calendar.parseHex
import cn.bywave.calendar.ui.components.EmptyState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportIcsScreen(
    uri: Uri?,
    onClose: () -> Unit,
    onImported: () -> Unit,
) {
    val vm: ImportIcsViewModel = viewModel()
    val state by vm.state.collectAsState()
    val context = LocalContext.current

    LaunchedEffect(uri) {
        if (uri == null) {
            // Nothing was handed over (e.g. the process was recreated
            // without the intent) — there is nothing to confirm here.
            onClose()
            return@LaunchedEffect
        }
        vm.load(context, uri)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.importics_title)) },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.nav_back),
                        )
                    }
                },
            )
        },
    ) { pad ->
        Box(modifier = Modifier.fillMaxSize().padding(pad)) {
            when (state.phase) {
                ImportPhase.Reading -> {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                }

                ImportPhase.Failed -> {
                    EmptyState(
                        title = stringResource(
                            when (state.error) {
                                ImportErrorKind.TooLarge -> R.string.importics_error_too_large
                                ImportErrorKind.NotIcs -> R.string.importics_error_not_ics
                                ImportErrorKind.Read -> R.string.importics_error_read
                                else -> R.string.importics_error_generic
                            },
                        ),
                        subtitle = state.errorDetail,
                        action = {
                            Button(onClick = onClose) {
                                Text(stringResource(R.string.importics_done))
                            }
                        },
                    )
                }

                ImportPhase.Done -> {
                    val r = state.result
                    EmptyState(
                        title = if (r != null) {
                            stringResource(R.string.importics_result, r.inserted, r.updated, r.skipped)
                        } else {
                            stringResource(R.string.importics_error_generic)
                        },
                        action = {
                            Button(onClick = onImported) {
                                Text(stringResource(R.string.importics_done))
                            }
                        },
                    )
                }

                else -> {
                    ImportForm(state = state, vm = vm)
                }
            }
        }
    }
}

@Composable
private fun ImportForm(state: ImportUiState, vm: ImportIcsViewModel) {
    val busy = state.phase == ImportPhase.Previewing || state.phase == ImportPhase.Importing
    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        if (!state.filename.isNullOrBlank()) {
            Text(
                text = state.filename!!,
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
            )
            Spacer(Modifier.height(12.dp))
        }
        Text(
            text = stringResource(R.string.importics_pick_calendar),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(4.dp))
        if (state.calendars.isEmpty()) {
            Text(
                text = stringResource(R.string.importics_no_calendars),
                style = MaterialTheme.typography.bodyMedium,
                color = mutedTextColor(),
            )
        } else {
            LazyColumn(modifier = Modifier.weight(1f)) {
                items(state.calendars, key = { it.id }) { cal ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = !busy) { vm.selectCalendar(cal.id) }
                            .padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = state.selectedCalendarId == cal.id,
                            onClick = { vm.selectCalendar(cal.id) },
                            enabled = !busy,
                        )
                        Box(
                            modifier = Modifier
                                .size(12.dp)
                                .clip(CircleShape)
                                .background(parseHex(cal.color)),
                        )
                        Text(
                            text = cal.name,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.padding(start = 10.dp),
                        )
                    }
                }
            }
        }

        val preview = state.preview
        if (preview != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = stringResource(
                    R.string.importics_summary,
                    preview.total, preview.inserted, preview.updated, preview.duplicates, preview.invalid,
                ),
                style = MaterialTheme.typography.bodyMedium,
            )
            if (preview.invalid > 0 && preview.invalidReasons.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.importics_invalid_title),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                for (reason in preview.invalidReasons) {
                    Text(
                        text = reason,
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedTextColor(),
                    )
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        when (state.phase) {
            ImportPhase.Previewing, ImportPhase.Importing -> {
                Button(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth()) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                    )
                    Text(
                        text = stringResource(
                            if (state.phase == ImportPhase.Importing) {
                                R.string.importics_importing
                            } else {
                                R.string.importics_working_preview
                            },
                        ),
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }
            }

            ImportPhase.Previewed -> {
                Button(
                    onClick = { vm.confirm() },
                    enabled = state.selectedCalendarId != null,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.importics_confirm))
                }
            }

            else -> {
                Button(
                    onClick = { vm.preview() },
                    enabled = state.selectedCalendarId != null && state.calendars.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.importics_preview))
                }
            }
        }
    }
}
