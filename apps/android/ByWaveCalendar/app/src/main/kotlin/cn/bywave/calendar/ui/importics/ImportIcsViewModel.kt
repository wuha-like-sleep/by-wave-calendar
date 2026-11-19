// ImportIcsViewModel — drives the "open / share a .ics file with
// ByWave" flow: read the handed-over file, pick a target calendar,
// preview the import (server-side judgement, writes nothing), then
// import for real. Same two steps as the web import dialog, on top of
// the /api/v1 import endpoints.
//
// The file text itself stays out of the UI state — it can be several
// megabytes, and StateFlow copies would drag it through every
// recomposition.

package cn.bywave.calendar.ui.importics

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.IcsImportPreview
import cn.bywave.calendar.data.model.IcsImportResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class ImportPhase { Reading, Ready, Previewing, Previewed, Importing, Done, Failed }

enum class ImportErrorKind { Read, TooLarge, NotIcs, Generic }

data class ImportUiState(
    val phase: ImportPhase = ImportPhase.Reading,
    val filename: String? = null,
    val calendars: List<CalendarMeta> = emptyList(),
    val selectedCalendarId: String? = null,
    val preview: IcsImportPreview? = null,
    val result: IcsImportResult? = null,
    val error: ImportErrorKind? = null,
    val errorDetail: String? = null,
)

/** Server-side cap, mirrored from src/lib/ics_limits.ts
 *  (MAX_ICS_IMPORT_BYTES). Reading stops one byte past it so a huge
 *  file handed over by another app is rejected without first being
 *  loaded into memory whole. */
private const val MAX_ICS_BYTES = 8 * 1024 * 1024

private class TooLargeException : Exception("ics file too large")
private class NotIcsException : Exception("not an ics file")

class ImportIcsViewModel : ViewModel() {
    private val repository = BywaveApp.instance.repository

    private val _state = MutableStateFlow(ImportUiState())
    val state: StateFlow<ImportUiState> = _state.asStateFlow()

    private var text: String? = null
    private var loadedUri: Uri? = null

    init {
        // The calendar picker mirrors the same local cache the
        // calendar screen shows; keep the selection valid as the
        // snapshot changes (first load, account switch).
        viewModelScope.launch {
            repository.observe().collect { snap ->
                _state.update { s ->
                    val selected = s.selectedCalendarId?.takeIf { id -> snap.calendars.any { it.id == id } }
                        ?: snap.calendars.firstOrNull()?.id
                    s.copy(calendars = snap.calendars, selectedCalendarId = selected)
                }
            }
        }
    }

    fun load(context: Context, uri: Uri) {
        if (loadedUri == uri) return
        loadedUri = uri
        _state.update {
            it.copy(
                phase = ImportPhase.Reading,
                preview = null,
                result = null,
                error = null,
                errorDetail = null,
            )
        }
        viewModelScope.launch {
            try {
                val (name, content) = readFile(context.applicationContext, uri)
                text = content
                _state.update { it.copy(phase = ImportPhase.Ready, filename = name) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val kind = when (e) {
                    is TooLargeException -> ImportErrorKind.TooLarge
                    is NotIcsException -> ImportErrorKind.NotIcs
                    else -> ImportErrorKind.Read
                }
                _state.update { it.copy(phase = ImportPhase.Failed, error = kind) }
            }
        }
    }

    fun selectCalendar(id: String) {
        _state.update { s ->
            if (s.selectedCalendarId == id) return@update s
            // The preview was computed against another calendar — the
            // web dialog voids it the same way when the target changes.
            val voidPreview = s.phase == ImportPhase.Previewed || s.phase == ImportPhase.Previewing
            s.copy(
                selectedCalendarId = id,
                preview = if (voidPreview) null else s.preview,
                phase = if (voidPreview) ImportPhase.Ready else s.phase,
            )
        }
    }

    fun preview() {
        val content = text ?: return
        val calId = _state.value.selectedCalendarId ?: return
        if (_state.value.phase == ImportPhase.Previewing) return
        _state.update { it.copy(phase = ImportPhase.Previewing, error = null, errorDetail = null) }
        viewModelScope.launch {
            try {
                val p = repository.previewImport(calId, content, _state.value.filename)
                _state.update { it.copy(phase = ImportPhase.Previewed, preview = p) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    fun confirm() {
        val content = text ?: return
        val calId = _state.value.selectedCalendarId ?: return
        if (_state.value.phase != ImportPhase.Previewed) return
        _state.update { it.copy(phase = ImportPhase.Importing, error = null, errorDetail = null) }
        viewModelScope.launch {
            try {
                val r = repository.importIcs(calId, content, _state.value.filename)
                _state.update { it.copy(phase = ImportPhase.Done, result = r) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    /** Back to the form after an API failure, with the file's content
     *  still in hand: a preview failure lands on Ready (re-preview), an
     *  import failure on Previewed (that preview still matches the
     *  selected calendar). Only Generic failures are retryable — the
     *  413/400 kinds are properties of the file itself, and read
     *  failures never had content to retry with. */
    fun retry() {
        val s = _state.value
        if (s.phase != ImportPhase.Failed || s.error != ImportErrorKind.Generic || text == null) return
        _state.update {
            it.copy(
                phase = if (it.preview != null) ImportPhase.Previewed else ImportPhase.Ready,
                error = null,
                errorDetail = null,
            )
        }
    }

    private fun fail(e: Exception) {
        val kind = when ((e as? retrofit2.HttpException)?.code()) {
            413 -> ImportErrorKind.TooLarge
            400 -> ImportErrorKind.NotIcs
            else -> ImportErrorKind.Generic
        }
        _state.update {
            it.copy(phase = ImportPhase.Failed, error = kind, errorDetail = serverErrorMessage(e))
        }
    }

    private suspend fun readFile(context: Context, uri: Uri): Pair<String?, String> =
        withContext(Dispatchers.IO) {
            val name = displayName(context, uri)
            val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
                val buf = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(64 * 1024)
                var total = 0
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    total += n
                    if (total > MAX_ICS_BYTES) throw TooLargeException()
                    buf.write(chunk, 0, n)
                }
                buf.toByteArray()
            } ?: throw java.io.IOException("cannot open $uri")
            val content = String(bytes, Charsets.UTF_8)
            // Same cheap pre-check the web dialog does before uploading.
            if (!content.contains("BEGIN:VCALENDAR", ignoreCase = true)) throw NotIcsException()
            name to content
        }

    private fun displayName(context: Context, uri: Uri): String? {
        val fromCursor = runCatching {
            context.contentResolver
                .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull()
        return fromCursor ?: uri.lastPathSegment?.substringAfterLast('/')
    }
}
