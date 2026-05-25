// Single-Activity entry point. v0.5 — multi-account aware.
//
// Sign-in state is now derived from ProfileStore.activeId being
// non-null (instead of TokenStore.isSignedIn). The NavHost watches
// it as a State<String?> so login completion + sign-out + last-
// account removal all flip start destination without manual handoff.
//
// "Add another account" enters the setup screen WHILE staying signed
// in to the current account — distinguished from cold-start setup
// by passing addingExtra=true so the screen knows not to "auto-
// return to calendar" if the user cancels.

package cn.bywave.calendar

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import cn.bywave.calendar.ui.calendar.CalendarScreen
import cn.bywave.calendar.ui.calendar.CalendarViewModel
import cn.bywave.calendar.ui.event.AttendeesScreen
import cn.bywave.calendar.ui.event.EventEditMode
import cn.bywave.calendar.ui.event.EventEditScreen
import cn.bywave.calendar.ui.settings.SettingsScreen
import cn.bywave.calendar.ui.setup.ScannerScreen
import cn.bywave.calendar.ui.setup.SetupScreen
import cn.bywave.calendar.ui.setup.SetupViewModel
import cn.bywave.calendar.ui.theme.ByWaveTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ByWaveTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    AppRoot()
                }
            }
        }
    }
}

@Composable
private fun AppRoot() {
    val profiles = remember { BywaveApp.instance.profiles }
    val activeId by profiles.activeId.collectAsState()
    val nav = rememberNavController()
    val loggedIn = activeId != null

    NavHost(
        navController = nav,
        startDestination = if (loggedIn) "calendar" else "setup",
    ) {
        composable("setup") {
            val setupVm: SetupViewModel = viewModel()
            SetupScreen(
                vm = setupVm,
                onSignedIn = {
                    // If we got here from "add another account", the
                    // calendar route is already on the back stack; pop
                    // back to it. Otherwise this was cold-start setup
                    // and we navigate fresh.
                    if (nav.previousBackStackEntry?.destination?.route == "calendar") {
                        nav.popBackStack("calendar", inclusive = false)
                    } else {
                        nav.navigate("calendar") {
                            popUpTo("setup") { inclusive = true }
                        }
                    }
                },
                onScanQr = { nav.navigate("scanner") },
            )
        }

        composable("scanner") {
            val parentEntry = remember(nav) { nav.getBackStackEntry("setup") }
            val setupVm: SetupViewModel = viewModel(viewModelStoreOwner = parentEntry)
            ScannerScreen(
                onResult = { raw ->
                    setupVm.onScanned(raw)
                    nav.popBackStack()
                },
                onCancel = { nav.popBackStack() },
            )
        }

        composable("calendar") {
            val calVm: CalendarViewModel = viewModel()
            CalendarScreen(
                vm = calVm,
                onOpenSettings = { nav.navigate("settings") },
                onCreateEvent = { nav.navigate("event_new") },
                onEditEvent = { ev -> nav.navigate("event_edit/${ev.id}") },
                onOpenAttendees = { ev ->
                    val title = java.net.URLEncoder.encode(ev.summary, "UTF-8")
                    nav.navigate("attendees/${ev.id}/$title")
                },
                onAddAccount = { nav.navigate("setup") },
            )
        }

        composable("settings") {
            val parentEntry = remember(nav) { nav.getBackStackEntry("calendar") }
            val calVm: CalendarViewModel = viewModel(viewModelStoreOwner = parentEntry)
            SettingsScreen(
                onBack = { nav.popBackStack() },
                onSignOut = {
                    calVm.signOutActive()
                    // If there are still other profiles, stay on calendar
                    // (ProfileStore will have picked one as active);
                    // else fall through to setup as the activeId Flow
                    // flips and start-destination recomputes.
                    nav.popBackStack("calendar", inclusive = false)
                },
            )
        }

        composable("event_new") {
            val parentEntry = remember(nav) { nav.getBackStackEntry("calendar") }
            val calVm: CalendarViewModel = viewModel(viewModelStoreOwner = parentEntry)
            val state by calVm.state.collectAsState()
            EventEditScreen(
                initialMode = EventEditMode.Create(seedStart = null),
                calendars = state.calendars,
                onDismiss = { nav.popBackStack() },
                onSaved = {
                    nav.popBackStack()
                    calVm.reload()
                },
            )
        }

        composable(
            route = "event_edit/{id}",
            arguments = listOf(navArgument("id") { type = NavType.StringType }),
        ) { entry ->
            val id = entry.arguments?.getString("id") ?: return@composable
            val parentEntry = remember(nav) { nav.getBackStackEntry("calendar") }
            val calVm: CalendarViewModel = viewModel(viewModelStoreOwner = parentEntry)
            val state by calVm.state.collectAsState()
            val source = remember(id, state.events) {
                state.events.firstOrNull { it.id == id }
            }
            if (source == null) {
                androidx.compose.runtime.LaunchedEffect(id) { nav.popBackStack() }
                return@composable
            }
            EventEditScreen(
                initialMode = EventEditMode.Edit(source),
                calendars = state.calendars,
                onDismiss = { nav.popBackStack() },
                onSaved = {
                    nav.popBackStack()
                    calVm.reload()
                },
            )
        }

        composable(
            route = "attendees/{id}/{title}",
            arguments = listOf(
                navArgument("id") { type = NavType.StringType },
                navArgument("title") { type = NavType.StringType },
            ),
        ) { entry ->
            val id = entry.arguments?.getString("id") ?: return@composable
            val titleRaw = entry.arguments?.getString("title").orEmpty()
            val title = runCatching {
                java.net.URLDecoder.decode(titleRaw, "UTF-8")
            }.getOrDefault(titleRaw)
            AttendeesScreen(
                eventId = id,
                eventTitle = title,
                onBack = { nav.popBackStack() },
            )
        }
    }
}
