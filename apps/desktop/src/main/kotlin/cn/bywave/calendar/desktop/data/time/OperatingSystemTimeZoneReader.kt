package cn.bywave.calendar.desktop.data.time

import com.sun.jna.Library
import com.sun.jna.Memory
import com.sun.jna.Native
import com.sun.jna.NativeLong
import com.sun.jna.Pointer
import com.sun.jna.win32.StdCallLibrary
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.nio.file.Path
import java.time.DateTimeException
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

/** Live OS reads; never consults the JVM's cached user.timezone property. */
internal class OperatingSystemTimeZoneReader {
    private val platform = System.getProperty("os.name").lowercase(Locale.ROOT)
    private val mac by lazy { MacTimeZoneReader() }
    private val windows by lazy { WindowsTimeZoneReader() }

    fun read(): ZoneId? = when {
        platform.startsWith("mac") -> safely { mac.read() } ?: unixTimeZone()
        platform.startsWith("windows") -> safely { windows.read() }
        else -> unixTimeZone()
    }
}

private fun <T> safely(read: () -> T?): T? = try { read() }
    catch (_: Exception) { null }
    catch (_: LinkageError) { null }

internal fun parseSystemZone(id: String): ZoneId? = try { ZoneId.of(id) }
    catch (_: DateTimeException) { null }

private fun unixTimeZone(): ZoneId? = safely {
    val resolved = Path.of("/etc/localtime").toRealPath().toString()
    zoneFromLocaltimePath(resolved)
} ?: safely {
    parseSystemZone(Files.readString(Path.of("/etc/timezone")).trim())
}

internal fun zoneFromLocaltimePath(path: String): ZoneId? {
    // macOS uses /var/db/timezone/zoneinfo; Linux commonly /usr/share/zoneinfo.
    val id = path.substringAfterLast("/zoneinfo/", "").ifEmpty {
        path.substringAfterLast("/zoneinfo.default/", "")
    }
    return parseSystemZone(id)
}

internal class MacTimeZoneReader {
    private val foundation by lazy {
        Native.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", CoreFoundationTimeZone::class.java)
    }

    fun read(): ZoneId? {
        // Apple's system zone is cached separately from the JVM default. Reset
        // it before every read, then release only the Copy-owned reference.
        foundation.CFTimeZoneResetSystem()
        val timeZone = foundation.CFTimeZoneCopySystem() ?: return null
        return try {
            val name = foundation.CFTimeZoneGetName(timeZone) ?: return null
            val bytes = ByteArray(512)
            if (foundation.CFStringGetCString(name, bytes, NativeLong(bytes.size.toLong()), 0x08000100).toInt() == 0) return null
            val end = bytes.indexOf(0).takeIf { it >= 0 } ?: return null
            parseSystemZone(bytes.copyOf(end).toString(Charsets.UTF_8))
        } finally {
            foundation.CFRelease(timeZone)
        }
    }
}

internal interface CoreFoundationTimeZone : Library {
    fun CFTimeZoneResetSystem()
    fun CFTimeZoneCopySystem(): Pointer?
    fun CFTimeZoneGetName(zone: Pointer): Pointer?
    fun CFStringGetCString(string: Pointer, buffer: ByteArray, capacity: NativeLong, encoding: Int): Byte
    fun CFRelease(value: Pointer)
}

internal class WindowsTimeZoneReader {
    private val kernel by lazy { Native.load("kernel32", WindowsTimeZoneApi::class.java) }
    // This is shipped in java.base on Windows, including the jlink runtime.
    // Reuse its maintained Windows→IANA/region table rather than a partial list.
    private val mappings by lazy {
        WindowsTimeZoneMappings(Files.readString(Path.of(System.getProperty("java.home"), "lib", "tzmappings")))
    }

    fun read(): ZoneId? = Memory(432).use { memory ->
        memory.clear()
        val result = kernel.GetDynamicTimeZoneInformation(memory)
        val setting = parseWindowsTimeZone(result, memory.getByteArray(0, 432)) ?: return null
        val country = safely {
            val buffer = CharArray(4)
            if (kernel.GetUserDefaultGeoName(buffer, buffer.size) > 0) String(buffer).substringBefore('\u0000') else null
        } ?: Locale.getDefault().country
        resolveWindowsTimeZone(setting, country) { mappings }
    }
}

internal interface WindowsTimeZoneApi : StdCallLibrary {
    fun GetDynamicTimeZoneInformation(information: Pointer): Int
    fun GetUserDefaultGeoName(buffer: CharArray, capacity: Int): Int
}

internal data class WindowsTimeZoneSetting(
    val keyName: String,
    val biasMinutes: Int,
    val standardBiasMinutes: Int,
    val standardMonth: Int,
    val daylightMonth: Int,
    val daylightDisabled: Boolean,
)

/** Windows uses 32-bit LONG, 16-bit WCHAR/SYSTEMTIME, and an 8-bit BOOLEAN on x64 too. */
internal fun parseWindowsTimeZone(result: Int, bytes: ByteArray): WindowsTimeZoneSetting? {
    if (result !in 0..2 || bytes.size != 432) return null
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    val name = bytes.copyOfRange(172, 428).toString(Charsets.UTF_16LE)
    if ('\u0000' !in name) return null
    return WindowsTimeZoneSetting(
        keyName = name.substringBefore('\u0000'),
        biasMinutes = buffer.getInt(0),
        standardBiasMinutes = buffer.getInt(84),
        standardMonth = buffer.getShort(70).toInt(),
        daylightMonth = buffer.getShort(154).toInt(),
        daylightDisabled = bytes[428].toInt() != 0,
    )
}

internal fun fixedWindowsOffset(biasMinutes: Long): ZoneId? {
    if (biasMinutes !in -1080..1080) return null
    if (biasMinutes == 0L) return ZoneId.of("UTC")
    if (biasMinutes % 60 == 0L) {
        // Etc/GMT uses the same west-positive sign as Windows Bias. Prefer its
        // IANA name so calendar/event APIs can retain this fixed-zone meaning.
        val hours = biasMinutes / 60
        parseSystemZone("Etc/GMT" + if (hours > 0) "+$hours" else "$hours")?.let { return it }
    }
    // IANA has no general fixed half-/quarter-hour zone. Preserve the exact
    // display offset rather than inventing a city with different DST/history.
    return ZoneOffset.ofTotalSeconds((-biasMinutes * 60).toInt())
}

internal fun resolveWindowsTimeZone(
    setting: WindowsTimeZoneSetting,
    region: String,
    mappings: () -> WindowsTimeZoneMappings,
): ZoneId? {
    if (setting.daylightDisabled) {
        // Match OpenJDK's native Windows detection: this flag takes precedence
        // even if old transition months remain in the returned structure.
        // Using IANA rules here would re-enable the user's disabled adjustment.
        return fixedWindowsOffset(setting.biasMinutes.toLong() + setting.standardBiasMinutes)
    }
    return mappings().resolve(setting.keyName, region)
}

internal class WindowsTimeZoneMappings(text: String) {
    private val entries = text.lineSequence().filterNot { it.startsWith('#') }.mapNotNull { line ->
        val parts = line.trim().split(':')
        if (parts.size != 4 || parts[3].isNotEmpty()) null
        else parseSystemZone(parts[2])?.let { Triple(parts[0], parts[1], it) }
    }.toList()

    fun resolve(key: String, region: String): ZoneId? {
        val matches = entries.filter { it.first == key }
        return matches.firstOrNull { it.second == region }?.third
            ?: matches.firstOrNull { it.second == "001" }?.third
    }
}
