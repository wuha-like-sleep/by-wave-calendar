package cn.bywave.calendar.update

import java.net.URI

/** A URL the downloader may fetch an APK from: https, a real host,
 *  no embedded credentials, no fragment. One definition for the
 *  primary and the fallback — two hand-rolled copies would drift,
 *  and the drift would look like «the fallback never works». */
internal fun isUsableDownloadUrl(raw: String): Boolean = runCatching {
    val url = URI(raw)
    url.scheme.equals("https", true) && !url.host.isNullOrBlank() && url.userInfo == null && url.fragment == null
}.getOrDefault(false)

internal fun validReleaseDownload(release: AndroidReleaseDto): Boolean =
    isUsableDownloadUrl(release.url) &&
        release.versionCode > 0 && release.versionName.isNotBlank() &&
        release.minSupportedVersionCode in 1..release.versionCode && release.sizeBytes in 1..(512L * 1024 * 1024) &&
        Regex("[a-fA-F0-9]{64}").matches(release.sha256)
