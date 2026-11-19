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
        // Deterministic partial next to the target. It used to be a
        // random temp file deleted on ANY exit, so a dropped connection
        // at 90% meant starting the whole download from zero next time —
        // on exactly the networks «download from your own server» exists
        // for. Now the partial survives failure and cancellation, and
        // the next attempt resumes it with a Range request. The name
        // derives from the target (versionCode + sha prefix), so bytes
        // from a different release can never be resumed into this one;
        // the final sha256 check still has the last word.
        val partial = File(target.parentFile ?: context.cacheDir, target.name + ".part")
        // Primary first, then the fallback source for the same APK,
        // then the mirror (third level, e.g. Gitee) — tried only when
        // both earlier sources failed. A source that isn't a usable
        // https URL is dropped here — a broken extra source must never
        // break the primary path. Duplicates are dropped too: retrying
        // the exact URL that just failed only burns the user's time.
        val urls = buildList {
            add(release.url)
            if (release.fallbackUrl.isNotBlank() && release.fallbackUrl != release.url &&
                isUsableDownloadUrl(release.fallbackUrl)
            ) add(release.fallbackUrl)
            if (release.mirrorUrl.isNotBlank() && release.mirrorUrl != release.url &&
                release.mirrorUrl != release.fallbackUrl &&
                isUsableDownloadUrl(release.mirrorUrl)
            ) add(release.mirrorUrl)
        }
        for (url in urls) {
            try {
                downloadFrom(release, url, partial, target) { p -> emit(p) }
                return@flow
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                currentCoroutineContext().ensureActive()
                // Fall through to the next source. A sane partial
                // carries over — both sources serve the same bytes,
                // and sha256 arbitrates at the end.
            }
        }
        emit(DownloadProgress.Failed(context.getString(R.string.update_err_download)))
    }.flowOn(Dispatchers.IO)

    /** One download attempt against [url]: emits Downloading progress
     *  and a terminal Done, throws on any failure (the caller decides
     *  whether another source remains). Resumes [partial] when it
     *  holds a strict prefix of the expected APK. */
    private suspend fun downloadFrom(
        release: AndroidReleaseDto,
        url: String,
        partial: File,
        target: File,
        emit: suspend (DownloadProgress) -> Unit,
    ) {
        var resumeFrom = if (partial.isFile) partial.length() else 0L
        if (resumeFrom >= release.sizeBytes) {
            // Not a usable prefix. One case is still salvageable: the
            // previous attempt downloaded everything but died before
            // the move — verify and finish instead of re-downloading.
            if (resumeFrom == release.sizeBytes &&
                sha256(partial).equals(release.sha256, ignoreCase = true)
            ) {
                moveIntoPlace(partial, target)
                emit(DownloadProgress.Done(target))
                return
            }
            partial.delete()
            resumeFrom = 0L
        }
        val request = Request.Builder().url(url).apply {
            if (resumeFrom > 0) header("Range", "bytes=$resumeFrom-")
        }.build()
        val call = client.newCall(request)
        // A separate child observes cancellation even while byteStream.read is
        // blocked; closing the socket promptly releases that blocking read.
        val cancellation = CoroutineScope(currentCoroutineContext()).launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { call.cancel() }
        }
        try {
            call.execute().use { response ->
                check(response.isSuccessful)
                val body = checkNotNull(response.body)
                // 206 = the server honored our Range. Anything else
                // (a 200 from a server that ignores Range) means the
                // body starts at byte 0 and the partial must restart.
                val offset = if (resumeFrom > 0 && response.code == 206) resumeFrom else 0L
                if (offset > 0) {
                    val range = response.header("Content-Range").orEmpty()
                    check(range.startsWith("bytes $offset-")) { "Unexpected Content-Range: $range" }
                }
                val declared = body.contentLength()
                check(declared < 0 || declared == release.sizeBytes - offset)
                val digest = MessageDigest.getInstance("SHA-256")
                if (offset > 0) {
                    // The digest covers the whole file, so feed it the
                    // resumed prefix before appending the rest.
                    partial.inputStream().use { input ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            digest.update(buffer, 0, count)
                        }
                    }
                }
                var read = offset
                var emittedAt = 0L
                body.byteStream().use { source ->
                    java.io.FileOutputStream(partial, offset > 0).use { output ->
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
                    }
                }
                check(read == release.sizeBytes)
                if (!digest.digest().joinToString("") { "%02x".format(it) }.equals(release.sha256, true)) {
                    // The bytes are wrong, not merely incomplete —
                    // keeping them would poison every later resume.
                    partial.delete()
                    throw java.io.IOException("sha256 mismatch")
                }
                currentCoroutineContext().ensureActive()
                moveIntoPlace(partial, target)
                emit(DownloadProgress.Done(target))
            }
        } finally { cancellation.cancel(); call.cancel() }
    }

    private fun moveIntoPlace(partial: File, target: File) {
        try { Files.move(partial.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING) }
        catch (_: AtomicMoveNotSupportedException) { Files.move(partial.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING) }
    }

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
