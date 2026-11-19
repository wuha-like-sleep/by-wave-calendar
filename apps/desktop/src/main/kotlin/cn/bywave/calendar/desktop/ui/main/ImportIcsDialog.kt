// ImportIcsDialog — confirmation dialog for importing a .ics file
// picked in the toolbar (see pickIcsFile below). Pick the target
// calendar, preview the counts, confirm, see the result: the same
// two steps as the web import dialog and the Android/iOS import
// screens, on the /api/v1 import endpoints. Switching the target
// calendar voids the preview, like the web.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.api.ApiException
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import cn.bywave.calendar.desktop.data.model.IcsImportPreview
import cn.bywave.calendar.desktop.data.model.IcsImportResult
import cn.bywave.calendar.desktop.data.model.Profile
import cn.bywave.calendar.desktop.i18n.I18n
import cn.bywave.calendar.desktop.ui.calendar.parseHex
import cn.bywave.calendar.desktop.util.userFacingError
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class ImportPhase { Reading, Ready, Previewing, Previewed, Importing, Done, Failed }

private class TooLargeException : Exception("ics file too large")
private class NotIcsException : Exception("not an ics file")

/** Server-side cap, mirrored from src/lib/ics_limits.ts
 *  (MAX_ICS_IMPORT_BYTES) — checked on the file length before the
 *  text is even read. */
private const val MAX_ICS_BYTES = 8L * 1024 * 1024

private fun readIcsFile(file: File): String {
    if (file.length() > MAX_ICS_BYTES) throw TooLargeException()
    val content = file.readText(Charsets.UTF_8)
    // Same cheap pre-check the web dialog does before uploading.
    if (!content.contains("BEGIN:VCALENDAR", ignoreCase = true)) throw NotIcsException()
    return content
}

/** Native open-file dialog for .ics files. Compose Desktop has no
 *  built-in picker; the app already leans on java.awt for the tray
 *  and Desktop integration, so AWT's FileDialog (the native picker
 *  on macOS and Windows) is the consistent choice. It blocks until
 *  the user picks or cancels — exactly the modal behaviour wanted
 *  from a toolbar button. Returns null on cancel. */
internal fun pickIcsFile(): File? {
    val dialog = java.awt.FileDialog(
        null as java.awt.Frame?,
        I18n.t("import.title"),
        java.awt.FileDialog.LOAD,
    )
    dialog.setFilenameFilter { _, name -> name.endsWith(".ics", ignoreCase = true) }
    dialog.isVisible = true
    val dir = dialog.directory ?: return null
    val name = dialog.file ?: return null
    return File(dir, name)
}

@Composable
fun ImportIcsDialog(
    profile: Profile,
    file: File,
    calendars: List<CalendarMeta>,
    onImported: () -> Unit,
    onDismiss: () -> Unit,
) {
    val locale by I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> I18n.t(key) } }
    val scope = rememberCoroutineScope()

    var phase by remember { mutableStateOf(ImportPhase.Reading) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf<String?>(null) }
    var selectedId by remember { mutableStateOf(calendars.firstOrNull()?.id) }
    var preview by remember { mutableStateOf<IcsImportPreview?>(null) }
    var result by remember { mutableStateOf<IcsImportResult?>(null) }
    val busy = phase == ImportPhase.Previewing || phase == ImportPhase.Importing

    LaunchedEffect(file) {
        try {
            text = withContext(Dispatchers.IO) { readIcsFile(file) }
            phase = ImportPhase.Ready
        } catch (e: CancellationException) {
            throw e
        } catch (e: TooLargeException) {
            errorText = I18n.t("import.errorTooLarge")
            phase = ImportPhase.Failed
        } catch (e: NotIcsException) {
            errorText = I18n.t("import.errorNotIcs")
            phase = ImportPhase.Failed
        } catch (e: Exception) {
            errorText = I18n.t("import.errorRead")
            phase = ImportPhase.Failed
        }
    }

    fun failApi(e: Exception) {
        errorText = when ((e as? ApiException)?.status) {
            413 -> I18n.t("import.errorTooLarge")
            400 -> I18n.t("import.errorNotIcs")
            else -> userFacingError(e, "import.errorGeneric")
        }
        phase = ImportPhase.Failed
    }

    fun runPreview() {
        val content = text ?: return
        val calId = selectedId ?: return
        phase = ImportPhase.Previewing
        scope.launch {
            try {
                val p = ApiClient(profile).importPreview(calId, content, file.name)
                preview = p
                phase = ImportPhase.Previewed
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failApi(e)
            }
        }
    }

    fun runImport() {
        val content = text ?: return
        val calId = selectedId ?: return
        phase = ImportPhase.Importing
        scope.launch {
            try {
                result = ApiClient(profile).importIcs(calId, content, file.name)
                phase = ImportPhase.Done
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failApi(e)
            }
        }
    }

    fun selectCalendar(id: String) {
        if (selectedId == id) return
        selectedId = id
        // The preview was computed against another calendar — void it.
        if (phase == ImportPhase.Previewed || phase == ImportPhase.Previewing) {
            preview = null
            phase = ImportPhase.Ready
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(t("import.title")) },
        text = {
            when (phase) {
                ImportPhase.Reading -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(12.dp))
                        Text(file.name)
                    }
                }

                ImportPhase.Failed -> {
                    Text(errorText ?: t("import.errorGeneric"))
                }

                ImportPhase.Done -> {
                    val r = result
                    Text(
                        if (r != null) {
                            I18n.t(
                                "import.result",
                                mapOf("inserted" to r.inserted, "updated" to r.updated, "skipped" to r.skipped),
                            )
                        } else {
                            t("import.errorGeneric")
                        },
                    )
                }

                else -> {
                    Column {
                        Text(file.name)
                        Spacer(Modifier.size(12.dp))
                        Text(t("import.pickCalendar"), fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.size(4.dp))
                        if (calendars.isEmpty()) {
                            Text(t("import.noCalendars"))
                        } else {
                            Column(
                                modifier = Modifier
                                    .heightIn(max = 220.dp)
                                    .verticalScroll(rememberScrollState()),
                            ) {
                                for (cal in calendars) {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable(enabled = !busy) { selectCalendar(cal.id) }
                                            .padding(vertical = 2.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        RadioButton(
                                            selected = selectedId == cal.id,
                                            onClick = { selectCalendar(cal.id) },
                                            enabled = !busy,
                                        )
                                        Box(
                                            modifier = Modifier
                                                .size(12.dp)
                                                .clip(CircleShape)
                                                .background(parseHex(cal.color)),
                                        )
                                        Spacer(Modifier.width(10.dp))
                                        Text(cal.name)
                                    }
                                }
                            }
                        }
                        val p = preview
                        if (p != null) {
                            Spacer(Modifier.size(12.dp))
                            Text(
                                I18n.t(
                                    "import.summary",
                                    mapOf(
                                        "total" to p.total,
                                        "inserted" to p.inserted,
                                        "updated" to p.updated,
                                        "duplicates" to p.duplicates,
                                        "invalid" to p.invalid,
                                    ),
                                ),
                            )
                            if (p.invalid > 0 && p.invalidReasons.isNotEmpty()) {
                                Spacer(Modifier.size(8.dp))
                                Text(t("import.invalidTitle"), fontWeight = FontWeight.SemiBold)
                                for (reason in p.invalidReasons) {
                                    Text(reason)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            when (phase) {
                ImportPhase.Done -> {
                    Button(onClick = onImported) { Text(t("import.done")) }
                }

                ImportPhase.Failed -> {
                    Button(onClick = onDismiss) { Text(t("import.done")) }
                }

                ImportPhase.Previewing, ImportPhase.Importing -> {
                    Button(onClick = {}, enabled = false) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(t(if (phase == ImportPhase.Importing) "import.importing" else "import.workingPreview"))
                    }
                }

                ImportPhase.Previewed -> {
                    Button(onClick = { runImport() }, enabled = selectedId != null) {
                        Text(t("import.confirm"))
                    }
                }

                else -> {
                    Button(
                        onClick = { runPreview() },
                        enabled = selectedId != null && calendars.isNotEmpty(),
                    ) {
                        Text(t("import.preview"))
                    }
                }
            }
        },
        dismissButton = {
            if (phase != ImportPhase.Done && phase != ImportPhase.Failed) {
                TextButton(onClick = onDismiss, enabled = !busy) {
                    Text(t("common.cancel"))
                }
            }
        },
    )
}
