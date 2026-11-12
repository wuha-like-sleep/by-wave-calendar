package cn.bywave.calendar.desktop.data.update

import kotlin.test.Test
import kotlin.test.assertEquals
import java.io.File

class UpdateInstallerTest {
    @Test fun pathsRemainLiteralShellArguments() {
        if (!File("/bin/sh").exists()) return
        val path = "/tmp/user's $(echo injected); `echo injected` \"folder\"/Calendar.app"
        val process = ProcessBuilder("/bin/sh", "-c", "printf '%s' " + UpdateInstaller.shellLiteral(path)).start()
        assertEquals(path, process.inputStream.bufferedReader().readText())
        assertEquals(0, process.waitFor())
    }
    @Test fun generatedInstallerHasValidShellSyntax() {
        if (!File("/bin/bash").exists()) return
        val file = UpdateInstaller.writeSwapScript("/tmp/mount's", "/tmp/new app", "/tmp/old app", true)
        try {
            val process = ProcessBuilder("/bin/bash", "-n", file.absolutePath).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().readText()
            assertEquals(0, process.waitFor(), output)
        } finally { file.delete() }
    }
}
