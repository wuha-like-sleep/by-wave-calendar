package cn.bywave.calendar.update

import android.content.Context
import cn.bywave.calendar.R
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.AtomicMoveNotSupportedException

sealed class DownloadProgress {
    data class Downloading(val bytesRead: Long, val totalBytes: Long) : DownloadProgress() {
        val fraction: Float get() = if (totalBytes > 0) bytesRead.toFloat() / totalBytes else 0f
    }
    data class Done(val file: File) : DownloadProgress()
    data class Failed(val message: String) : DownloadProgress()
}

object ApkDownloader {
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS).callTimeout(20, TimeUnit.MINUTES)
            .followSslRedirects(false).build()
    }

    fun cachedFileFor(context: Context, release: AndroidReleaseDto): File {
        val dir = File(context.cacheDir, "updates").also { it.mkdirs() }
        val digest = release.sha256.lowercase().filter { it in "0123456789abcdef" }.take(16)
        return File(dir, "bywave-${release.versionCode}-$digest.apk")
    }

    suspend fun verifiedCachedFile(context: Context, release: AndroidReleaseDto): File? = withContext(Dispatchers.IO) {
        if (!validReleaseDownload(release)) return@withContext null
        val file = cachedFileFor(context, release)
        if (!file.isFile || file.length() != release.sizeBytes) return@withContext null
        try { file.takeIf { sha256(it).equals(release.sha256, ignoreCase = true) } }
        catch (e: CancellationException) { throw e }
        catch (_: java.io.IOException) { null }
    }

    fun download(context: Context, release: AndroidReleaseDto): Flow<DownloadProgress> = flow {
        if (!validReleaseDownload(release)) {
            emit(DownloadProgress.Failed(context.getString(R.string.update_err_checksum)))
            return@flow
        }
        verifiedCachedFile(context, release)?.let {
            emit(DownloadProgress.Done(it)); return@flow
        }
        val target = cachedFileFor(context, release)
        val partial = try { File.createTempFile("bywave-", ".part", target.parentFile) }
        catch (_: java.io.IOException) {
            emit(DownloadProgress.Failed(context.getString(R.string.update_err_download)))
            return@flow
        }
        val call = client.newCall(Request.Builder().url(release.url).build())
        // A separate child observes cancellation even while byteStream.read is
        // blocked; closing the socket promptly releases that blocking read.
        val cancellation = CoroutineScope(currentCoroutineContext()).launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { call.cancel() }
        }
        try {
            call.execute().use { response ->
                check(response.isSuccessful)
                val body = checkNotNull(response.body)
                val declared = body.contentLength()
                check(declared < 0 || declared == release.sizeBytes)
                var read = 0L
                var emittedAt = 0L
                val digest = MessageDigest.getInstance("SHA-256")
                body.byteStream().use { source -> partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = source.read(buffer)
                        if (count < 0) break
                        check(read + count <= release.sizeBytes)
                        output.write(buffer, 0, count); digest.update(buffer, 0, count); read += count
                        val now = System.currentTimeMillis()
                        if (now - emittedAt >= 100) {
                            emit(DownloadProgress.Downloading(read, release.sizeBytes)); emittedAt = now
                        }
                    }
                } }
                check(read == release.sizeBytes)
                check(digest.digest().joinToString("") { "%02x".format(it) }.equals(release.sha256, true))
                currentCoroutineContext().ensureActive()
                try { Files.move(partial.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING) }
                catch (_: AtomicMoveNotSupportedException) { Files.move(partial.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING) }
                emit(DownloadProgress.Done(target))
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) {
            currentCoroutineContext().ensureActive()
            emit(DownloadProgress.Failed(context.getString(R.string.update_err_download)))
        } finally { cancellation.cancel(); call.cancel(); partial.delete() }
    }.flowOn(Dispatchers.IO)

    private suspend fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
