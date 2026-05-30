// In-app DMG downloader for the desktop updater. Streams the file from
// the server's manifest URL straight to ~/Downloads/ and reports bytes
// progress on a flow. v0.7.7 moved the "open the DMG" side-effect out
// of here — the caller (UpdateDialog) now hands the downloaded file to
// UpdateInstaller.install() which does the in-place swap-and-relaunch.
//
// Path strategy: save into ~/Downloads/ (where users expect downloads
// to land) with the manifest's filename. If the file already exists +
// matches the manifest's sha256, we skip the download and just open it.

package cn.bywave.calendar.desktop.data.update

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.awt.Desktop
import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.security.MessageDigest

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

    /** Download `url` to ~/Downloads/<filename>. If a file with the
     *  same name + sha256 already exists we skip the network. On
     *  completion [state] transitions to Done(file) and the caller
     *  (UpdateDialog → UpdateInstaller.install) takes over to do the
     *  in-place swap-and-relaunch.
     *
     *  v0.7.7: removed the implicit `openInFinder` call at the end. The
     *  install path is now decoupled from the download path so the
     *  dialog can show "正在安装并重启…" between the two stages. */
    suspend fun download(url: String, expectedSha256: String? = null) {
        try {
            val filename = url.substringAfterLast('/').ifEmpty { "ByWaveCalendar.dmg" }
            val downloads = File(System.getProperty("user.home"), "Downloads")
            if (!downloads.exists()) downloads.mkdirs()
            val target = File(downloads, filename)

            // Skip path: filename + sha matches → reuse on-disk file.
            if (target.exists() && expectedSha256 != null && sha256(target).equals(expectedSha256, ignoreCase = true)) {
                _state.value = DownloadState.Done(target)
                return
            }

            _state.value = DownloadState.Running(0, 0)

            client.prepareGet(url).execute { resp ->
                val total = resp.headers["Content-Length"]?.toLongOrNull() ?: 0L
                val channel: ByteReadChannel = resp.bodyAsChannel()
                // Write to a .partial file so a half-finished download
                // doesn't leave a corrupt-but-correctly-named DMG that
                // would short-circuit the sha check next time.
                val partial = File(downloads, "$filename.partial")
                FileOutputStream(partial).use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (!channel.isClosedForRead) {
                        val n = channel.readAvailable(buf, 0, buf.size)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        done += n
                        _state.value = DownloadState.Running(done, total)
                    }
                }
                // Validate sha256 if provided. Mismatch → bail without
                // moving partial → target so the user can retry.
                if (expectedSha256 != null) {
                    val got = sha256(partial)
                    if (!got.equals(expectedSha256, ignoreCase = true)) {
                        partial.delete()
                        _state.value = DownloadState.Failed(
                            cn.bywave.calendar.desktop.i18n.I18n.t("update.download.checksumFailed"),
                        )
                        return@execute
                    }
                }
                // Atomic-ish rename: target may exist from a prior attempt.
                if (target.exists()) target.delete()
                if (!partial.renameTo(target)) {
                    _state.value = DownloadState.Failed(
                        cn.bywave.calendar.desktop.i18n.I18n.t(
                            "update.download.saveFailed",
                            mapOf("path" to target.absolutePath),
                        ),
                    )
                    return@execute
                }
                _state.value = DownloadState.Done(target)
            }
        } catch (e: Exception) {
            _state.value = DownloadState.Failed(e.localizedMessage ?: cn.bywave.calendar.desktop.i18n.I18n.t("update.download.failed"))
        }
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
