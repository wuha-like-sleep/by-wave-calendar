package cn.bywave.calendar.desktop.data.update

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class UpdateCheckerTest {
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
