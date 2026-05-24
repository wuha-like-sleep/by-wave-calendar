// Single-Activity entry point. All screens live inside Compose
// navigation, no Fragments.
//
// v0.3 navigation graph:
//   setup ─┬─→ scanner (QR scan → fills setup form on return)
//          └─→ calendar (after successful sign-in)
//                ├─→ settings (account / about / sign-out → pops back to setup)
//                ├─→ event_new
//                └─→ event_edit/{id}
//
// CalendarViewModel is scoped to the "calendar" NavGraph entry so
// EventEditScreen can read the wide-window event cache when opening
// for "edit existing" without re-fetching.

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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import cn.bywave.calendar.ui.calendar.CalendarScreen
import cn.bywave.calendar.ui.calendar.CalendarViewModel
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
    val tokens = remember { BywaveApp.instance.tokenStore }
    val nav = rememberNavController()
    // Use a runtime-mutable start route so signOut() can flip without
    // rebuilding the NavHost from scratch.
    var loggedIn by remember { mutableStateOf(tokens.isSignedIn) }

    NavHost(
        navController = nav,
        startDestination = if (loggedIn) "calendar" else "setup",
    ) {
        composable("setup") {
            // Get the shared SetupViewModel scoped to "setup" so the
            // QR scanner result can flow back through onScanned().
            val setupVm: SetupViewModel = viewModel()
            SetupScreen(
                vm = setupVm,
                onSignedIn = {
                    loggedIn = true
                    nav.navigate("calendar") {
                        popUpTo("setup") { inclusive = true }
                    }
                },
                onScanQr = { nav.navigate("scanner") },
            )
        }

        composable("scanner") {
            // Share the parent route's SetupViewModel so the scanned
            // pair URL fills the form in the previous screen.
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
            val state by calVm.state.collectAsState()
            CalendarScreen(
                vm = calVm,
                onOpenSettings = { nav.navigate("settings") },
                onCreateEvent = { nav.navigate("event_new") },
                onEditEvent = { ev -> nav.navigate("event_edit/${ev.id}") },
            )
        }

        composable("settings") {
            SettingsScreen(
                onBack = { nav.popBackStack() },
                onSignOut = {
                    tokens.signOut()
                    cn.bywave.calendar.data.api.ApiClient.reset()
                    loggedIn = false
                    nav.navigate("setup") {
                        popUpTo("calendar") { inclusive = true }
                    }
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
            // Find the event in the wide-window cache. For recurring
            // events the same id appears multiple times (one per
            // occurrence) — first match is the master / earliest.
            val source = remember(id, state.events) {
                state.events.firstOrNull { it.id == id }
            }
            if (source == null) {
                // Cache miss (e.g. cold launch deep-link) — pop back;
                // v0.4 will fetch the single event from the server.
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
    }
}
