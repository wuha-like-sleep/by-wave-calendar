package cn.bywave.calendar.desktop.data.update

import cn.bywave.calendar.desktop.testutil.FakeServer
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

class UpdateDownloaderTest {
    private fun hash(body: String) = MessageDigest.getInstance("SHA-256").digest(body.toByteArray())
        .joinToString("") { "%02x".format(it) }

    private fun target(name: String): File {
        val home = System.getProperty("user.home")
        check(home.contains("test-home"))
        return File(home, "Downloads/$name")
    }

    @Test fun urlQueriesAreNotPartOfInstallerNames() {
        assertEquals("日历 1.msi", UpdateDownloader.installerFilename("https://example.test/%E6%97%A5%E5%8E%86%201.msi?token=abc"))
        for (url in listOf("https://example.test/a%5C..%5Cb.msi", "https://example.test/a%00.msi",
            "https://example.test/download.exe", "file:///tmp/app.msi", "https://u:p@example.test/app.msi")) {
            assertFailsWith<IllegalArgumentException> { UpdateDownloader.installerFilename(url) }
        }
    }

    @Test fun missingChecksumStopsBeforeNetworkAccess() = runBlocking {
        FakeServer().use { server ->
            UpdateDownloader.download(server.url + "/no-hash.msi")
            assertIs<DownloadState.Failed>(UpdateDownloader.state.value)
            assertTrue(server.hits.isEmpty())
        }
    }

    @Test fun errorPageIsNeverAcceptedEvenWhenHashMatches() = runBlocking {
        FakeServer().use { server ->
            server.handler = { FakeServer.Reply(404, "not found") }
            val destination = target("http-error.msi").apply { parentFile.mkdirs(); writeText("previous installer") }
            try {
                UpdateDownloader.download(server.url + "/http-error.msi", hash("not found"))
                assertIs<DownloadState.Failed>(UpdateDownloader.state.value)
                assertEquals("previous installer", destination.readText())
            } finally { destination.delete() }
        }
    }

    @Test fun checksumFailurePreservesExistingFileAndRemovesPartialDownload() = runBlocking {
        FakeServer().use { server ->
            server.handler = { FakeServer.Reply(200, "bad installer") }
            val destination = target("bad-hash.msi").apply { parentFile.mkdirs(); writeText("previous installer") }
            try {
                UpdateDownloader.download(server.url + "/bad-hash.msi", hash("expected installer"))
                assertIs<DownloadState.Failed>(UpdateDownloader.state.value)
                assertEquals("previous installer", destination.readText())
                assertFalse(destination.parentFile.listFiles().orEmpty().any { it.name.endsWith(".partial") })
            } finally { destination.delete() }
        }
    }

    @Test fun verifiedDownloadUsesDecodedFilenameAndReusesValidFile() = runBlocking {
        FakeServer().use { server ->
            val body = "verified installer"
            server.handler = { FakeServer.Reply(200, body) }
            val destination = target("日历 good.msi")
            try {
                val url = server.url + "/%E6%97%A5%E5%8E%86%20good.msi?download=1"
                UpdateDownloader.download(url, hash(body), body.toByteArray().size.toLong())
                assertIs<DownloadState.Done>(UpdateDownloader.state.value)
                assertEquals(body, destination.readText())
                UpdateDownloader.download(url, hash(body), body.toByteArray().size.toLong())
                assertEquals(1, server.hits.size)
            } finally { destination.delete() }
        }
    }

    @Test fun wrongDeclaredSizeDoesNotCreateInstaller() = runBlocking {
        FakeServer().use { server ->
            server.handler = { FakeServer.Reply(200, "installer") }
            UpdateDownloader.download(server.url + "/wrong-size.msi", hash("installer"), 100)
            assertIs<DownloadState.Failed>(UpdateDownloader.state.value)
            assertFalse(target("wrong-size.msi").exists())
        }
    }
}
