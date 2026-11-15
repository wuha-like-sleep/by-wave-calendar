package cn.bywave.calendar.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.Alignment
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import cn.bywave.calendar.data.store.SyncPreferences
import cn.bywave.calendar.data.store.SyncPrefs
import cn.bywave.calendar.data.store.EventRepository
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.connect.*
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.auth.Profile
import kotlinx.serialization.json.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarConnectionsScreen(profile: Profile, onBack: () -> Unit) {
    val context = LocalContext.current
    val lifecycleState by androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val locale = context.resources.configuration.locales[0].toLanguageTag().let { if (it.startsWith("zh")) if (it.contains("TW") || it.contains("Hant")) "zh-TW" else "zh-CN" else it.substringBefore("-") }
    val api = remember(profile.id, profile.serverUrl) {
        val native = ApiClient.forProfile(profile, BywaveApp.instance.profiles).api
        object : CalendarConnectionApi {
            override suspend fun load(remote: Boolean) = native.calendarConnection(if (remote) "1" else "0")
            override suspend fun command(command: CalendarCommand) = native.calendarCommand(command)
            override suspend fun appleProfile() = native.calendarProfile()
        }
    }
    val repository = BywaveApp.instance.repository
    val prefsStore = remember { SyncPreferences(context) }
    val prefs by prefsStore.flow.collectAsState(initial = SyncPrefs())
    val snapshot by repository.observe().collectAsState(initial = EventRepository.CacheSnapshot(emptyList(), emptyList()))
    val scope = rememberCoroutineScope()
    var selection by remember(profile.id) { mutableStateOf<Set<String>?>(null) }
    var localError by remember { mutableStateOf<String?>(null) }
    var localBusy by remember { mutableStateOf(false) }
    LaunchedEffect(profile.id) { selection = prefsStore.selectedCalendars(profile.id) }
    fun apply(work: suspend () -> Unit) {
        if (localBusy) return
        localBusy = true; localError = null
        scope.launch {
            try { work(); withContext(Dispatchers.IO) { repository.applySyncPreferences(throwOnCalendarError = true) } }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { localError = CalendarCopy.text(locale, "error.unavailable") }
            finally { localBusy = false }
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[android.Manifest.permission.READ_CALENDAR] == true && granted[android.Manifest.permission.WRITE_CALENDAR] == true) apply { prefsStore.setMirrorToSystem(true) }
        else localError = context.getString(cn.bywave.calendar.R.string.settings_perm_calendar_denied)
    }
    BackHandler(onBack = onBack)
    Scaffold(topBar = { TopAppBar(title = { Text(CalendarCopy.text(locale, "title")) }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, context.getString(cn.bywave.calendar.R.string.nav_back)) } }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
            Card(Modifier.fillMaxWidth().padding(bottom = 20.dp)) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(context.getString(cn.bywave.calendar.R.string.settings_mirror_title), modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                        Switch(prefs.mirrorToSystemCalendar, enabled = !localBusy, onCheckedChange = { enabled ->
                            if (enabled) permission.launch(arrayOf(android.Manifest.permission.READ_CALENDAR, android.Manifest.permission.WRITE_CALENDAR))
                            else apply { prefsStore.setMirrorToSystem(false) }
                        })
                    }
                    Text(context.getString(cn.bywave.calendar.R.string.settings_mirror_desc), style = MaterialTheme.typography.bodySmall)
                    localError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    val selected = selection ?: snapshot.calendars.map { it.id }.toSet()
                    snapshot.calendars.forEach { calendar ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(calendar.id in selected, enabled = !localBusy, onCheckedChange = { checked ->
                                val next = if (checked) selected + calendar.id else selected - calendar.id
                                apply { prefsStore.selectCalendars(profile.id, next); selection = next }
                            })
                            Text(calendar.name)
                        }
                    }
                    TextButton(enabled = prefs.mirrorToSystemCalendar && !localBusy, onClick = { apply {} }) { Text(CalendarCopy.text(locale, "syncNow")) }
                }
            }
            CalendarConnectionPanel(api, locale, apple = false, deviceLabel = "Android Calendar",
                openUrl = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) },
                copy = { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("ByWave", it)) },
                installProfile = {},
                active = lifecycleState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED),
                errorMessage = { error ->
                    if (error is retrofit2.HttpException && error.code() == 404) CalendarCopy.text(locale, "serverUpdate")
                    else {
                        val code = runCatching {
                            val body = (error as? retrofit2.HttpException)?.response()?.errorBody()?.string() ?: "{}"
                            val value = Json.parseToJsonElement(body).jsonObject["error"]
                            (value as? JsonPrimitive)?.contentOrNull ?: (value as? JsonObject)?.get("code")?.jsonPrimitive?.contentOrNull
                        }.getOrNull()
                        val key = "error.$code"
                        CalendarCopy.text(locale, key).takeIf { it != key } ?: CalendarCopy.text(locale, "error.unavailable")
                    }
                },
            )
        }
    }
}
