// Downloads the APK from the release URL into <cache>/updates/, streams
// progress via a Flow, and verifies sha256 before signaling done. We use
// OkHttp directly (not Android's DownloadManager) because:
//   - DownloadManager writes to public Downloads/ which means
//     READ_EXTERNAL_STORAGE noise on older devices and an extra
//     "where do I save it" surface,
//   - it's awkward to give DownloadManager-saved files to FileProvider
//     (the file is owned by the system downloader, not us),
//   - keeping it in cacheDir means Android can reclaim space if low,
//     which is the right policy for a one-time-use APK.
//
// Failure modes (sha mismatch, IO error, cancel) all surface as
// DownloadProgress.Failed with a Chinese-localized message — the sheet
// just shows it to the user.

package cn.bywave.calendar.update

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

sealed class DownloadProgress {
    data class Downloading(val bytesRead: Long, val totalBytes: Long) : DownloadProgress() {
        val fraction: Float get() = if (totalBytes > 0) bytesRead.toFloat() / totalBytes else 0f
    }
    data class Done(val file: File) : DownloadProgress()
    data class Failed(val message: String) : DownloadProgress()
}

object ApkDownloader {
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            // No read timeout — big APK on slow networks shouldn't trip a timer.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    /** Returns the file we'd download into (or have already downloaded into)
     *  for a given release. Lets the sheet check if a prior successful
     *  download is still cached and skip the network round trip. */
    fun cachedFileFor(context: Context, release: AndroidReleaseDto): File {
        val dir = File(context.cacheDir, "updates").also { it.mkdirs() }
        // Filename includes versionCode so we can't confuse two different
        // releases that happened to ship the same versionName by accident.
        val safeName = "bywave-${release.versionCode}-${release.versionName.replace("[^\\w.\\-]".toRegex(), "_")}.apk"
        return File(dir, safeName)
    }

    /** Returns the cached APK iff its sha matches the release manifest.
     *  If sha matches we can skip re-downloading entirely. */
    fun verifiedCachedFile(context: Context, release: AndroidReleaseDto): File? {
        val f = cachedFileFor(context, release)
        if (!f.exists() || f.length() <= 0) return null
        if (release.sha256.isBlank()) return null  // can't trust without a checksum
        return if (sha256(f).equals(release.sha256, ignoreCase = true)) f else null
    }

    fun download(context: Context, release: AndroidReleaseDto): Flow<DownloadProgress> = flow {
        // Quick win — already in cache and checksums match? Skip the network.
        verifiedCachedFile(context, release)?.let {
            emit(DownloadProgress.Downloading(it.length(), it.length()))
            emit(DownloadProgress.Done(it))
            return@flow
        }

        val target = cachedFileFor(context, release)
        // Clean up any stale partial from a previous failed attempt.
        if (target.exists()) target.delete()
        // Clean other release files in the dir — keep just one APK
        // around at a time.
        target.parentFile?.listFiles()?.forEach { if (it != target) it.delete() }

        val req = Request.Builder().url(release.url).build()
        val call = client.newCall(req)
        try {
            call.execute().use { resp ->
                if (!resp.isSuccessful) {
                    emit(DownloadProgress.Failed("下载失败（HTTP ${resp.code}）"))
                    return@flow
                }
                val body = resp.body ?: run {
                    emit(DownloadProgress.Failed("下载失败（空响应）"))
                    return@flow
                }
                val total = body.contentLength().let { if (it > 0) it else release.sizeBytes }
                val source = body.byteStream()
                target.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var totalRead = 0L
                    var emittedAt = 0L
                    while (true) {
                        // Cooperative cancellation — if the user hit "取消",
                        // ensureActive() throws CancellationException which
                        // the outer catch handles (closes the OkHttp call +
                        // deletes the partial APK).
                        kotlinx.coroutines.currentCoroutineContext().ensureActive()
                        val n = source.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        totalRead += n
                        // Throttle progress emissions to ~10/s — Flow
                        // collectors don't need a notification per chunk.
                        val now = System.currentTimeMillis()
                        if (now - emittedAt >= 100) {
                            emit(DownloadProgress.Downloading(totalRead, total))
                            emittedAt = now
                        }
                    }
                    emit(DownloadProgress.Downloading(totalRead, total))
                }
            }

            // Verify sha256 if the manifest provided one. Reject the file
            // if it doesn't match — an MITM attacker could otherwise
            // serve a swapped APK over plain HTTP. (TLS catches this for
            // most users; the sha is defense in depth.)
            if (release.sha256.isNotBlank()) {
                val actual = sha256(target)
                if (!actual.equals(release.sha256, ignoreCase = true)) {
                    target.delete()
                    emit(DownloadProgress.Failed("校验失败：下载的安装包内容与服务器不匹配。请稍后再试"))
                    return@flow
                }
            }
            emit(DownloadProgress.Done(target))
        } catch (e: kotlinx.coroutines.CancellationException) {
            // User cancelled — close the OkHttp call so the socket doesn't
            // sit in TIME_WAIT, wipe the partial file, and rethrow so the
            // surrounding coroutine machinery sees the cancel.
            call.cancel()
            target.delete()
            throw e
        } catch (e: Exception) {
            target.delete()
            emit(DownloadProgress.Failed(e.localizedMessage ?: "下载失败"))
        }
    }.flowOn(Dispatchers.IO)

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
