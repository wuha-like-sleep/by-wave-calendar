package cn.bywave.calendar.desktop.data.update

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue

class WindowsUpdateScriptTest {
    @Test fun unicodeAndShellCharactersSurviveEncoding() {
        val path = "C:\\中文 O'Brien & %TEMP%\\\$(literal); [calendar].msi"
        val script = WindowsUpdateScript.build(path, null, 123, "a".repeat(64), "C:\\log", "C:\\ready", false)
        assertEquals(script, String(Base64.getDecoder().decode(WindowsUpdateScript.encoded(script)), Charsets.UTF_16LE))
        assertTrue(script.contains("'C:\\中文 O''Brien & %TEMP%\\\$(literal); [calendar].msi'"))
        assertFailsWith<IllegalArgumentException> { WindowsUpdateScript.literal("a\nexit") }
    }

    private fun exercise(result: Int, relaunch: Boolean = true, changed: Boolean = false): Pair<String, String> {
        assumeTrue(System.getProperty("os.name").lowercase().contains("win"))
        val directory = Files.createTempDirectory("bywave-windows-test-").toFile()
        try {
            val unusual = File(directory, "中文 O'Brien & %TEMP% \$(literal)").apply { mkdirs() }
            val msi = File(unusual, "日历 [test].msi").apply { writeText("test fixture; never installed") }
            val exe = File(unusual, "日历.exe").apply { writeText("test fixture; never executed") }
            val trace = File(directory, "calls.txt")
            val log = File(directory, "update.log")
            val hash = MessageDigest.getInstance("SHA-256").digest(msi.readBytes()).joinToString("") { "%02x".format(it) }
            val dollar = '$'
            val prelude = """
                [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(${dollar}false)
                function Start-Process {
                    param([string]${dollar}FilePath, [string]${dollar}ArgumentList, [switch]${dollar}Wait, [switch]${dollar}PassThru)
                    Add-Content -LiteralPath ${WindowsUpdateScript.literal(trace.absolutePath)} -Encoding UTF8 -Value ("PATH=" + ${dollar}FilePath + " ARGS=" + ${dollar}ArgumentList)
                    if (${dollar}PassThru) { [pscustomobject]@{ ExitCode = $result } }
                }
            """.trimIndent()
            val payload = WindowsUpdateScript.build(msi.absolutePath, exe.absolutePath, Int.MAX_VALUE.toLong(),
                if (changed) "0".repeat(64) else hash, log.absolutePath, File(directory, "ready").absolutePath, relaunch)
            val powershell = File(System.getenv("SystemRoot"), "System32/WindowsPowerShell/v1.0/powershell.exe")
            val process = ProcessBuilder(powershell.absolutePath, "-NoProfile", "-NonInteractive", "-EncodedCommand",
                WindowsUpdateScript.encoded(prelude + "\n" + payload)).redirectErrorStream(true).start()
            assertTrue(process.waitFor(30, TimeUnit.SECONDS), "PowerShell helper did not finish")
            val output = process.inputStream.bufferedReader().readText()
            assertEquals(if (changed || result !in setOf(0, 3010, 1641, 1602)) 1 else 0, process.exitValue(), output)
            return (if (trace.exists()) trace.readText(Charsets.UTF_8) else "") to log.readText(Charsets.UTF_8)
        } finally { directory.deleteRecursively() }
    }

    @Test fun windowsExecutesUnicodePathsLiterally() {
        val (trace, log) = exercise(0)
        assertTrue(trace.contains("中文 O'Brien & %TEMP% \$(literal)"), trace)
        assertTrue(trace.contains("/i \""), trace)
        assertEquals(2, trace.lineSequence().count { it.contains("PATH=") })
        assertTrue(log.contains("Installation succeeded"))
    }

    @Test fun windowsRebootSuccessDoesNotReinstallOrRelaunch() {
        for (code in listOf(3010, 1641)) {
            val (trace, log) = exercise(code)
            assertEquals(1, trace.lineSequence().count { it.contains("PATH=") }, trace)
            assertTrue(log.contains("restart required"), log)
            assertFalse(log.contains("failed"), log)
        }
    }

    @Test fun windowsCancellationDoesNotReopenInstaller() {
        val (trace, log) = exercise(1602)
        assertEquals(2, trace.lineSequence().count { it.contains("PATH=") }, trace)
        assertEquals(1, trace.lineSequence().count { it.contains("msiexec.exe") }, trace)
        assertTrue(log.contains("cancelled by user"))
    }

    @Test fun windowsQuitUpdateFailureDoesNotOpenAnyWindow() {
        val (trace, log) = exercise(1603, relaunch = false)
        assertEquals(1, trace.lineSequence().count { it.contains("PATH=") })
        assertTrue(log.contains("Installation failed (1603)"))
    }

    @Test fun windowsChangedInstallerNeverExecutes() {
        val (trace, log) = exercise(0, changed = true)
        assertEquals("", trace)
        assertTrue(log.contains("Installer changed before installation"))
    }
}
