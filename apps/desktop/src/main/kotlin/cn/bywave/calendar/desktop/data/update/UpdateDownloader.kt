// Streams verified desktop installers to Downloads. Existing files are replaced
// only after HTTP, size and mandatory SHA-256 checks succeed.

package cn.bywave.calendar.desktop.data.update

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.isSuccess
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.awt.Desktop
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.AtomicMoveNotSupportedException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.net.URI
import java.security.MessageDigest
import cn.bywave.calendar.desktop.util.userFacingError

sealed class DownloadState {
    object Idle : DownloadState()
    data class Running(val bytesDone: Long, val bytesTotal: Long) : DownloadState() {
        /** 0.0..1.0; 0 when total unknown. */
        val fraction: Float get() = if (bytesTotal > 0) (bytesDone.toFloat() / bytesTotal) else 0f
    }
    data class Done(val file: File) : DownloadState()
    data class Failed(val message: String) : DownloadState()
}

object UpdateDownloader {
    private val downloadLock = Mutex()
    private const val MAX_INSTALLER_BYTES = 1024L * 1024 * 1024
    private val _state = MutableStateFlow<DownloadState>(DownloadState.Idle)
    val state: StateFlow<DownloadState> = _state.asStateFlow()

    private val client: HttpClient by lazy {
        HttpClient(CIO) {
            install(HttpTimeout) {
                // DMGs are 100MB+ and slow GitHub Releases CDN paths can
                // drag — generous request timeout, no connect cap beyond
                // CIO default.
                requestTimeoutMillis = 30L * 60 * 1000   // 30 minutes
            }
            expectSuccess = false
        }
    }

    /** Download or reuse a verified installer. Disk I/O and checksums run off
     * the UI thread; the caller owns installation after [DownloadState.Done]. */
    suspend fun download(url: String, expectedSha256: String? = null, expectedSizeBytes: Long = 0) = withContext(Dispatchers.IO) { downloadLock.withLock {
        var partial: File? = null
        try {
            if (expectedSha256 == null || !expectedSha256.matches(Regex("[a-fA-F0-9]{64}"))) {
                _state.value = DownloadState.Failed(cn.bywave.calendar.desktop.i18n.I18n.t("update.download.checksumFailed"))
                return@withLock
            }
            require(expectedSizeBytes in 0..MAX_INSTALLER_BYTES) { "Invalid installer size" }
            val filename = installerFilename(url)
            val downloads = File(System.getProperty("user.home"), "Downloads")
            Files.createDirectories(downloads.toPath())
            val target = File(downloads, filename)
            require(!Files.isSymbolicLink(target.toPath())) { "Installer destination must not be a link" }
            if (target.isFile && target.length() > 0 &&
                (expectedSizeBytes == 0L || target.length() == expectedSizeBytes) &&
                sha256(target).equals(expectedSha256, ignoreCase = true)) {
                _state.value = DownloadState.Done(target)
                return@withLock
            }
            _state.value = DownloadState.Running(0, 0)
            client.prepareGet(url).execute { resp ->
                check(resp.status.isSuccess()) { "Installer request failed (${resp.status.value})" }
                val total = resp.headers["Content-Length"]?.toLongOrNull() ?: 0L
                require(total in 0..MAX_INSTALLER_BYTES) { "Invalid download length" }
                if (expectedSizeBytes > 0 && total > 0) check(total == expectedSizeBytes) { "Installer length mismatch" }
                val channel: ByteReadChannel = resp.bodyAsChannel()
                val temporary = Files.createTempFile(downloads.toPath(), ".bywave-update-", ".partial").toFile()
                partial = temporary
                var done = 0L
                FileOutputStream(temporary).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (!channel.isClosedForRead) {
                        val n = channel.readAvailable(buf, 0, buf.size)
                        if (n < 0) break
                        if (n == 0) continue
                        done += n
                        check(done <= MAX_INSTALLER_BYTES && (expectedSizeBytes == 0L || done <= expectedSizeBytes)) {
                            "Installer exceeded expected length"
                        }
                        out.write(buf, 0, n)
                        _state.value = DownloadState.Running(done, if (expectedSizeBytes > 0) expectedSizeBytes else total)
                    }
                }
                if (done == 0L || (expectedSizeBytes > 0 && done != expectedSizeBytes) ||
                    !sha256(temporary).equals(expectedSha256, ignoreCase = true)) {
                    _state.value = DownloadState.Failed(cn.bywave.calendar.desktop.i18n.I18n.t("update.download.checksumFailed"))
                    return@execute
                }
                // Keep the previous installer until its replacement is fully verified.
                try {
                    Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
                _state.value = DownloadState.Done(target)
            }
        } catch (e: CancellationException) {
            _state.value = DownloadState.Idle
            throw e
        } catch (e: Exception) {
            _state.value = DownloadState.Failed(userFacingError(e, "update.download.failed"))
        } finally {
            partial?.delete()
        }
    } }

    internal fun installerFilename(url: String): String {
        val uri = URI(url)
        require(uri.scheme in setOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo == null)
        val filename = uri.path.substringAfterLast('/')
        require(filename.isNotBlank() && filename.length <= 240 && filename !in setOf(".", ".."))
        require(filename.none { it.code < 32 || it in "\\/:*?\"<>|" }) { "Unsafe installer filename" }
        require(listOf(".dmg", ".msi", ".deb").any { filename.endsWith(it, ignoreCase = true) })
        return filename
    }

    /** Back-compat shim for any call site still on the v0.7.3-v0.7.6
     *  "download + open the DMG in Finder" model. New code should call
     *  [download] + [UpdateInstaller.install] explicitly. */
    @Deprecated("Use download() + UpdateInstaller.install() for in-place updates.")
    suspend fun downloadAndOpen(url: String, expectedSha256: String? = null) {
        download(url, expectedSha256)
        val s = state.value
        if (s is DownloadState.Done) openInFinder(s.file)
    }

    fun reset() {
        _state.value = DownloadState.Idle
    }

    /** Hand the file to Finder. On macOS this mounts the DMG and
     *  shows the standard drag-to-Applications window. On Win/Linux
     *  it opens the file with the default handler. */
    private fun openInFinder(file: File) {
        runCatching {
            if (Desktop.isDesktopSupported()) {
                Desktop.getDesktop().open(file)
                return
            }
        }
        // Fallback to Desktop.browse for an inert hint.
        runCatching {
            if (Desktop.isDesktopSupported()) Desktop.getDesktop().browse(URI(file.toURI().toString()))
        }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { ins ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
