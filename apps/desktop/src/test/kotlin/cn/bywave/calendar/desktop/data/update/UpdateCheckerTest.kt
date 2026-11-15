package cn.bywave.calendar.desktop.data.update

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

class UpdateCheckerTest {
    @Test fun rejectsIncompleteOrUnsafeInstallers() {
        val asset = DesktopUpdateAsset("https://example.com/app.dmg", "a".repeat(64), 100)
        val release = DesktopUpdateInfo(30, "1.4.0", assets = mapOf("mac" to asset))
        assertTrue(UpdateChecker.validManifest(release, "mac"))
        assertFalse(UpdateChecker.validManifest(release, "macIntel"))
        for (bad in listOf(asset.copy(url = "http://example.com/app.dmg"), asset.copy(sha256 = ""),
            asset.copy(sizeBytes = 0), asset.copy(url = "https://user:pass@example.com/app.dmg"),
            asset.copy(url = "https://example.com/app.msi"))) {
            assertFalse(UpdateChecker.validManifest(release.copy(assets = mapOf("mac" to bad)), "mac"))
        }
    }
    @Test fun installersMatchMacArchitecture() {
        assertEquals("mac", UpdateChecker.detectPlatform("Mac OS X", "aarch64"))
        assertEquals("mac", UpdateChecker.detectPlatform("Darwin", "arm64"))
        assertEquals("macIntel", UpdateChecker.detectPlatform("Mac OS X", "x86_64"))
        assertEquals("macIntel", UpdateChecker.detectPlatform("Mac OS X", "amd64"))
        assertNull(UpdateChecker.detectPlatform("Mac OS X", "unknown"))
        assertEquals("win", UpdateChecker.detectPlatform("Windows 11", "amd64"))
        assertEquals("linux", UpdateChecker.detectPlatform("Linux", "amd64"))
    }
}
