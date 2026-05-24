// Single-Activity entry point. All screens live inside Compose
// navigation, no Fragments. Mirror of iOS ByWaveCalendarApp.swift +
// RootView.swift.
//
// Edge-to-edge rendering via enableEdgeToEdge() — modern Material 3
// expects content to draw behind status / nav bars and the composables
// inset themselves with WindowInsets.

package cn.bywave.calendar

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import cn.bywave.calendar.ui.calendar.CalendarScreen
import cn.bywave.calendar.ui.setup.SetupScreen
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

/**
 * Top-level navigation. v0.1 only knows two routes — `setup` and
 * `calendar`. Decides which to start at based on whether the user is
 * already signed in. Sign-out from CalendarScreen pops back to setup.
 */
@androidx.compose.runtime.Composable
private fun AppRoot() {
    val tokens = remember { BywaveApp.instance.tokenStore }
    val nav = rememberNavController()
    // Use a runtime-mutable start route so signOut() can flip it
    // without rebuilding the NavHost from scratch (which would break
    // backstack animations).
    var loggedIn by remember { mutableStateOf(tokens.isSignedIn) }

    NavHost(
        navController = nav,
        startDestination = if (loggedIn) "calendar" else "setup",
    ) {
        composable("setup") {
            SetupScreen(
                onSignedIn = {
                    loggedIn = true
                    nav.navigate("calendar") {
                        popUpTo("setup") { inclusive = true }
                    }
                },
            )
        }
        composable("calendar") {
            CalendarScreen(
                onSignOut = {
                    tokens.signOut()
                    loggedIn = false
                    nav.navigate("setup") {
                        popUpTo("calendar") { inclusive = true }
                    }
                },
            )
        }
    }
}
