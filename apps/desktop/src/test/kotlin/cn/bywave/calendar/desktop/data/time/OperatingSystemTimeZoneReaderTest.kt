package cn.bywave.calendar.desktop.data.time

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.nio.file.Path
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import org.junit.jupiter.api.Assumptions.assumeTrue

class OperatingSystemTimeZoneReaderTest {
    @Test fun windowsMappingUsesCountryThenGlobalDefaultAndRejectsUnknown() {
        val mappings = WindowsTimeZoneMappings("""
            # Windows key:region:IANA:
            Pacific Standard Time:001:America/Los_Angeles:
            Pacific Standard Time:CA:America/Vancouver:
            China Standard Time:001:Asia/Shanghai:
            AUS Eastern Standard Time:001:Australia/Sydney:
            broken:001:Not/A/Zone:
            malformed line
        """.trimIndent())
        assertEquals(ZoneId.of("America/Vancouver"), mappings.resolve("Pacific Standard Time", "CA"))
        assertEquals(ZoneId.of("America/Los_Angeles"), mappings.resolve("Pacific Standard Time", "AU"))
        assertEquals(ZoneId.of("Asia/Shanghai"), mappings.resolve("China Standard Time", "CN"))
        assertEquals(ZoneId.of("Australia/Sydney"), mappings.resolve("AUS Eastern Standard Time", "AU"))
        assertNull(mappings.resolve("Unknown Standard Time", "AU"))
        assertNull(mappings.resolve("broken", "001"))
    }

    @Test fun parsesWindowsAbiIncludingUtf16KeyAndDisabledDstWithoutNativePlatformAssumptions() {
        val data = ByteArray(432)
        val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
        buffer.putInt(0, -600)
        buffer.putInt(84, 0)
        buffer.putShort(70, 4)
        buffer.putShort(154, 10)
        "AUS Eastern Standard Time\u0000".toByteArray(Charsets.UTF_16LE).copyInto(data, 172)
        data[428] = 1
        assertEquals(WindowsTimeZoneSetting("AUS Eastern Standard Time", -600, 0, 4, 10, true), parseWindowsTimeZone(2, data))
        assertNull(parseWindowsTimeZone(-1, data))
        assertNull(parseWindowsTimeZone(0, ByteArray(431)))
        ByteArray(256) { 1 }.copyInto(data, 172)
        assertNull(parseWindowsTimeZone(0, data))
    }

    @Test fun explicitNoDstOffsetRetainsHalfAndQuarterHourOffsetsAndBiasSign() {
        assertEquals(ZoneOffset.of("+05:45"), fixedWindowsOffset(-345))
        assertEquals(ZoneOffset.of("-03:30"), fixedWindowsOffset(210))
        assertEquals(ZoneId.of("Etc/GMT-10"), fixedWindowsOffset(-600))
        assertNull(fixedWindowsOffset(Int.MAX_VALUE.toLong()))
    }

    @Test fun fixedWholeHourZonesUseInteroperableIanaNamesWithoutChangingOffset() {
        assertEquals(ZoneId.of("UTC"), fixedWindowsOffset(0))
        assertEquals(ZoneId.of("Etc/GMT+5"), fixedWindowsOffset(300))
        assertEquals(ZoneId.of("Etc/GMT-14"), fixedWindowsOffset(-840))
        for (bias in -840L..720L step 60) {
            val zone = assertNotNull(fixedWindowsOffset(bias))
            assertEquals(true, zone.rules.isFixedOffset)
            assertEquals((-bias * 60).toInt(), zone.rules.getOffset(java.time.Instant.EPOCH).totalSeconds)
        }
    }

    @Test fun disabledDstIgnoresStaleTransitionDatesAndDoesNotRequireMappingFile() {
        val setting = WindowsTimeZoneSetting("AUS Eastern Standard Time", -600, 0, 4, 10, true)
        assertEquals(ZoneId.of("Etc/GMT-10"), resolveWindowsTimeZone(setting, "AU") { error("must not load mapping") })
        val mapping = WindowsTimeZoneMappings("AUS Eastern Standard Time:001:Australia/Sydney:")
        assertEquals(ZoneId.of("Australia/Sydney"), resolveWindowsTimeZone(setting.copy(daylightDisabled = false), "AU") { mapping })
    }

    @Test fun unixSymlinkNameRequiresAValidZoneAndNeverSilentlyBecomesGmt() {
        assertEquals(ZoneId.of("Australia/Melbourne"), zoneFromLocaltimePath("/var/db/timezone/zoneinfo/Australia/Melbourne"))
        assertEquals(ZoneId.of("Asia/Shanghai"), zoneFromLocaltimePath("/usr/share/zoneinfo/Asia/Shanghai"))
        assertEquals(ZoneId.of("Europe/Paris"), zoneFromLocaltimePath("/var/db/timezone/zoneinfo.default/Europe/Paris"))
        assertNull(zoneFromLocaltimePath("/etc/localtime"))
        assertNull(zoneFromLocaltimePath("/usr/share/zoneinfo/Invalid/Zone"))
        assertNull(parseSystemZone("unknown"))
    }

    @Test fun macNativeReadMatchesActualLocaltimeWithoutChangingSystemSettings() {
        assumeTrue(System.getProperty("os.name").startsWith("Mac"))
        val expected = assertNotNull(zoneFromLocaltimePath(Path.of("/etc/localtime").toRealPath().toString()))
        repeat(3) { assertEquals(expected, MacTimeZoneReader().read()) }
    }

    @Test fun windowsNativeReadAndBundledJdkMappingAreAvailable() {
        assumeTrue(System.getProperty("os.name").startsWith("Windows"))
        val mappings = Path.of(System.getProperty("java.home"), "lib", "tzmappings")
        assertEquals(true, Files.isRegularFile(mappings), "java.base must include its Windows timezone mapping")
        assertNotNull(WindowsTimeZoneReader().read())
    }
}
