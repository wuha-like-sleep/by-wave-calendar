package cn.bywave.calendar.desktop.ui.main

import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.unit.Density
import cn.bywave.calendar.connect.formatSyncTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalComposeUiApi::class)
class DisplayTimeZoneLabelsTest {
    @Test fun `open search settings and connection labels reformat the same instant when the display zone changes`() {
        val instant = "2026-11-16T01:00:00Z"
        var zone by mutableStateOf(ZoneId.of("Australia/Melbourne"))
        var search = ""
        var settings = ""
        var sync = ""
        val scene = ImageComposeScene(width = 300, height = 200, density = Density(1f))
        try {
            scene.setContent {
                val nextSearch = resultTimeLabel(instant, zone)
                val nextSettings = formatTimestamp(instant, zone)
                val nextSync = formatSyncTime(instant, zone, "en-GB")
                SideEffect { search = nextSearch; settings = nextSettings; sync = nextSync }
            }
            scene.render()
            assertEquals("2026-11-16 12:00", search)
            assertEquals(search, settings)
            assertTrue(sync.contains("12:00"), sync)

            Snapshot.withMutableSnapshot { zone = ZoneId.of("Asia/Shanghai") }
            scene.render()
            assertEquals("2026-11-16 09:00", search)
            assertEquals(search, settings)
            assertTrue(sync.contains("09:00"), sync)

            Snapshot.withMutableSnapshot { zone = ZoneId.of("America/Los_Angeles") }
            scene.render()
            assertEquals("2026-11-15 17:00", search)
            assertEquals(search, settings)
            assertTrue(sync.contains("17:00"), sync)
        } finally { scene.close() }
    }

    @Test fun `connection formatting refreshes for locale changes and invalid timestamps remain readable`() {
        var locale by mutableStateOf("en-US")
        var shown = ""
        var invalid = emptyList<String>()
        val zone = ZoneId.of("Asia/Shanghai")
        val scene = ImageComposeScene(width = 300, height = 200, density = Density(1f))
        try {
            scene.setContent {
                val next = formatSyncTime("2026-11-16T01:00:00Z", zone, locale)
                val nextInvalid = listOf(resultTimeLabel("invalid", zone), formatTimestamp("invalid", zone), formatSyncTime("invalid", zone, locale))
                SideEffect { shown = next; invalid = nextInvalid }
            }
            scene.render()
            val english = shown
            assertEquals(listOf("invalid", "invalid", "invalid"), invalid)
            Snapshot.withMutableSnapshot { locale = "de" }
            scene.render()
            assertNotEquals(english, shown)
            assertTrue(shown.contains("09:00"), shown)
        } finally { scene.close() }
    }

    @Test fun `an open calendar draft keeps its source timezone while new dialogs use the latest device zone`() {
        var zone by mutableStateOf(ZoneId.of("Australia/Melbourne"))
        var visible by mutableStateOf(true)
        var existing by mutableStateOf<String?>("America/New_York")
        var draft: androidx.compose.runtime.MutableState<String>? = null
        val scene = ImageComposeScene(width = 300, height = 200, density = Density(1f))
        try {
            scene.setContent {
                if (visible) {
                    val state = rememberCalendarTimezoneDraft(existing, zone)
                    SideEffect { draft = state }
                }
            }
            scene.render()
            assertEquals("America/New_York", draft!!.value)
            Snapshot.withMutableSnapshot { zone = ZoneId.of("Asia/Shanghai") }
            scene.render()
            assertEquals("America/New_York", draft!!.value)
            Snapshot.withMutableSnapshot { draft!!.value = "Europe/Paris"; zone = ZoneId.of("Pacific/Auckland") }
            scene.render()
            assertEquals("Europe/Paris", draft!!.value)

            Snapshot.withMutableSnapshot { visible = false }
            scene.render()
            Snapshot.withMutableSnapshot { existing = null; visible = true }
            scene.render()
            assertEquals("Pacific/Auckland", draft!!.value)
            Snapshot.withMutableSnapshot { zone = ZoneId.of("Asia/Tokyo") }
            scene.render()
            assertEquals("Pacific/Auckland", draft!!.value)
        } finally { scene.close() }
    }
}
